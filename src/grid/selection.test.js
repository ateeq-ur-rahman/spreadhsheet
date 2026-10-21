import { describe, it, expect } from 'vitest'
import {
    cellSelection, selectionRange, moveSelection, extendTo, rowSelection, columnSelection, fillTarget,
} from './selection.js'

const bounds = { rows: 10, cols: 5 }

describe('selection model', () => {
    it('normalizes anchor/focus into a range', () => {
        expect(selectionRange(extendTo(cellSelection(4, 3), 1, 1))).toEqual({ r1: 1, c1: 1, r2: 4, c2: 3 })
    })

    it('moves and extends, clamped to the sheet', () => {
        expect(moveSelection(cellSelection(0, 0), -1, 0, bounds)).toEqual(cellSelection(0, 0))
        const ext = moveSelection(moveSelection(cellSelection(2, 2), 1, 1, bounds, true), 1, 0, bounds, true)
        expect(selectionRange(ext)).toEqual({ r1: 2, c1: 2, r2: 4, c2: 3 })
        expect(ext.anchor).toEqual({ r: 2, c: 2 })
    })

    it('selects whole rows and columns', () => {
        expect(selectionRange(rowSelection(3, 4, bounds))).toEqual({ r1: 3, c1: 0, r2: 4, c2: 4 })
        expect(selectionRange(columnSelection(1, 1, bounds))).toEqual({ r1: 0, c1: 1, r2: 9, c2: 1 })
    })
})

describe('fillTarget', () => {
    const src = { r1: 1, c1: 0, r2: 2, c2: 0 } // A2:A3
    it('extends in the dominant direction', () => {
        expect(fillTarget(src, 5, 0)).toEqual({ r1: 1, c1: 0, r2: 5, c2: 0 })
        expect(fillTarget(src, 0, 0)).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 })
        expect(fillTarget(src, 3, 4)).toEqual({ r1: 1, c1: 0, r2: 2, c2: 4 })
        expect(fillTarget(src, 6, 2)).toEqual({ r1: 1, c1: 0, r2: 6, c2: 0 })
    })

    it('shrinks when dragged back inside and is a no-op on the corner', () => {
        expect(fillTarget(src, 1, 0)).toEqual({ r1: 1, c1: 0, r2: 1, c2: 0 })
        expect(fillTarget(src, 2, 0)).toEqual(src)
    })
})
