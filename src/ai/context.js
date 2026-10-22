// What the model is allowed to know about the sheet (AI_CONTRACT 1): the
// headers, a guessed type and a few examples per column, at most five
// sample rows, the row count and the current selection. Never the data
// itself; it's capped no matter how big the sheet is.

import { rangeToA1 } from '../engine/address.js'
import { toNum, toDate, norm } from '../engine/values.js'

const MAX_SAMPLE_ROWS = 5
const MAX_EXAMPLES = 3
const TYPE_SAMPLE = 200 // rows looked at to guess a column's type

// number, currency, percent, date, id or text, from the column's values
export function inferColumnType(values) {
    const filled = values.map(v => String(v).trim()).filter(v => v !== '')
    if (filled.length === 0) return 'text'
    const share = (pred) => filled.filter(pred).length / filled.length
    if (share(v => toDate(v) !== null) >= 0.8) return 'date'
    // messy columns have the odd "n/a", so these only need 70% to be numbers
    if (share(v => v.endsWith('%')) >= 0.5 && share(v => toNum(v) !== null) >= 0.7) return 'percent'
    if (share(v => v.startsWith('$')) >= 0.5 && share(v => toNum(v) !== null) >= 0.7) return 'currency'
    if (share(v => toNum(v) !== null) >= 0.8) return 'number'
    // ids: letters + digits like ORD-1001, nearly all different
    const distinct = new Set(filled.map(norm)).size / filled.length
    if (share(v => /^[A-Za-z]{1,6}[-_]?\d+$/.test(v)) >= 0.8 && distinct >= 0.9) return 'id'
    return 'text'
}

// table: from readTable(); selection: a { r1, c1, r2, c2 } range or null
export function buildContext(table, selection) {
    if (!table.range) {
        return { range: null, rowCount: 0, columns: [], sampleRows: [], selection: selection ? rangeToA1(selection) : null, hasTotalsRow: false }
    }
    const sampleForTypes = table.rows.slice(0, TYPE_SAMPLE)
    const columns = table.headers.map((name, i) => {
        const values = sampleForTypes.map(row => row[i])
        const examples = []
        const seen = new Set()
        for (const v of values) {
            const t = String(v).trim()
            if (t === '' || seen.has(t)) continue
            seen.add(t)
            examples.push(t)
            if (examples.length === MAX_EXAMPLES) break
        }
        return { name: String(name).trim(), index: table.range.c1 + i, type: inferColumnType(values), examples }
    })
    return {
        range: rangeToA1(table.range),
        rowCount: table.rows.length, // data rows: no header, no blank rows, no totals row
        columns,
        sampleRows: table.rows.slice(0, MAX_SAMPLE_ROWS),
        selection: selection ? rangeToA1(selection) : null,
        hasTotalsRow: table.totalsRow !== null,
    }
}
