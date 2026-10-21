// The Challenge 1 acceptance checks from CHALLENGE.md, on fixtures/sales.tsv.
import { describe, it, expect, beforeEach } from 'vitest'
import { createEngine } from './core.js'
import { loadSampleSmall } from '../fixtures/loadSample.js'
import { parseRange } from './address.js'

const R = (a1) => parseRange(a1)
let e

beforeEach(() => {
    e = createEngine(50, 50)
    loadSampleSmall(e)
})

describe('Challenge 1 acceptance (sales.tsv)', () => {
    const colA = (from, to) => {
        const out = []
        for (let r = from - 1; r <= to - 1; r++) out.push(e.getRaw(r, 0))
        return out
    }

    it('A2:A3 dragged to A6 gives ORD-1003…ORD-1005; one undo restores', () => {
        // A4:A6 already say ORD-1003..1005 in the fixture. The fill still gets
        // its own undo step so Ctrl+Z doesn't undo the sample load instead.
        e.fill(R('A2:A3'), R('A2:A6'))
        expect(colA(4, 6)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        expect(e.undoLabel()).toBe('Fill')
        e.undo()
        expect(colA(4, 6)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        expect(e.undoLabel()).toBe('Load Sample 33')

        // blank them first so we can actually see the undo
        e.clearRange(R('A4:A6'))
        e.fill(R('A2:A3'), R('A2:A6'))
        expect(colA(4, 6)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        e.undo()
        expect(colA(4, 6)).toEqual(['', '', ''])
    })

    it('K2 =G2*H2 and L2 =$G$2*H2 filled to row 32; then insert above row 10', () => {
        e.setCell(1, 10, '=G2*H2')
        e.setCell(1, 11, '=$G$2*H2')
        e.fill(R('K2:L2'), R('K2:L32'))
        expect(e.getRaw(31, 10)).toBe('=G32*H32')
        expect(e.getRaw(31, 11)).toBe('=$G$2*H32')
        // K2 = 4 * "$1,200.00", the currency text is read as a number
        expect(e.getCell(1, 10).computed).toBe(4800)
        expect(e.getCell(31, 11).computed).toBeCloseTo(4 * 49.99)

        e.insertRow(9) // insert above row 10
        expect(e.getRaw(32, 11)).toBe('=$G$2*H33')
        expect(e.getRaw(32, 10)).toBe('=G33*H33')
        expect(e.getRaw(1, 11)).toBe('=$G$2*H2')
        e.undo()
        expect(e.getRaw(31, 11)).toBe('=$G$2*H32')
    })

    it('B2:B4 (three date formats) filled to B8 keeps each seed format', () => {
        expect(['B2', 'B3', 'B4'].map(a => e.getRaw(R(a).r1, 1))).toEqual(['2024-01-03', '2024-01-05', '1/8/2024'])
        e.fill(R('B2:B4'), R('B2:B8'))
        const got = ['B5', 'B6', 'B7', 'B8'].map(a => e.getRaw(R(a).r1, 1))
        // seeds are days 0, 2, 5; the best-fit line steps 2.5 days, which gives
        // 7.33, 9.83, 12.33, 14.83, rounded to whole days
        expect(got).toEqual(['2024-01-10', '2024-01-13', '1/15/2024', '2024-01-18'])
        expect(got[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // seed B2 format
        expect(got[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // seed B3 format
        expect(got[2]).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/) // seed B4 format
        e.undo()
        // original fixture values are back
        expect(['B6', 'B7', 'B8'].map(a => e.getRaw(R(a).r1, 1))).toEqual(['2024-01-15', '15 Jan 2024', '2024-01-20'])
    })

    it('loading the sample is a single undo step', () => {
        const fresh = createEngine(50, 50)
        loadSampleSmall(fresh)
        expect(fresh.undoLabel()).toBe('Load Sample 33')
        fresh.undo()
        expect(fresh.getUsedRange()).toBeNull()
        expect(fresh.canUndo()).toBe(false)
    })
})
