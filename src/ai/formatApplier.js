// Applies a validated `format_sheet` action through the engine's style
// system, following AI_CONTRACT 4 step by step. No React; it only uses the
// engine's public methods, inside one transaction, so Apply is one undo step
// and an action that changes nothing leaves no undo entry at all.
//
// applyFormat(engine, action, { measure }) ->
//   { result: 'APPLIED' | 'NO_CHANGES' | 'OUT_OF_RANGE', message }

import { isTotalsLabel } from '../engine/sortFilter.js'
import { toNum } from '../engine/values.js'
import { colToLetters } from '../engine/address.js'
import { cellText } from './sheetTable.js'

const HEADER_ROW = 0 // "Row 1 is the header"

// What the applier needs to know about the sheet: the used range, which
// columns exist, and whether the last row is a totals row.
export function inspectSheet(engine) {
    const used = engine.getUsedRange()
    if (!used) return { used: null, colCount: 0, rowCount: 0, totalsRow: null }
    return {
        used,
        colCount: used.c2 + 1,
        rowCount: used.r2 + 1, // used rows counted from row 1
        totalsRow: isTotalsRow(engine, used) ? used.r2 : null,
    }
}

// 4.2: the last used row is a totals row if its first filled cell says
// Total/Totals/Subtotal/Sum, or it reads like a summary line: a text label
// first, then only numbers, at least two cells filled, and at least one
// column left empty.
export function isTotalsRow(engine, used) {
    const r = used.r2
    if (r <= HEADER_ROW) return false
    const cells = []
    for (let c = used.c1; c <= used.c2; c++) cells.push(cellText(engine, r, c).trim())
    const filled = cells.filter(v => v !== '')
    if (filled.length === 0) return false
    if (isTotalsLabel(filled[0])) return true
    return filled.length >= 2
        && filled.length < cells.length
        && toNum(filled[0]) === null
        && filled.slice(1).every(v => toNum(v) !== null)
}

const withoutNumberFormat = (style) => {
    const { numberFormat: _ignored, ...rest } = style
    return rest
}

export function applyFormat(engine, action, { measure } = {}) {
    const sheet = inspectSheet(engine)
    if (!sheet.used) return { result: 'NO_CHANGES', message: 'The sheet is empty, so there is nothing to format.' }
    const { used, colCount, rowCount, totalsRow } = sheet

    // 4.5: refuse a freeze that would cover every used row, before touching anything
    if (typeof action.freezeRows === 'number' && action.freezeRows >= rowCount) {
        return {
            result: 'OUT_OF_RANGE',
            message: `Freezing ${action.freezeRows} rows would freeze the whole table (it has ${rowCount} rows). Nothing was changed.`,
        }
    }

    const inRange = (col) => col >= used.c1 && col < colCount // 4.4: nothing outside the used range
    const hasBody = used.r2 > HEADER_ROW
    const body = (c1, c2) => ({ r1: HEADER_ROW + 1, c1, r2: used.r2, c2 })
    const versionBefore = engine.version

    engine.transact('AI format', () => {
        // 4.3, in this order
        if (action.clearFormatting) engine.clearStyles(used)
        if (action.bodyStyle && hasBody) engine.setStyle(body(used.c1, used.c2), action.bodyStyle)
        for (const entry of action.columns || []) {
            // the header row is never number-formatted or realigned by a column entry
            if (inRange(entry.col) && hasBody) engine.setStyle(body(entry.col, entry.col), entry.style)
        }
        if (action.totalsStyle && totalsRow !== null) {
            engine.setStyle({ r1: totalsRow, c1: used.c1, r2: totalsRow, c2: used.c2 }, action.totalsStyle)
        }
        if (action.headerStyle) {
            // last, so it wins over column alignment; never a number format on the header
            engine.setStyle({ r1: HEADER_ROW, c1: used.c1, r2: HEADER_ROW, c2: used.c2 }, withoutNumberFormat(action.headerStyle))
        }
        for (const w of action.columnWidths || []) {
            if (inRange(w.col) && w.width >= 30 && w.width <= 600) engine.setColWidth(w.col, w.width)
        }
        if (typeof action.freezeRows === 'number') {
            const frozen = engine.getFrozen()
            if (frozen.rows !== action.freezeRows) engine.setFrozen(action.freezeRows, frozen.cols)
        }
        // 4.6: after everything else, so it measures the formatted text
        if (action.autoFitColumns && measure) {
            const cols = []
            for (let c = used.c1; c <= used.c2; c++) cols.push(c)
            engine.autoFitColumns(cols, measure)
        }
    })

    // 4.7: the engine only records an undo step (and bumps its version) when something changed
    if (engine.version === versionBefore) {
        return { result: 'NO_CHANGES', message: 'That would not change anything, so nothing was done.' }
    }
    return { result: 'APPLIED', message: 'Applied. One Ctrl+Z undoes it.' }
}

