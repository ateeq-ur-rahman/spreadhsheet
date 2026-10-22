// Loads a fixture TSV at A1, keeping every cell's text exactly as is.
// It's one transaction, so one Ctrl+Z undoes the whole load (before, each
// cell was its own undo entry and the history filled up instantly).
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

export function loadTsv(engine, text, label = 'Load sample') {
    const rows = parseTsv(text)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    const updates = []
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            updates.push({ row: r, col: c, raw: rows[r][c] })
        }
    }
    // a fresh load also drops any filter or sort left over from before
    engine.transact(label, () => {
        engine.clearFilters()
        engine.clearSortState()
        engine.setCells(updates)
    })
    return { rows: rows.length, cols }
}

// header, 31 messy rows, totals row
export function loadSampleSmall(engine) {
    return loadTsv(engine, salesSmall, 'Load Sample 33')
}

// about 3,000 rows of the same
export function loadSampleLarge(engine) {
    return loadTsv(engine, salesLarge, 'Load Sample 3k')
}
