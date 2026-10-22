// The Challenge 3 acceptance checks from CHALLENGE.md that the engine owns.
// (Scrolling, frame times and commit counts are measured in the browser by
// perf/measure.mjs.)
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { loadSampleLarge } from '../fixtures/loadSample.js'
import { parseRange } from './address.js'

describe('Challenge 3 acceptance', () => {
    it('loads sales-large.tsv and fills K2 =J2*2 down to row 100,000 (name box K2:K100000 + Ctrl+D)', () => {
        const e = createEngine(100000, 200)
        loadSampleLarge(e)
        e.setCell(1, 10, '=J2*2')
        const range = parseRange('K2:K100000')
        // what Ctrl+D does with that selection
        const t = performance.now()
        e.fill({ ...range, r2: range.r1 }, range, { copy: true })
        const ms = performance.now() - t
        expect(e.getRaw(99999, 10)).toBe('=J100000*2')
        expect(e.getRaw(2990, 10)).toBe('=J2991*2')
        // J2991 is "$8,982.00"
        expect(e.getCell(2990, 10).computed).toBe(17964)
        expect(e.getCell(99999, 10).computed).toBe(0) // J100000 is blank
        expect(e.rows).toBe(100000)
        expect(e.undoLabel()).toBe('Fill')
        console.log(`fill K2:K100000 took ${ms.toFixed(0)} ms in Node`)

        // editing J95000 only recalculates K95000
        e.setCell(94999, 9, '21')
        expect(e.getCell(94999, 10).computed).toBe(42)
    }, 30000)

    it('freeze row 1, D = 300 px, insert a column before D: new D is default, old D (now E) keeps 300', () => {
        const e = createEngine(100, 20)
        e.setFrozen(1, 0)
        expect(e.getFrozen()).toEqual({ rows: 1, cols: 0 })
        e.setColWidth(3, 300)
        e.insertColumn(3)
        expect(e.getColWidth(3)).toBeNull() // default width
        expect(e.getColWidth(4)).toBe(300)
        e.undo() // the insert
        expect(e.getColWidth(3)).toBe(300)
        e.undo() // the resize
        expect(e.getColWidth(3)).toBeNull()
        e.undo() // the freeze
        expect(e.getFrozen()).toEqual({ rows: 0, cols: 0 })
    })

    it('row heights follow their rows through insert, delete and sort', () => {
        const e = createEngine(20, 3)
        e.setCells([['h'], ['b'], ['a']].flatMap((row, r) => row.map((raw, c) => ({ row: r, col: c, raw }))))
        e.setRowHeight(1, 40) // the "b" row
        e.sortColumn(0, 'asc')
        expect(e.getRowHeight(2)).toBe(40)
        e.insertRow(0)
        expect(e.getRowHeight(3)).toBe(40)
        e.deleteRow(3)
        expect(e.getRowHeight(3)).toBeNull()
        e.undo()
        expect(e.getRowHeight(3)).toBe(40)
    })

    it('auto-fit uses the widest displayed text, clamped to 30..600', () => {
        const e = createEngine(10, 3)
        e.setCells([{ row: 0, col: 0, raw: 'abc' }, { row: 1, col: 0, raw: 'abcdefghij' }, { row: 0, col: 1, raw: 'x'.repeat(500) }])
        const widths = e.autoFitColumns([0, 1, 2], (text) => text.length * 8)
        expect(widths).toEqual({ 0: 96, 1: 600, 2: 30 })
        expect(e.getColWidth(0)).toBe(96)
        e.undo()
        expect(e.getColWidth(0)).toBeNull()
    })

    it('Ctrl+D copies instead of continuing a series', () => {
        const e = createEngine(10, 3)
        e.setCell(0, 0, 'Item 1')
        e.fill({ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 2, c2: 0 }, { copy: true })
        expect(e.getRaw(2, 0)).toBe('Item 1')
    })
})