// ── Preview in plain words ─────────────────────────────────────

const COLOR_NAMES = {
    '#f0f0f0': 'grey', '#cce5ff': 'blue', '#ffff99': 'yellow', '#99ffcc': 'green', '#ffcccc': 'red',
    '#e0ccff': 'purple', '#ffd9b3': 'orange', white: 'white', '#ffffff': 'white', '#202124': 'dark grey', '#000000': 'black',
}
const colorName = (c) => COLOR_NAMES[String(c).toLowerCase()] || c

export function styleWords(style) {
    const words = []
    if (style.bold !== undefined) words.push(style.bold ? 'bold' : 'not bold')
    if (style.italic !== undefined) words.push(style.italic ? 'italic' : 'not italic')
    if (style.underline !== undefined) words.push(style.underline ? 'underlined' : 'not underlined')
    if (style.bg !== undefined) words.push(colorName(style.bg) + ' background')
    if (style.color !== undefined) words.push(colorName(style.color) + ' text')
    if (style.align !== undefined) words.push(style.align + '-aligned')
    if (style.fontSize !== undefined) words.push(`size ${style.fontSize}`)
    if (style.numberFormat !== undefined) words.push(style.numberFormat === 'general' ? 'no number format' : style.numberFormat + ' format')
    return words.join(', ')
}

// One line per change, e.g. "header: bold, grey background, center-aligned".
// Says up front what will be skipped and why.
export function describeFormat(action, sheet) {
    const lines = []
    const colCount = sheet.colCount
    if (action.clearFormatting) lines.push('clear all formatting first')
    if (action.bodyStyle) lines.push(`body rows: ${styleWords(action.bodyStyle)}`)
    for (const entry of action.columns || []) {
        const name = `column ${colToLetters(entry.col)}`
        if (entry.col >= colCount) lines.push(`${name}: skipped (outside the ${colCount}-column table)`)
        else lines.push(`${name}: ${styleWords(entry.style)}`)
    }
    if (action.totalsStyle) {
        lines.push(sheet.totalsRow !== null
            ? `totals row (row ${sheet.totalsRow + 1}): ${styleWords(action.totalsStyle)}`
            : 'totals row: skipped (the last row is not a totals row)')
    }
    if (action.headerStyle) {
        const words = styleWords(withoutNumberFormat(action.headerStyle))
        lines.push(`header: ${words}${action.headerStyle.numberFormat ? ' (number format left off; the header is never number-formatted)' : ''}`)
    }
    for (const w of action.columnWidths || []) lines.push(`column ${colToLetters(w.col)} width: ${w.width}px`)
    if (typeof action.freezeRows === 'number') {
        if (action.freezeRows >= sheet.rowCount && sheet.rowCount > 0) lines.push(`freeze ${action.freezeRows} rows: refused (the table only has ${sheet.rowCount} rows)`)
        else lines.push(action.freezeRows === 0 ? 'unfreeze rows' : `freeze ${action.freezeRows} row${action.freezeRows === 1 ? '' : 's'}`)
    }
    if (action.autoFitColumns) lines.push('auto-fit column widths')
    if (lines.length === 0) lines.push('nothing to change')
    return lines
}
