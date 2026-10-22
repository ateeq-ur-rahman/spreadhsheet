// Tiny backend for the "http" AI provider. Its only job is to keep the API
// key on the server: the browser posts { system, user, history } to
// /api/ai/complete, we add the key and call the model, and send back the
// raw text. Parsing, validation and every number still happen in the app.
//
//   npm run server        (reads .env.local / .env from the project root)
//
//   XAI_API_KEY      required for real calls; never sent to the browser
//   XAI_MODEL        default grok-4.7
//   XAI_BASE_URL     default https://api.x.ai/v1
//   AI_SERVER_PORT   default 8787 (vite dev / preview proxy /api here)
//
// No dependencies: Node's http module and fetch.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { complete, LlmError, DEFAULT_MODEL, DEFAULT_BASE_URL } from './llm.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY = 1_000_000

// KEY=value lines; real environment variables win over the files
export function loadEnv(files = ['.env.local', '.env']) {
    const env = {}
    for (const name of files) {
        const file = path.join(ROOT, name)
        if (!fs.existsSync(file)) continue
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
            if (!m || line.trim().startsWith('#')) continue
            if (!(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
        }
    }
    return { ...env, ...process.env }
}

function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
            size += c.length
            if (size > MAX_BODY) { reject(new LlmError(413, 'too_large', 'Request body too large')); req.destroy() }
            else chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

export function createAiServer(env = loadEnv(), { fetchImpl = fetch } = {}) {
    const config = {
        apiKey: env.XAI_API_KEY || '',
        model: env.XAI_MODEL || DEFAULT_MODEL,
        baseUrl: (env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
        fetchImpl,
    }
    return http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/api/ai/health') {
                return send(res, 200, { ok: true, model: config.model, hasKey: Boolean(config.apiKey) })
            }
            if (req.method !== 'POST' || req.url !== '/api/ai/complete') {
                return send(res, 404, { reason: 'not_found', message: 'POST /api/ai/complete or GET /api/ai/health' })
            }
            let body
            try {
                body = JSON.parse(await readBody(req))
            } catch (e) {
                if (e instanceof LlmError) throw e
                return send(res, 400, { reason: 'bad_request', message: 'Body must be JSON: { system, user, history }' })
            }
            if (typeof body.system !== 'string' || typeof body.user !== 'string') {
                return send(res, 400, { reason: 'bad_request', message: 'Body needs string "system" and "user" fields' })
            }
            const out = await complete(body, config)
            send(res, 200, { text: out.text, provider: 'http', model: out.model })
        } catch (e) {
            if (e instanceof LlmError) return send(res, e.status, { reason: e.reason, message: e.message })
            send(res, 500, { reason: 'server', message: e.message })
        }
    })
}

// started directly (npm run server), not imported by tests
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const env = loadEnv()
    const port = Number(env.AI_SERVER_PORT || 8787)
    createAiServer(env).listen(port, () => {
        console.log(`AI server on http://localhost:${port}  model=${env.XAI_MODEL || DEFAULT_MODEL}  key=${env.XAI_API_KEY ? 'set' : 'MISSING (set XAI_API_KEY in .env.local)'}`)
    })
}
