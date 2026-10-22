// Turns the sheet into the plain table the executor works on (AI_CONTRACT
// 3.1): row 1 is the header, rows that are blank after trimming are
// dropped, and a last row that starts with Total/Totals/Subtotal/Sum is
// kept aside as the totals row.
//
// Cells are text, exactly as the grid would show them before number
// formatting: a typed value is its raw text ("$1,200.00", "15 %"), a
// formula is its computed value.

import { isTotalsLabel } from '../engine/sortFilter.js'

export function cellText(engine, r, c) {
    const raw = engine.getRaw(r, c)
    if (!raw.startsWith('=')) return raw
    const v = engine.getValue(r, c)
    return typeof v === 'number' ? String(v) : String(v ?? '')
}

// { headers, rows, totalsRow, range } where rows don't include the header
// or the totals row. `range` is the used range in sheet coordinates.
export function readTable(engine) {
    const used = engine.getUsedRange()
    if (!used) return { headers: [], rows: [], totalsRow: null, range: null }
    const c1 = used.c1
    const width = used.c2 - c1 + 1
    const readRow = (r) => {
        const row = new Array(width)
        for (let i = 0; i < width; i++) row[i] = cellText(engine, r, c1 + i)
        return row
    }
    const headers = readRow(used.r1)
    const rows = []
    for (let r = used.r1 + 1; r <= used.r2; r++) {
        const row = readRow(r)
        if (row.every(v => v.trim() === '')) continue
        rows.push(row)
    }
    let totalsRow = null
    if (rows.length > 0) {
        const last = rows[rows.length - 1]
        const first = last.find(v => v.trim() !== '')
        if (first !== undefined && isTotalsLabel(first)) totalsRow = rows.pop()
    }
    return { headers, rows, totalsRow, range: used }
}
