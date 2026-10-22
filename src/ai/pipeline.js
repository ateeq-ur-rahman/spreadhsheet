// One request to the model, start to finish:
//   provider.complete -> extract the JSON -> check the action type ->
//   validate against its schema -> hand back a checked action.
// Nothing in here touches the sheet. Every failure comes back as a value
// ({ kind: 'error', error, detail }) so the panel can show it; nothing is
// swallowed.

import { extractJson } from './extractJson.js'
import { validate, describeErrors } from './validate.js'
import { QUERY_PLAN_SCHEMA, CLARIFY_SCHEMA, FORMAT_SHEET_SCHEMA } from './contract.js'
import { buildSystemPrompt } from './systemPrompt.js'

// The actions the panel accepts. Anything else (e.g. "mutation") is READ_ONLY.
export const DEFAULT_SCHEMAS = { query: QUERY_PLAN_SCHEMA, format_sheet: FORMAT_SHEET_SCHEMA, clarify: CLARIFY_SCHEMA }

// Result shapes:
//   { kind: 'query', action, raw }
//   { kind: 'format_sheet', action, raw }
//   { kind: 'clarify', question, action, raw }
//   { kind: 'error', error: 'PROVIDER_ERROR' | 'INVALID_RESPONSE' | 'READ_ONLY', detail, raw? }
export async function requestAction({ provider, prompt, context, history = [], schemas = DEFAULT_SCHEMAS }) {
    let response
    try {
        response = await provider.complete({ system: buildSystemPrompt(context, { schemas }), user: prompt, history })
    } catch (e) {
        return { kind: 'error', error: 'PROVIDER_ERROR', detail: e.message || String(e), reason: e.reason || 'unknown' }
    }
    return parseAction(response.text, schemas)
}

// The text -> checked action part, on its own so it can be tested and reused.
export function parseAction(text, schemas = DEFAULT_SCHEMAS) {
    const parsed = extractJson(text)
    if (!parsed.ok) return { kind: 'error', error: 'INVALID_RESPONSE', detail: parsed.error, raw: text }
    const action = parsed.value

    // Read-only check comes before schema validation (AI_CONTRACT 2.2):
    // anything that isn't one of the allowed action types is refused.
    if (!(action.type in schemas)) {
        return { kind: 'error', error: 'READ_ONLY', detail: `READ_ONLY:${action.type ?? 'no type'}`, action, raw: text }
    }
    const errors = validate(schemas[action.type], action)
    if (errors.length) {
        return { kind: 'error', error: 'INVALID_RESPONSE', detail: describeErrors(errors), action, raw: text }
    }
    if (action.type === 'clarify') return { kind: 'clarify', question: action.question, action, raw: text }
    return { kind: action.type, action, raw: text }
}
