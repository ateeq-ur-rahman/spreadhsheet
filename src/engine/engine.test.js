import { describe, it, expect } from 'vitest'
import { createEngine, DEFAULT_STYLE } from './core.js'

describe('transactions and undo', () => {
    it('groups a transaction into one undo step', () => {
        const e = createEngine(10, 10)
        e.transact('two edits', () => {
            e.setCell(0, 0, 'a')
            e.setCell(1, 0, 'b')
        })
        expect(e.undoLabel()).toBe('two edits')
        e.undo()
        expect(e.getRaw(0, 0)).toBe('')
        expect(e.getRaw(1, 0)).toBe('')
        expect(e.canUndo()).toBe(false)
        e.redo()
        expect(e.getRaw(1, 0)).toBe('b')
    })

    it('creates no undo entry for a no-op', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, 'x')
        e.undo()
        e.setCell(0, 0, '')
        e.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: false })
        expect(e.canUndo()).toBe(false)
    })

    it('rolls back everything when a transaction throws', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, 'keep')
        expect(() => e.transact('boom', () => {
            e.setCell(0, 0, 'changed')
            e.insertRow(0)
            throw new Error('boom')
        })).toThrow('boom')
        expect(e.getRaw(0, 0)).toBe('keep')
        expect(e.rows).toBe(10)
        expect(e.undoLabel()).toBe('Edit cell')
    })

    it('notifies subscribers and bumps the version', () => {
        const e = createEngine(10, 10)
        let calls = 0
        const off = e.subscribe(() => calls++)
        const v = e.version
        e.setCell(0, 0, '1')
        expect(calls).toBe(1)
        expect(e.version).toBeGreaterThan(v)
        off()
        e.setCell(0, 0, '2')
        expect(calls).toBe(1)
    })
})

describe('styles', () => {
    it('applies a patch to a whole range in one undo step', () => {
        const e = createEngine(10, 10)
        e.setStyle({ r1: 0, c1: 0, r2: 2, c2: 1 }, { bold: true })
        expect(e.getStyle(2, 1).bold).toBe(true)
        expect(e.getStyle(3, 1)).toBe(DEFAULT_STYLE)
        e.undo()
        expect(e.getStyle(2, 1).bold).toBe(false)
    })

    it('interns identical styles', () => {
        const e = createEngine(10, 10)
        e.setStyle({ r1: 0, c1: 0, r2: 5, c2: 0 }, { italic: true })
        expect(e.getStyle(0, 0)).toBe(e.getStyle(5, 0))
    })

    it('moves styles with rows and columns and restores them on undo', () => {
        const e = createEngine(10, 10)
        e.setStyle({ r1: 3, c1: 3, r2: 3, c2: 3 }, { bg: '#ffff99' })
        e.insertRow(0)
        e.insertColumn(0)
        expect(e.getStyle(4, 4).bg).toBe('#ffff99')
        expect(e.getStyle(3, 3).bg).toBe('white')
        e.deleteRow(4)
        expect(e.getStyle(4, 4).bg).toBe('white')
        e.undo()
        expect(e.getStyle(4, 4).bg).toBe('#ffff99')
        e.undo(); e.undo()
        expect(e.getStyle(3, 3).bg).toBe('#ffff99')
    })
})

describe('clearRange', () => {
    it('clears contents but keeps styles, as one undo step', () => {
        const e = createEngine(10, 10)
        e.setCells([{ row: 0, col: 0, raw: '1' }, { row: 1, col: 1, raw: '2' }, { row: 5, col: 5, raw: 'out' }])
        e.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true })
        e.clearRange({ r1: 0, c1: 0, r2: 1, c2: 1 })
        expect(e.getRaw(0, 0)).toBe('')
        expect(e.getRaw(1, 1)).toBe('')
        expect(e.getRaw(5, 5)).toBe('out')
        expect(e.getStyle(0, 0).bold).toBe(true)
        e.undo()
        expect(e.getRaw(1, 1)).toBe('2')
    })
})

describe('fill', () => {
    it('fills down, inherits seed styles and translates formulas', () => {
        const e = createEngine(20, 10)
        e.setCells([{ row: 0, col: 0, raw: '1' }, { row: 1, col: 0, raw: '2' }, { row: 0, col: 1, raw: '=A1*10' }])
        e.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true })
        e.fill({ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 0, c1: 0, r2: 5, c2: 1 })
        expect([2, 3, 4, 5].map(r => e.getRaw(r, 0))).toEqual(['3', '4', '5', '6'])
        expect(e.getStyle(2, 0).bold).toBe(true)
        expect(e.getStyle(3, 0).bold).toBe(false)
        // column B alternates "=A1*10" and blank, the formula moving 2 rows each time
        expect(e.getRaw(2, 1)).toBe('=A3*10')
        expect(e.getCell(4, 1).computed).toBe(50)
        expect(e.getRaw(3, 1)).toBe('')
        e.undo()
        expect(e.getRaw(2, 0)).toBe('')
    })

    it('fills up and left', () => {
        const e = createEngine(20, 10)
        e.setCells([{ row: 5, col: 5, raw: 'Item 5' }])
        e.fill({ r1: 5, c1: 5, r2: 5, c2: 5 }, { r1: 3, c1: 5, r2: 5, c2: 5 })
        expect(e.getRaw(3, 5)).toBe('Item 3')
        e.fill({ r1: 5, c1: 5, r2: 5, c2: 5 }, { r1: 5, c1: 3, r2: 5, c2: 5 })
        expect(e.getRaw(5, 3)).toBe('Item 3')
    })

    it('shrinking clears the cut-off cells', () => {
        const e = createEngine(20, 10)
        e.setCells([0, 1, 2, 3].map(r => ({ row: r, col: 0, raw: String(r) })))
        e.fill({ r1: 0, c1: 0, r2: 3, c2: 0 }, { r1: 0, c1: 0, r2: 1, c2: 0 })
        expect(e.getRaw(1, 0)).toBe('1')
        expect(e.getRaw(2, 0)).toBe('')
        expect(e.getRaw(3, 0)).toBe('')
    })

    it('rejects a diagonal target', () => {
        const e = createEngine(20, 10)
        expect(() => e.fill({ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 2, c2: 2 })).toThrow()
    })
})

describe('used range', () => {
    it('is the bounding box of non-empty cells', () => {
        const e = createEngine(20, 20)
        expect(e.getUsedRange()).toBeNull()
        e.setCells([{ row: 2, col: 3, raw: 'a' }, { row: 7, col: 1, raw: 'b' }])
        e.setStyle({ r1: 15, c1: 15, r2: 15, c2: 15 }, { bold: true })
        expect(e.getUsedRange()).toEqual({ r1: 2, c1: 1, r2: 7, c2: 3 })
        e.transact('x', () => {
            e.setCell(9, 9, 'z')
            expect(e.getUsedRange()).toEqual({ r1: 2, c1: 1, r2: 9, c2: 9 })
        })
    })
})
