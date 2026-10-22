// The pure half of sort and filter: how values compare, which rows pass a
// filter, and how to spot a totals row. The engine does the moving around.

import { toNum, toDate, norm } from './values.js'
import { ERR } from './formula.js'

const ERROR_CODES = new Set(Object.values(ERR))

// Sort order, ascending: numbers, then dates, then text, then errors.
// Blanks are handled separately because they always go last.
const NUMBER = 0, DATE = 1, TEXT = 2, ERROR = 3, BLANK = 4

export function sortKey(value) {
    if (value === null || value === undefined) return { cat: BLANK }
    if (typeof value === 'number') return { cat: NUMBER, v: value }
    const s = String(value)
    if (s.trim() === '') return { cat: BLANK }
    if (ERROR_CODES.has(s)) return { cat: ERROR }
    // "$9,720.00" and "10%" sort as numbers, not as text
    const n = toNum(s)
    if (n !== null) return { cat: NUMBER, v: n }
    const d = toDate(s)
    if (d) return { cat: DATE, v: d }
    return { cat: TEXT, v: norm(s) }
}

export function compareKeys(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat
    if (a.cat >= ERROR) return 0
    return a.v < b.v ? -1 : a.v > b.v ? 1 : 0
}

export const isBlankKey = (k) => k.cat === BLANK

// Indices 0..n-1 in sorted order. Stable, and blanks stay at the end in
// their original order whichever way we sort. Descending flips everything
// else (so text comes before numbers, like Excel).
export function sortedOrder(keys, dir) {
    const idx = keys.map((_, i) => i)
    const sign = dir === 'desc' ? -1 : 1
    idx.sort((i, j) => {
        const a = keys[i]
        const b = keys[j]
        const ab = isBlankKey(a)
        const bb = isBlankKey(b)
        if (ab !== bb) return ab ? 1 : -1
        const c = ab ? 0 : sign * compareKeys(a, b)
        return c !== 0 ? c : i - j
    })
    return idx
}

// ── Totals row ────────────────────────────────────────────────

const TOTALS_RE = /^(grand\s+)?(total|totals|subtotal|sum)\b/i

// The rule from AI_CONTRACT 3.1: the row's first non-empty cell says Total,
// Totals, Subtotal, Sum or "Grand total".
export function isTotalsLabel(text) {
    return TOTALS_RE.test(String(text ?? '').trim())
}

// ── Filters ───────────────────────────────────────────────────
//
// A filter spec for one column:
//   include:   null, or the list of allowed values as norm() keys ('' = blanks)
//   condition: null, or { op: 'contains' | 'gt' | 'lt' | 'isEmpty', value }
// A row has to pass both parts. Several columns combine with AND.

export const FILTER_CONDITIONS = ['contains', 'gt', 'lt', 'isEmpty']

export function isEmptyFilter(spec) {
    return !spec || (!spec.include && !spec.condition)
}

function passesCondition(value, { op, value: want }) {
    const cell = norm(value)
    switch (op) {
        case 'isEmpty':
            return cell === ''
        case 'contains':
            return cell.includes(norm(want))
        case 'gt':
        case 'lt': {
            // same rule as the query executor: compare as dates when the value
            // is a date, otherwise as numbers; anything else doesn't match
            const wantDate = toDate(want)
            let a, b
            if (wantDate) {
                a = toDate(value)
                b = wantDate
            } else {
                a = toNum(value)
                b = toNum(want)
            }
            if (a === null || b === null) return false
            return op === 'gt' ? a > b : a < b
        }
        default:
            return true
    }
}

// Pre-builds the include set so testing a row is cheap.
export function compileFilter(spec) {
    const include = spec.include ? new Set(spec.include) : null
    const condition = spec.condition || null
    return (value) => {
        if (include && !include.has(norm(value))) return false
        if (condition && !passesCondition(value, condition)) return false
        return true
    }
}
