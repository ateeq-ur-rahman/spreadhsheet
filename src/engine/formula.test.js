import { describe, it, expect } from 'vitest'
import {
    parseFormula, evaluate, translateFormula, remapFormulaStructural, ERR,
} from './formula.js'
import { createEngine } from './core.js'

const evalText = (raw, values = {}) => {
    const p = parseFormula(raw)
    if (p.error) return p.error
    try {
        return evaluate(p.ast, (r, c) => values[`${r},${c}`] ?? '')
    } catch (e) {
        return e.code
    }
}

describe('parser and evaluator', () => {
    it('parses ranges inside functions (defect D1)', () => {
        expect(evalText('=SUM(A1:A2)', { '0,0': 10, '1,0': 20 })).toBe(30)
    })

    it('handles precedence, parentheses and unary minus', () => {
        expect(evalText('=2+3*4')).toBe(14)
        expect(evalText('=(2+3)*4')).toBe(20)
        expect(evalText('=2-3*-1')).toBe(5)
        expect(evalText('=-(1+2)')).toBe(-3)
    })

    it('accepts $-pinned references', () => {
        expect(evalText('=$A$1+A$1+$A1', { '0,0': 2 })).toBe(6)
    })

    it('coerces currency and percent text in arithmetic', () => {
        expect(evalText('=A1/B1', { '0,0': '$9,720.00', '0,1': 9 })).toBe(1080)
        expect(evalText('=A1*2', { '0,0': '10%' })).toBeCloseTo(0.2)
        expect(evalText('=A1*2', { '0,0': 'n/a' })).toBe(ERR.VALUE)
    })

    it('treats blanks as 0 in arithmetic and ignores them in aggregates (defect D9)', () => {
        const v = { '0,0': 2, '2,0': 4, '3,0': 'text' }
        expect(evalText('=A2+1', v)).toBe(1)
        expect(evalText('=AVG(A1:A4)', v)).toBe(3)
        expect(evalText('=MIN(A1:A4)', v)).toBe(2)
        expect(evalText('=COUNT(A1:A4)', v)).toBe(2)
        expect(evalText('=SUM(A1:A4, 10)', v)).toBe(16)
    })

    it('reports parse, name and division errors', () => {
        expect(evalText('=1+')).toBe(ERR.PARSE)
        expect(evalText('=FOO(A1)')).toBe(ERR.NAME)
        expect(evalText('=1/0')).toBe(ERR.DIV0)
        expect(evalText('=#REF!+1')).toBe(ERR.REF)
    })
})

describe('translateFormula (fill)', () => {
    it('shifts relative references and keeps $-pinned parts', () => {
        expect(translateFormula('=G2*H2', 30, 0)).toBe('=G32*H32')
        expect(translateFormula('=$G$2*H2', 30, 0)).toBe('=$G$2*H32')
        expect(translateFormula('=$A1+A$1', 2, 3)).toBe('=$A3+D$1')
    })

    it('shifts both ends of a range and keeps spacing and function case', () => {
        expect(translateFormula('=sum( A1:B2 ) + 1', 1, 1)).toBe('=sum( B2:C3 ) + 1')
    })

    it('does not treat function names like LOG10 as references', () => {
        expect(translateFormula('=SUM(A1:A2)', 1, 0)).toBe('=SUM(A2:A3)')
    })

    it('writes #REF! for references pushed off the sheet', () => {
        expect(translateFormula('=A1+B2', -1, 0)).toBe('=#REF!+B1')
    })
})

describe('remapFormulaStructural', () => {
    it('moves absolute references on insert too (they still point at the same cell)', () => {
        expect(remapFormulaStructural('=$G$12*H32', 'row', 'insert', 9, 1)).toBe('=$G$13*H33')
        expect(remapFormulaStructural('=$G$2*H32', 'row', 'insert', 9, 1)).toBe('=$G$2*H33')
    })

    it('expands a range that spans the insertion point', () => {
        expect(remapFormulaStructural('=SUM(J2:J32)', 'row', 'insert', 9, 1)).toBe('=SUM(J2:J33)')
    })

    it('turns a reference to a deleted row into #REF! (defect D6)', () => {
        expect(remapFormulaStructural('=A5+A6', 'row', 'delete', 4, 1)).toBe('=#REF!+A5')
    })

    it('shrinks a range that loses rows and drops one that loses all of them', () => {
        expect(remapFormulaStructural('=SUM(A2:A10)', 'row', 'delete', 4, 2)).toBe('=SUM(A2:A8)')
        expect(remapFormulaStructural('=SUM(A5:A6)', 'row', 'delete', 4, 2)).toBe('=SUM(#REF!)')
    })

    it('remaps columns', () => {
        expect(remapFormulaStructural('=D1+C1', 'col', 'insert', 3, 1)).toBe('=E1+C1')
    })
})

describe('engine recalculation', () => {
    it('recalculates a SUM when a cell in the middle of its range changes (defect D3)', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '1'); e.setCell(1, 0, '2'); e.setCell(2, 0, '3')
        e.setCell(3, 0, '=SUM(A1:A3)')
        e.setCell(1, 0, '100')
        expect(e.getCell(3, 0).computed).toBe(104)
    })

    it('rejects partial numbers like "12abc" (defect D8)', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '12abc')
        expect(e.getCell(0, 0).computed).toBe('12abc')
    })

    it('reports a self-reference as #CYCLE! (defect D10)', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '=A1+1')
        expect(e.getCell(0, 0).error).toBe(ERR.CYCLE)
    })

    it('recovers when a cycle is broken', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '=B1')
        e.setCell(0, 1, '=A1')
        e.setCell(0, 1, '7')
        expect(e.getCell(0, 0).computed).toBe(7)
    })

    it('evaluates a 20,000-long dependency chain without overflowing the stack', () => {
        const e = createEngine(20001, 2)
        const updates = [{ row: 0, col: 0, raw: '1' }]
        for (let r = 1; r < 20000; r++) updates.push({ row: r, col: 0, raw: `=A${r}+1` })
        e.setCells(updates)
        expect(e.getCell(19999, 0).computed).toBe(20000)
        e.setCell(0, 0, '5')
        expect(e.getCell(19999, 0).computed).toBe(20004)
    })

    it('reports #REF! after deleting a referenced row and restores on undo', () => {
        const e = createEngine(10, 10)
        e.setCell(4, 0, '7')
        e.setCell(0, 0, '=A5')
        e.deleteRow(4)
        expect(e.getCell(0, 0)).toMatchObject({ raw: '=#REF!', error: ERR.REF })
        e.undo()
        expect(e.getCell(0, 0)).toMatchObject({ raw: '=A5', computed: 7 })
        e.redo()
        expect(e.getCell(0, 0).raw).toBe('=#REF!')
    })
})
