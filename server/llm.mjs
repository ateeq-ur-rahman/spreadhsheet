// The only place that knows which LLM vendor we use: xAI's Grok, through its
// OpenAI-style Chat Completions endpoint, called with plain fetch.
//
//   POST {XAI_BASE_URL}/chat/completions
//   Authorization: Bearer {XAI_API_KEY}
//   { model, messages: [{role, content}], stream: false, temperature: 0 }
//   -> choices[0].message.content
//
// Errors come back as { status, reason, message } so the browser can show
// a useful line: auth (401/403), rate_limit (429), timeout, network, upstream.

export const DEFAULT_MODEL = 'grok-4.7'
export const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

export class LlmError extends Error {
    constructor(status, reason, message) {
        super(message)
        this.status = status
        this.reason = reason
    }
}

export async function complete({ system, user, history = [] }, { apiKey, model, baseUrl, fetchImpl = fetch, timeoutMs = 60000 }) {
    if (!apiKey) throw new LlmError(500, 'no_key', 'XAI_API_KEY is not set. Put it in .env.local next to package.json and restart `npm run server`.')
    const messages = [
        { role: 'system', content: system },
        ...history.map(t => ({ role: t.role, content: t.content })),
        { role: 'user', content: user },
    ]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, stream: false, temperature: 0 }),
            signal: controller.signal,
        })
    } catch (e) {
        if (e.name === 'AbortError') throw new LlmError(504, 'timeout', `The model didn't answer within ${timeoutMs / 1000} s.`)
        throw new LlmError(502, 'network', `Couldn't reach ${baseUrl}: ${e.message}`)
    } finally {
        clearTimeout(timer)
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '')
        const short = body.slice(0, 300)
        if (res.status === 401 || res.status === 403) throw new LlmError(401, 'auth', `The provider rejected the API key (HTTP ${res.status}). Check XAI_API_KEY in .env.local. ${short}`)
        if (res.status === 429) {
            const retry = res.headers.get('retry-after')
            throw new LlmError(429, 'rate_limit', `Rate limited by the provider (HTTP 429)${retry ? `; try again in ${retry} s` : ''}. ${short}`)
        }
        throw new LlmError(502, 'upstream', `The provider returned HTTP ${res.status}. ${short}`)
    }
    const data = await res.json().catch(() => null)
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new LlmError(502, 'upstream', 'The provider answered without any message text.')
    return { text, model: data.model || model }
}
