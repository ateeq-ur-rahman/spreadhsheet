import { describe, it, expect } from 'vitest'
import { extractJson } from './extractJson.js'
import { validate } from './validate.js'
import { parseAction } from './pipeline.js'
import { executeQuery } from './executor.js'
import { inferColumnType, buildContext } from './context.js'
import { describePlan } from './describePlan.js'
import { QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA } from './contract.js'

describe('extractJson', () => {
    it('finds JSON in prose and code fences', () => {
        expect(extractJson('{"a":1}').value).toEqual({ a: 1 })
        expect(extractJson('Here is the plan:\n\n```json\n{"a":{"b":[1,2]}}\n```\nLet me know').value).toEqual({ a: { b: [1, 2] } })
        expect(extractJson('```\n{"a":1}\n```').value).toEqual({ a: 1 })
    })

    it('is not fooled by braces inside strings or by non-JSON braces in prose', () => {
        expect(extractJson('{"q":"what about } and {?"}').value).toEqual({ q: 'what about } and {?' })
        expect(extractJson('Use {column} names. {"type":"clarify","question":"x"}').value).toEqual({ type: 'clarify', question: 'x' })
    })

    it('reports why it failed', () => {
        expect(extractJson('').ok).toBe(false)
        expect(extractJson('no json here').error).toMatch(/no JSON/)
        expect(extractJson('{"a": 1').error).toMatch(/not closed/)
        expect(extractJson('{a: 1}').error).toMatch(/invalid JSON/)
    })
})

describe('validate', () => {
    it('accepts a good plan and explains a bad one', () => {
        expect(validate(QUERY_PLAN_SCHEMA, { type: 'query', groupBy: ['Region'], limit: 5 })).toEqual([])
        const errors = validate(QUERY_PLAN_SCHEMA, {
            type: 'query', limit: 2.5, filters: [{ column: 'X', op: 'like' }], extra: true,
        })
        const text = errors.map(e => `${e.path} ${e.message}`)
        expect(text).toContain('$.limit must be integer, got number')
        expect(text.some(t => t.startsWith('$.filters[0].op must be one of eq'))).toBe(true)
        expect(text).toContain('$.extra is not allowed here')
    })

    it('handles required, minimum, union types and patterns', () => {
        expect(validate(QUERY_PLAN_SCHEMA, { type: 'query', limit: 0 })[0].message).toBe('must be at least 1, got 0')
        expect(validate(QUERY_PLAN_SCHEMA, { type: 'query', filters: [{ op: 'eq' }] })[0]).toEqual({ path: '$.filters[0].column', message: 'is required' })
        expect(validate(FORMAT_SHEET_SCHEMA, { type: 'format_sheet', freezeRows: null })).toEqual([])
        expect(validate(FORMAT_SHEET_SCHEMA, { type: 'format_sheet', headerStyle: { bg: 'blue' } })[0].path).toBe('$.headerStyle.bg')
    })
})

describe('parseAction', () => {
    it('rejects non-query actions as READ_ONLY before schema checks', () => {
        const r = parseAction('{"type":"mutation","action":"deleteRows"}')
        expect(r).toMatchObject({ kind: 'error', error: 'READ_ONLY' })
    })

    it('turns invalid JSON or a schema failure into INVALID_RESPONSE with the reason', () => {
        expect(parseAction('sorry, I cannot help')).toMatchObject({ kind: 'error', error: 'INVALID_RESPONSE' })
        const r = parseAction('{"type":"query","limit":"ten"}')
        expect(r.error).toBe('INVALID_RESPONSE')
        expect(r.detail).toContain('$.limit must be integer')
    })

    it('passes clarify questions through', () => {
        expect(parseAction('{"type":"clarify","question":"Which column?"}')).toMatchObject({ kind: 'clarify', question: 'Which column?' })
    })
})

const table = {
    headers: ['Region', 'Units', 'Total', 'Date'],
    rows: [
        ['West', '3', '$1,000.00', '2024-01-05'],
        ['west ', '5', '$500.00', '1/20/2024'],
        ['East', 'N/A', '$2,000.00', '15 Feb 2024'],
        ['East', '2', '', '2024-03-01'],
    ],
    totalsRow: ['Total', '10', '$3,500.00', ''],
    range: { r1: 0, c1: 0, r2: 5, c2: 3 },
}

