// The Challenge 2 acceptance checks from CHALLENGE.md, on fixtures/sales.tsv.
import { describe, it, expect, beforeEach } from 'vitest'
import { createEngine } from './core.js'
import { loadSampleSmall } from '../fixtures/loadSample.js'
import { parseRange } from './address.js'

const COL = { A: 0, C: 2, G: 6, J: 9, K: 10 }
let e

const column = (c, from = 1, to = 33) => {
    const out = []
    for (let r = from - 1; r <= to - 1; r++) out.push(e.getRaw(r, c))
    return out
}

beforeEach(() => {
    e = createEngine(50, 50)
    loadSampleSmall(e)
})

describe('Challenge 2 acceptance (sales.tsv)', () => {
    it('K2 =J2/G2 filled to K32, sort by Total descending', () => {
        e.setCell(1, COL.K, '=J2/G2')
        e.fill(parseRange('K2'), parseRange('K2:K32'))
        // the totals row also gets a whole-block range, which must not change
        e.setCell(32, COL.K, '=SUM(J2:J32)')
        const sumBefore = e.getCell(32, COL.K).computed

        e.sortColumn(COL.J, 'desc')

        expect(e.getRaw(1, COL.A)).toBe('ORD-1025')
        expect(e.getCell(1, COL.K).computed).toBe(1080) // $9,720.00 / 9
        expect(e.getRaw(1, COL.K)).toBe('=J2/G2')
        expect(e.getRaw(32, COL.A)).toBe('Total') // A33 still reads Total
        // ORD-1021 has no Total, so it's last among the orders; the empty row comes after it
        expect(e.getRaw(30, COL.A)).toBe('ORD-1021')
        expect(column(COL.A, 32, 32)).toEqual([''])
        expect([...Array(10).keys()].every(c => e.getRaw(31, c) === '')).toBe(true)
        // every K formula still divides its own row
        for (let r = 1; r <= 31; r++) expect(e.getRaw(r, COL.K)).toBe(`=J${r + 1}/G${r + 1}`)
        expect(e.getRaw(32, COL.K)).toBe('=SUM(J2:J32)')
        expect(e.getCell(32, COL.K).computed).toBeCloseTo(sumBefore)

        // and the order really is by Total, descending
        const totals = column(COL.J, 2, 30).map(v => Number(v.replace(/[$,]/g, '')))
        expect(totals).toEqual([...totals].sort((a, b) => b - a))
        e.undo()
        expect(e.getRaw(1, COL.A)).toBe('ORD-1001')
    })

    it('filter Region to West (matches "West ", "west"), sort by Units: hidden rows stay put; undo twice', () => {
        const original = column(COL.A)
        const values = e.getFilterValues(COL.C)
        const west = values.find(v => v.key === 'west')
        expect(west.label).toBe('West')
        expect(west.count).toBe(8) // 6 x "West", 1 x "West ", 1 x "west"

        e.setFilter(COL.C, { include: ['west'] })
        expect(e.filterStatus()).toEqual({ visible: 8, total: 32 })
        const hidden = [...e.getHiddenRows()].sort((a, b) => a - b)
        const hiddenBefore = hidden.map(r => e.getRaw(r, COL.A))

        e.sortColumn(COL.G, 'asc')

        // hidden rows didn't move
        expect(hidden.map(r => e.getRaw(r, COL.A))).toEqual(hiddenBefore)
        // the visible West rows are now in Units order
        const visibleUnits = []
        for (let r = 1; r <= 32; r++) if (!e.isRowHidden(r)) visibleUnits.push(Number(e.getRaw(r, COL.G)))
        expect(visibleUnits).toEqual([...visibleUnits].sort((a, b) => a - b))

        e.undo() // the sort
        expect(column(COL.A)).toEqual(original)
        expect(e.filterStatus()).not.toBeNull()
        e.undo() // the filter
        expect(e.filterStatus()).toBeNull()
        expect(e.getHiddenRows().size).toBe(0)
        expect(column(COL.A)).toEqual(original)
    })
})
