// The instructions sent to the model with every request. It gets the
// allowed action schemas, the rules it must follow, and the sheet context.
//
// The context goes in the system message and the user turn is only the
// user's words. That keeps the deterministic mock (which looks prompts up
// by their exact text) working with the same code path as a live model.

import { QUERY_PLAN_SCHEMA, CLARIFY_SCHEMA } from './contract.js'

export function buildSystemPrompt(context, { schemas = { query: QUERY_PLAN_SCHEMA, clarify: CLARIFY_SCHEMA } } = {}) {
    const schemaText = Object.entries(schemas)
        .map(([type, schema]) => `### ${type}\n${JSON.stringify(schema)}`)
        .join('\n\n')
    return `You turn questions about a spreadsheet into a JSON action. You never answer with numbers or results yourself: the app computes every number from your plan.

Reply with exactly one JSON object and nothing else. It must match one of these JSON Schemas:

${schemaText}

Rules:
- Use column names exactly as they appear in "columns" below. Map everyday words to a column when they plainly mean it: "sales reps" or "reps" -> "Sales Rep", "sales", "revenue" or "amount" -> the money total column (e.g. "Total"), "orders" -> counting rows. Reply with a "clarify" action only when nothing in "columns" fits (e.g. "territory" when there is no such column) or two columns fit equally well. Never invent a column name.
- "query" is read-only. If the user asks to change, delete or add data, reply with "clarify" and explain you can only read.
- Filters all have to hold (AND). Dates compare as YYYY-MM-DD, e.g. {"column":"Date","op":"gte","value":"2024-02-01"}.
- "sort" names output columns: a groupBy column, an aggregate's "as" name, or a source column for row results.
- "limit" is at most 500.
- The totals row is excluded by default; set "excludeTotalsRow": false only if the user asks to include it.

The sheet (column types are guesses from the data; sampleRows are the first rows only):
${JSON.stringify(context)}`
}
