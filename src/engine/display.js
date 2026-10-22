// What text a cell shows for its computed value. Number formats only change
// what's displayed; the stored value is never touched.
//
// Rules from AI_CONTRACT 4 (display table):
//   number    79 -> 79.00, $1,200.00 -> 1,200.00, 10% -> 0.10
//   currency  79 -> $79.00, "$ 49.99" -> $49.99
//   percent   0.1 -> 10%, 10% -> 10%, 79 -> 7900%
//   date      any of the three date formats -> 2024-01-15
// Text that isn't a number (or a date, for `date`) is shown as it is, and
// blanks stay blank.

import { toNum, toDate } from './values.js'

export function formatGeneral(value) {
    if (typeof value === 'number') {
        if (Number.isInteger(value)) return String(value)
        return String(parseFloat(value.toPrecision(10)))
    }
    if (value === null || value === undefined) return ''
    return String(value)
}

const twoDecimals = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatValue(value, numberFormat = 'general') {
    if (numberFormat === 'general' || value === '' || value === null || value === undefined) return formatGeneral(value)
    if (numberFormat === 'date') {
        const d = toDate(value)
        return d ?? formatGeneral(value)
    }
    const n = toNum(value)
    if (n === null) return formatGeneral(value) // "n/a", dates, text: left alone
    switch (numberFormat) {
        case 'number': return twoDecimals.format(n)
        case 'currency': return (n < 0 ? '-$' : '$') + twoDecimals.format(Math.abs(n))
        case 'percent': return parseFloat((n * 100).toFixed(2)) + '%'
        default: return formatGeneral(value)
    }
}

// Display text for a cell from engine.getCell(), with its style's format.
export function displayText(cell, style) {
    if (cell.error) return cell.error
    return formatValue(cell.computed, style ? style.numberFormat : 'general')
}