describe('executeQuery', () => {
    it('groups on normalised keys and keeps the first label', () => {
        const r = executeQuery({ type: 'query', groupBy: ['region'], aggregates: [{ fn: 'sum', column: 'Units' }] }, table)
        expect(r.columns).toEqual(['Region', 'sum(Units)'])
        expect(r.rows).toEqual([['West', 8], ['East', 2]])
    })

    it('coerces numbers, ignores N/A, and gives null when there are no numbers', () => {
        const r = executeQuery({
            type: 'query',
            filters: [{ column: 'Region', op: 'eq', value: 'east' }],
            aggregates: [{ fn: 'avg', column: 'Units', as: 'u' }, { fn: 'count', column: 'Total', as: 'n' }, { fn: 'max', column: 'Region', as: 'm' }],
        }, table)
        expect(r.rows).toEqual([[2, 1, null]])
    })

    it('compares dates across formats and includes the totals row only when asked', () => {
        const r = executeQuery({ type: 'query', filters: [{ column: 'Date', op: 'lt', value: '2024-02-01' }], columns: ['Region'] }, table)
        expect(r.rows).toEqual([['West'], ['west ']]) // raw text, untrimmed
        const withTotals = executeQuery({ type: 'query', excludeTotalsRow: false, aggregates: [{ fn: 'count', column: 'Region', as: 'n' }] }, table)
        expect(withTotals.rows).toEqual([[5]])
    })

    it('sorts numbers numerically and stably, and caps the limit at 500', () => {
        const r = executeQuery({ type: 'query', columns: ['Total'], sort: [{ column: 'Total', dir: 'desc' }], limit: 2 }, table)
        expect(r.rows).toEqual([['$2,000.00'], ['$1,000.00']])
        expect(r.truncated).toBe(true)
        // the blank Total stays last in both directions
        const asc = executeQuery({ type: 'query', columns: ['Total'], sort: [{ column: 'Total' }] }, table)
        expect(asc.rows.map(x => x[0])).toEqual(['$500.00', '$1,000.00', '$2,000.00', ''])
        const desc = executeQuery({ type: 'query', columns: ['Total'], sort: [{ column: 'Total', dir: 'desc' }] }, table)
        expect(desc.rows.map(x => x[0])).toEqual(['$2,000.00', '$1,000.00', '$500.00', ''])
        const big = { ...table, rows: Array.from({ length: 800 }, (_, i) => ['R', String(i), '', '']) }
        const capped = executeQuery({ type: 'query', limit: 100000 }, big)
        expect(capped.rowCount).toBe(500)
        expect(capped.truncated).toBe(true)
    })

    it('returns errors instead of guessing', () => {
        expect(executeQuery({ type: 'query', groupBy: ['Territory'] }, table)).toEqual({ error: 'UNKNOWN_COLUMN', detail: 'UNKNOWN_COLUMN:Territory' })
        expect(executeQuery({ type: 'query', filters: [{ column: 'Region', op: 'like', value: 'x' }] }, table).error).toBe('UNKNOWN_OP')
        expect(executeQuery({ type: 'query', aggregates: [{ fn: 'median', column: 'Units' }] }, table).error).toBe('UNKNOWN_FN')
        expect(executeQuery({ type: 'query', groupBy: ['Region'], sort: [{ column: 'Units' }] }, table).error).toBe('UNKNOWN_SORT_COLUMN')
        expect(executeQuery({ type: 'mutation' }, table).error).toBe('READ_ONLY')
    })

    it('does a two-level group-by over 100,000 rows in under 500 ms', () => {
        const regions = ['North', 'South', 'East', 'West', 'Central']
        const cats = ['Electronics', 'Furniture', 'Accessories', 'Software']
        const rows = Array.from({ length: 100000 }, (_, i) => [
            regions[i % 5] + (i % 7 === 0 ? ' ' : ''), String((i * 13) % 97), `$${(i % 1000) + 0.5}`, '2024-01-01', cats[(i * 7) % 4],
        ])
        const big = { headers: ['Region', 'Units', 'Total', 'Date', 'Category'], rows, totalsRow: null, range: { r1: 0, c1: 0, r2: 100000, c2: 4 } }
        const t0 = performance.now()
        const r = executeQuery({
            type: 'query', groupBy: ['Region', 'Category'],
            aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }, { fn: 'avg', column: 'Units', as: 'Avg units' }],
            sort: [{ column: 'Region' }, { column: 'Sales', dir: 'desc' }],
        }, big)
        const ms = performance.now() - t0
        console.log(`two-level group-by over 100,000 rows: ${ms.toFixed(1)} ms`)
        expect(r.rowCount).toBe(20)
        expect(ms).toBeLessThan(500)
    })
})

describe('context', () => {
    it('guesses column types', () => {
        expect(inferColumnType(['ORD-1001', 'ORD-1002', 'ORD-1003'])).toBe('id')
        expect(inferColumnType(['2024-01-03', '1/8/2024', '15 Jan 2024'])).toBe('date')
        expect(inferColumnType(['$1,200.00', '79', '$45.00'])).toBe('currency')
        expect(inferColumnType(['10%', '0.1', 'n/a', '5%'])).toBe('percent')
        expect(inferColumnType(['4', '12', 'N/A', '6', '40'])).toBe('number')
        expect(inferColumnType(['North', 'West'])).toBe('text')
    })

    it('sends headers, types, examples, at most 5 sample rows and never the whole sheet', () => {
        const big = { ...table, rows: Array.from({ length: 50 }, () => table.rows[0]) }
        const ctx = buildContext(big, { r1: 1, c1: 2, r2: 9, c2: 2 })
        expect(ctx.sampleRows).toHaveLength(5)
        expect(ctx.rowCount).toBe(50)
        expect(ctx.selection).toBe('C2:C10')
        expect(ctx.hasTotalsRow).toBe(true)
        expect(ctx.columns[0]).toEqual({ name: 'Region', index: 0, type: 'text', examples: ['West'] })
    })
})

describe('describePlan', () => {
    it('says what the plan does in plain words', () => {
        expect(describePlan({
            type: 'query', filters: [{ column: 'Region', op: 'eq', value: 'West' }],
            groupBy: ['Category'], aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }],
            sort: [{ column: 'Sales', dir: 'desc' }], limit: 100000,
        })).toBe('Rows where Region is "West"; grouped by Category, showing total of Total (as "Sales"); sorted by Sales high to low; first 500 rows (asked for 100000, capped at 500); totals row left out.')
    })
})
