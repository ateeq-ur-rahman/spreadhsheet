// Runs a validated `query` plan over a table from readTable(). Pure: no
// engine, no React, no model. Every number in the result is computed here.
// Rules follow AI_CONTRACT.md section 3; the comments point at the clause.
//
// Returns { columns, rows, rowCount, truncated }
//      or { error: 'UNKNOWN_COLUMN' | ..., detail }.

import { FILTER_OPS, AGGREGATE_FNS, MAX_RESULT_ROWS } from './contract.js'
import { norm, toNum, toDate } from '../engine/values.js'

class QueryError extends Error {
    constructor(code, detail) {
        super(detail || code)
        this.code = code
        this.detail = detail || code
    }
}

const round2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)

// 3.3 filters, for one cell text `c` and the plan's value `v`
function filterTest(op, v) {
    const vNum = toNum(v)
    const vDate = v === null || v === undefined ? null : toDate(v)
    const vNorm = norm(v)
    switch (op) {
        case 'eq':
        case 'neq': {
            const same = (c) => {
                const cNum = toNum(c)
                if (cNum !== null && vNum !== null) return cNum === vNum
                return norm(c) === vNorm
            }
            return op === 'eq' ? same : (c) => !same(c)
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const cmp = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b }[op]
            if (vDate) {
                // a date value: compare dates; a cell that isn't a date fails
                return (c) => { const d = toDate(c); return d !== null && cmp(d, vDate) }
            }
            return (c) => { const n = toNum(c); return n !== null && vNum !== null && cmp(n, vNum) }
        }
        case 'contains': return (c) => norm(c).includes(vNorm)
        case 'startsWith': return (c) => norm(c).startsWith(vNorm)
        case 'endsWith': return (c) => norm(c).endsWith(vNorm)
        case 'isEmpty': return (c) => norm(c) === ''
        case 'notEmpty': return (c) => norm(c) !== ''
        default: throw new QueryError('UNKNOWN_OP', `UNKNOWN_OP:${op}`)
    }
}

// 3.4 aggregates over the cell texts of one group
function aggregate(fn, values) {
    switch (fn) {
        case 'count': {
            let n = 0
            for (const v of values) if (String(v).trim() !== '') n++
            return n
        }
        case 'countDistinct': {
            const seen = new Set()
            for (const v of values) { const k = norm(v); if (k !== '') seen.add(k) }
            return seen.size
        }
        case 'sum':
        case 'avg':
        case 'min':
        case 'max': {
            let count = 0, sum = 0, min = Infinity, max = -Infinity
            for (const v of values) {
                const n = toNum(v)
                if (n === null) continue
                count++
                sum += n
                if (n < min) min = n
                if (n > max) max = n
            }
            if (count === 0) return null // no numbers at all
            return fn === 'sum' ? sum : fn === 'avg' ? sum / count : fn === 'min' ? min : max
        }
        default: throw new QueryError('UNKNOWN_FN', `UNKNOWN_FN:${fn}`)
    }
}

// 3.5 sort: numbers numerically, then text by norm(). "Numbers before
// non-numbers" holds in both directions, so blanks and text stay at the
// end of a descending sort too; `sign` only flips number-vs-number and
// text-vs-text. Stable (Array.prototype.sort is stable).
function compareValues(a, b, sign) {
    const na = toNum(a)
    const nb = toNum(b)
    if (na !== null && nb !== null) return sign * (na - nb)
    if (na !== null) return -1
    if (nb !== null) return 1
    const sa = norm(a)
    const sb = norm(b)
    return sign * (sa < sb ? -1 : sa > sb ? 1 : 0)
}

export function executeQuery(plan, table) {
    try {
        return run(plan, table)
    } catch (e) {
        if (e instanceof QueryError) return { error: e.code, detail: e.detail }
        throw e
    }
}

function run(plan, table) {
    if (!plan || plan.type !== 'query') throw new QueryError('READ_ONLY', `READ_ONLY:${plan?.type}`)

    // 3.2: column names match case-insensitively after trim; no guessing
    const byName = new Map()
    table.headers.forEach((h, i) => { const k = norm(h); if (k !== '' && !byName.has(k)) byName.set(k, i) })
    const col = (name) => {
        const i = byName.get(norm(name))
        if (i === undefined) throw new QueryError('UNKNOWN_COLUMN', `UNKNOWN_COLUMN:${name}`)
        return i
    }
    const headerOf = (i) => String(table.headers[i]).trim()

    // resolve everything up front so a bad plan fails before any work
    const filters = (plan.filters || []).map(f => {
        if (!FILTER_OPS.includes(f.op)) throw new QueryError('UNKNOWN_OP', `UNKNOWN_OP:${f.op}`)
        return { i: col(f.column), test: filterTest(f.op, f.value) }
    })
    const groupBy = (plan.groupBy || []).map(col)
    const aggregates = (plan.aggregates || []).map(a => {
        if (!AGGREGATE_FNS.includes(a.fn)) throw new QueryError('UNKNOWN_FN', `UNKNOWN_FN:${a.fn}`)
        return { fn: a.fn, i: col(a.column), as: a.as ?? `${a.fn}(${a.column})` }
    })
    const grouped = groupBy.length > 0 || aggregates.length > 0
    const projection = !grouped ? (plan.columns ? plan.columns.map(col) : table.headers.map((_, i) => i)) : null

    // 3.1: totals row is excluded unless excludeTotalsRow is false
    let rows = table.rows
    if (plan.excludeTotalsRow === false && table.totalsRow) rows = [...rows, table.totalsRow]

    // 3.3: every filter has to pass (AND)
    if (filters.length) rows = rows.filter(row => filters.every(f => f.test(row[f.i])))

    let columns
    let out
    if (grouped) {
        // 3.4: group on the norm() of each groupBy column; the label is the
        // trimmed text of the first row seen in the group
        const groups = new Map()
        for (const row of rows) {
            const key = groupBy.map(i => norm(row[i])).join('\u0000')
            let g = groups.get(key)
            if (!g) groups.set(key, (g = { labels: groupBy.map(i => String(row[i]).trim()), rows: [] }))
            g.rows.push(row)
        }
        // aggregates with no groupBy: the whole (filtered) table is one group
        if (groupBy.length === 0 && groups.size === 0) groups.set('', { labels: [], rows: [] })
        columns = [...groupBy.map(headerOf), ...aggregates.map(a => a.as)]
        out = []
        for (const g of groups.values()) {
            out.push([...g.labels, ...aggregates.map(a => round2(aggregate(a.fn, g.rows.map(r => r[a.i]))))])
        }
    } else {
        // row results: raw cell text, untrimmed
        columns = projection.map(headerOf)
        out = rows.map(row => projection.map(i => row[i]))
    }

    // 3.5: sort keys name output columns
    const sortKeys = (plan.sort || []).map(s => {
        const i = columns.findIndex(c => norm(c) === norm(s.column))
        if (i < 0) throw new QueryError('UNKNOWN_SORT_COLUMN', `UNKNOWN_SORT_COLUMN:${s.column}`)
        return { i, sign: s.dir === 'desc' ? -1 : 1 }
    })
    if (sortKeys.length) {
        out.sort((a, b) => {
            for (const k of sortKeys) {
                const c = compareValues(a[k.i], b[k.i], k.sign)
                if (c !== 0) return c
            }
            return 0
        })
    }

    // 3.5: default 500, capped at 500 whatever the plan says
    const limit = Math.min(plan.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS)
    const truncated = out.length > limit
    if (truncated) out = out.slice(0, limit)
    return { columns, rows: out, rowCount: out.length, truncated }
}
