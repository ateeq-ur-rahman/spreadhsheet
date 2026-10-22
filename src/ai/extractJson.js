// Models wrap JSON in prose and code fences ("Here is the plan: ```json
// {...}``` Let me know..."). This finds the first complete {...} object in
// the text and parses it. Braces inside strings are skipped, so a value like
// "a } b" doesn't end the object early.

// Returns { ok: true, value } or { ok: false, error }.
export function extractJson(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, error: 'the model returned no text' }
    }
    let start = text.indexOf('{')
    let lastError = 'no JSON object found in the response'
    while (start !== -1) {
        const end = matchingBrace(text, start)
        if (end === -1) {
            lastError = 'the JSON object in the response is not closed'
            break
        }
        try {
            const value = JSON.parse(text.slice(start, end + 1))
            if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value }
        } catch (e) {
            lastError = 'invalid JSON: ' + e.message
        }
        // that {...} wasn't JSON (prose like "{x}"), try the next one
        start = text.indexOf('{', start + 1)
    }
    return { ok: false, error: lastError }
}

// Index of the } that closes the { at `start`, or -1.
function matchingBrace(text, start) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++ // skip the escaped character
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}
