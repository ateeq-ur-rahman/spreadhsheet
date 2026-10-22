// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — posts to our own backend (server/, `npm run server`), which
//              holds the API key and calls the model. The browser never
//              sees a key, and nothing here knows which vendor that is.
//
//  Do not hard-code a vendor anywhere else: everything outside this file
//  must behave identically with either provider.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

// A failure the panel can show as-is. reason: network | auth | rate_limit |
// timeout | no_key | upstream | bad_response
export class ProviderError extends Error {
    constructor(reason, message) {
        super(message)
        this.reason = reason
    }
}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    // Where our backend listens. In dev and preview, Vite proxies /api to
    // `npm run server`, so the default relative URL just works.
    const endpoint = config.endpoint ?? (env.VITE_AI_ENDPOINT || '/api/ai/complete')
    const fetchImpl = config.fetch ?? ((...args) => fetch(...args))

    return {
        name: 'http',
        async complete(request) {
            let res
            try {
                res = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ system: request.system, user: request.user, history: request.history || [] }),
                })
            } catch (e) {
                throw new ProviderError('network', `Couldn't reach the AI server at ${endpoint} (${e.message}). Is \`npm run server\` running?`)
            }
            let body = null
            try {
                body = await res.json()
            } catch {
                // fall through with body = null
            }
            if (!res.ok) {
                const reason = body?.reason || (res.status === 401 ? 'auth' : res.status === 429 ? 'rate_limit' : 'upstream')
                const message = body?.message || `The AI server answered HTTP ${res.status}.`
                throw new ProviderError(reason, message)
            }
            if (!body || typeof body.text !== 'string') {
                throw new ProviderError('bad_response', 'The AI server answered without any text.')
            }
            return { text: body.text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
