import { describe, it, expect } from 'vitest'
import { sortKey, sortedOrder, compileFilter, isTotalsLabel } from './sortFilter.js'
import { createEngine } from './core.js'

const order = (values, dir) => sortedOrder(values.map(sortKey), dir).map(i => values[i])

describe('sort comparator', () => {
    it('puts numbers before dates before text, blanks last', () => {
        expect(order(['b', '', 10, '2024-01-02', 'A', 2, '$5.00'], 'asc'))
            .toEqual([2, '$5.00', 10, '2024-01-02', 'A', 'b', ''])
    })

    it('compares dates as dates across formats', () => {
        expect(order(['15 Jan 2024', '1/8/2024', '2024-01-03'], 'asc'))
            .toEqual(['2024-01-03', '1/8/2024', '15 Jan 2024'])
    })

    it('is case-insensitive and stable', () => {
        expect(order(['west', 'East', 'West ', 'east'], 'asc')).toEqual(['East', 'east', 'west', 'West '])
    })

    it('keeps blanks last when descending', () => {
        expect(order(['', 1, 3, '', 2], 'desc')).toEqual([3, 2, 1, '', ''])
    })
})

describe('filter specs', () => {
    it('matches the checklist on trimmed, lower-case values', () => {
        const pass = compileFilter({ include: ['west'], condition: null })
        expect(['West', 'West ', 'west', 'East'].map(pass)).toEqual([true, true, true, false])
    })

    it('supports contains, greater than, less than and is empty', () => {
        expect(['Laptop Pro', 'Desk'].map(compileFilter({ condition: { op: 'contains', value: 'pro' } }))).toEqual([true, false])
        expect(['$5,000.00', '20', 'n/a'].map(compileFilter({ condition: { op: 'gt', value: '100' } }))).toEqual([true, false, false])
        expect(['2024-01-03', '15 Jan 2024'].map(compileFilter({ condition: { op: 'lt', value: '2024-01-10' } }))).toEqual([true, false])
        expect(['', ' ', 'x'].map(compileFilter({ condition: { op: 'isEmpty' } }))).toEqual([true, true, false])
    })

    it('recognises totals labels', () => {
        expect(['Total', 'Grand total', 'Subtotals', 'SUM', 'Totally'].map(isTotalsLabel)).toEqual([true, true, false, true, false])
    })
})

describe('engine sort', () => {
    const load = (rows) => {
        const e = createEngine(20, 5)
        e.setCells(rows.flatMap((row, r) => row.map((raw, c) => ({ row: r, col: c, raw }))))
        return e
    }
    const colA = (e, n) => Array.from({ length: n }, (_, r) => e.getRaw(r, 0))

    it('cycles asc -> desc -> original, each one undo step', () => {
        const e = load([['Name'], ['b'], ['c'], ['a']])
        expect(e.cycleSort(0)).toBe('asc')
        expect(colA(e, 4)).toEqual(['Name', 'a', 'b', 'c'])
        expect(e.cycleSort(0)).toBe('desc')
        expect(colA(e, 4)).toEqual(['Name', 'c', 'b', 'a'])
        expect(e.cycleSort(0)).toBe('original')
        expect(colA(e, 4)).toEqual(['Name', 'b', 'c', 'a'])
        expect(e.getSortState()).toBeNull()
        e.undo()
        expect(colA(e, 4)).toEqual(['Name', 'c', 'b', 'a'])
        expect(e.getSortState()).toEqual({ col: 0, dir: 'desc' })
    })

    it('makes single references follow their rows but leaves ranges alone', () => {
        const e = load([['n', 'x'], ['3', '=A2*10'], ['1', '=A3*10'], ['2', '=A4*10']])
        e.setCell(5, 0, '=SUM(A2:A4)')
        e.setCell(5, 1, '=A2')
        e.sortColumn(0, 'asc')
        expect(colA(e, 4)).toEqual(['n', '1', '2', '3'])
        expect([1, 2, 3].map(r => e.getRaw(r, 1))).toEqual(['=A2*10', '=A3*10', '=A4*10'])
        expect([1, 2, 3].map(r => e.getCell(r, 1).computed)).toEqual([10, 20, 30])
        expect(e.getRaw(5, 0)).toBe('=SUM(A2:A4)')
        // B6 pointed at the row holding 3, which is now row 4
        expect(e.getRaw(5, 1)).toBe('=A4')
        expect(e.getCell(5, 1).computed).toBe(3)
    })

    it('moves styles and row ids with the rows', () => {
        const e = load([['n'], ['2'], ['1']])
        e.setStyle({ r1: 1, c1: 0, r2: 1, c2: 0 }, { bold: true })
        const id = e.getRowId(1)
        e.sortColumn(0, 'asc')
        expect(e.getStyle(2, 0).bold).toBe(true)
        expect(e.getRowId(2)).toBe(id)
    })

    it('sorts a multi-cell selection without touching rows outside it', () => {
        const e = load([['h'], ['z'], ['c'], ['b'], ['a']])
        e.sortColumn(0, 'asc', { r1: 2, c1: 0, r2: 3, c2: 0 })
        expect(colA(e, 5)).toEqual(['h', 'z', 'b', 'c', 'a'])
    })
})

describe('engine filters', () => {
    it('hides rows, combines columns with AND, and undoes', () => {
        const e = createEngine(20, 5)
        e.setCells([
            ['Region', 'Units'], ['West', '5'], ['east', '9'], ['west ', '12'], ['North', '1'],
        ].flatMap((row, r) => row.map((raw, c) => ({ row: r, col: c, raw }))))
        e.setFilter(0, { include: ['west'] })
        expect([...e.getHiddenRows()].sort()).toEqual([2, 4])
        expect(e.filterStatus()).toEqual({ visible: 2, total: 4 })
        e.setFilter(1, { condition: { op: 'gt', value: 10 } })
        expect([...e.getHiddenRows()].sort()).toEqual([1, 2, 4])
        e.undo()
        expect(e.filterStatus()).toEqual({ visible: 2, total: 4 })
        e.clearFilters()
        expect(e.filterStatus()).toBeNull()
        e.undo()
        expect(e.getHiddenRows().size).toBe(2)
    })

    it('lists distinct values grouped by normalised text with a blanks entry', () => {
        const e = createEngine(20, 5)
        e.setCells(['Region', 'West', 'west', 'West ', '', 'East'].map((raw, r) => ({ row: r, col: 0, raw })))
        e.setCell(6, 1, 'x') // makes row 6 part of the used range; A7 is blank
        expect(e.getFilterValues(0)).toEqual([
            { key: 'east', label: 'East', count: 1 },
            { key: 'west', label: 'West', count: 3 },
            { key: '', label: '(Blanks)', count: 2 },
        ])
    })

    it('keeps the filter on its column when a column is inserted before it', () => {
        const e = createEngine(20, 5)
        e.setCells([{ row: 0, col: 1, raw: 'R' }, { row: 1, col: 1, raw: 'a' }, { row: 2, col: 1, raw: 'b' }])
        e.setFilter(1, { include: ['a'] })
        e.insertColumn(0)
        expect(e.getFilter(2)).toEqual({ include: ['a'] })
        expect([...e.getHiddenRows()]).toEqual([2])
    })

    it('restores the deleted row ids on undo', () => {
        const e = createEngine(10, 3)
        const id = e.getRowId(4)
        e.deleteRow(4)
        expect(e.getRowId(4)).not.toBe(id)
        e.undo()
        expect(e.getRowId(4)).toBe(id)
    })
})
