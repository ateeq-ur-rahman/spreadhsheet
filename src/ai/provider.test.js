// The http provider end to end: browser-side provider -> our server ->
// a fake upstream that behaves like the vendor API. No real key, no
// network, no credits spent.
import { describe, it, expect, afterEach } from 'vitest'
import { createAiServer } from '../../server/index.mjs'
import { createHttpProvider, ProviderError } from './provider.js'
import { requestAction } from './pipeline.js'

let server

async function start(env, upstream) {
    const calls = []
    const fetchImpl = async (url, init) => {
        calls.push({ url, init })
        return upstream(url, init)
    }
    server = createAiServer(env, { fetchImpl })
    await new Promise((resolve) => server.listen(0, resolve))
    const endpoint = `http://localhost:${server.address().port}/api/ai/complete`
    return { provider: createHttpProvider({ endpoint }), calls }
}

afterEach(() => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())))

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const env = { XAI_API_KEY: 'test-key', XAI_MODEL: 'grok-test', XAI_BASE_URL: 'https://example.test/v1' }

describe('http provider through the server', () => {
    it('sends system, history and user as chat messages with the key added on the server', async () => {
        const { provider, calls } = await start(env, () => json(200, {
            model: 'grok-test', choices: [{ message: { content: 'Sure:\n```json\n{"type":"clarify","question":"Which year?"}\n```' } }],
        }))
        const out = await provider.complete({ system: 'SYS', user: 'How many orders?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] })
        expect(out).toEqual({ text: 'Sure:\n```json\n{"type":"clarify","question":"Which year?"}\n```', provider: 'http' })
        expect(calls[0].url).toBe('https://example.test/v1/chat/completions')
        expect(calls[0].init.headers.Authorization).toBe('Bearer test-key')
        const body = JSON.parse(calls[0].init.body)
        expect(body.model).toBe('grok-test')
        expect(body.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
        expect(body.messages.at(-1).content).toBe('How many orders?')
    })

    it('reports a rejected key as auth', async () => {
        const { provider } = await start(env, () => json(401, { error: 'invalid key' }))
        await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ reason: 'auth' })
    })

    it('reports rate limits with the retry hint', async () => {
        const { provider } = await start(env, () => json(429, { error: 'slow down' }, { 'retry-after': '20' }))
        const err = await provider.complete({ system: 's', user: 'u' }).catch(e => e)
        expect(err).toBeInstanceOf(ProviderError)
        expect(err.reason).toBe('rate_limit')
        expect(err.message).toMatch(/try again in 20 s/)
    })

    it('reports the vendor being unreachable as network', async () => {
        const { provider } = await start(env, () => { throw new TypeError('getaddrinfo ENOTFOUND example.test') })
        await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ reason: 'network' })
    })

    it('says so when no key is configured', async () => {
        const { provider } = await start({}, () => json(200, {}))
        await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ reason: 'no_key' })
    })

    it('says so when our own server is not running', async () => {
        const provider = createHttpProvider({ endpoint: 'http://localhost:1/api/ai/complete' })
        const err = await provider.complete({ system: 's', user: 'u' }).catch(e => e)
        expect(err.reason).toBe('network')
        expect(err.message).toMatch(/npm run server/)
    })

    it('surfaces provider errors through the pipeline instead of swallowing them', async () => {
        const { provider } = await start(env, () => json(429, {}))
        const r = await requestAction({ provider, prompt: 'x', context: {} })
        expect(r).toMatchObject({ kind: 'error', error: 'PROVIDER_ERROR', reason: 'rate_limit' })
    })
})
