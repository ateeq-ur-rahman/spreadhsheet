// All 10 cases in fixtures/ai-eval/format-prompts.json on sales.tsv, through
// the panel's path: mock provider -> extract -> validate -> applyFormat.
// Then the same actions on sales-large.tsv, where the totals row is 2,992.
import { describe, it, expect } from 'vitest'
import golden from '../../fixtures/ai-eval/format-prompts.json'
import { createEngine } from '../engine/core.js'
import { parseRange } from '../engine/address.js'
import { displayText } from '../engine/display.js'
import { loadSampleSmall, loadSampleLarge } from '../fixtures/loadSample.js'
import { createMockProvider } from './mockProvider.js'
import { requestAction } from './pipeline.js'
import { applyFormat, inspectSheet } from './formatApplier.js'

// no DOM in tests: a fixed-width font is close enough for auto-fit
const measure = (text) => String(text).length * 7.8

const at = (a1) => { const r = parseRange(a1); return [r.r1, r.c1] }

// everything a format action can change, for "one undo puts it all back"
function snapshot(e) {
    const out = { frozen: e.getFrozen(), widths: [], styles: [] }
    const used = e.getUsedRange()
    for (let c = 0; c <= used.c2 + 1; c++) out.widths.push(e.getColWidth(c))
    for (let r = 0; r <= used.r2 + 1; r++) for (let c = 0; c <= used.c2 + 1; c++) out.styles.push(e.getStyle(r, c))
    return out
}

async function actionFor(engine, prompt) {
    const answer = await requestAction({ provider: createMockProvider(), prompt, context: {} })
    expect(answer.kind).toBe('format_sheet')
    return answer.action
}

function setup(c) {
    const e = createEngine(100000, 200)
    loadSampleSmall(e)
    if (c.precondition) e.deleteRow(32) // f10: "Delete row 33 first"
    // A freshly loaded sheet has no formatting, so "Remove all formatting"
    // would be a correct NO_CHANGES and the undo check would test nothing.
    // Format it first (f01) so there is something to clear. The clean-sheet
    // case gets its own test below.
    if (c.id === 'f06') applyFormat(e, golden.cases[0].action, { measure })
    return e
}

// The fixture's f03 "blank stays blank" check names J22, but J22 is
// ORD-1020's $3,344.00. The blank Total is the next row, ORD-1021 (J23).
// The intent is clear, so check the blank cell and leave the fixture as given.
const ERRATA = { f03: { J22: 'J23' } }
const cellFor = (c, a1) => (ERRATA[c.id] && ERRATA[c.id][a1]) || a1

describe('golden format prompts (sales.tsv)', () => {
    for (const c of golden.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const e = setup(c)
            const action = await actionFor(e, c.prompt)
            expect(action).toEqual(c.action)
            const labelBefore = e.undoLabel()
            const before = snapshot(e)

            const res = applyFormat(e, action, { measure })

            for (const want of c.expect) {
                if (want.result) {
                    expect(res.result).toBe(want.result)
                    expect(e.undoLabel()).toBe(labelBefore) // no undo entry
                    expect(snapshot(e)).toEqual(before) // nothing changed
                } else if (want.style) {
                    const style = e.getStyle(...at(want.cell))
                    for (const [k, v] of Object.entries(want.style)) expect(style[k], `${want.cell}.${k}`).toBe(v)
                } else if ('display' in want) {
                    const a1 = cellFor(c, want.cell)
                    const [r, col] = at(a1)
                    expect(displayText(e.getCell(r, col), e.getStyle(r, col)), a1).toBe(want.display)
                } else if ('raw' in want) {
                    expect(e.getRaw(...at(want.cell))).toBe(want.raw)
                } else if ('frozenRows' in want) {
                    expect(e.getFrozen().rows).toBe(want.frozenRows)
                } else if (want.undoSteps === 1) {
                    if (c.id === 'f04') {
                        // nothing was frozen, so unfreezing is a no-op (the note on f04)
                        expect(res.result).toBe('NO_CHANGES')
                        expect(e.undoLabel()).toBe(labelBefore)
                    } else {
                        expect(res.result).toBe('APPLIED')
                        expect(e.undoLabel()).toBe('AI format')
                        e.undo()
                        expect(snapshot(e)).toEqual(before)
                        expect(e.undoLabel()).toBe(labelBefore)
                    }
                }
            }
        })
    }

    it('f06 on an unformatted sheet is NO_CHANGES with no undo entry', async () => {
        const e = setup({})
        const label = e.undoLabel()
        const action = await actionFor(e, 'Remove all formatting')
        expect(applyFormat(e, action, { measure }).result).toBe('NO_CHANGES')
        expect(e.undoLabel()).toBe(label)
    })

    it('f03 really does check the blank Total cell (J23, ORD-1021)', () => {
        const e = setup({})
        expect(e.getRaw(...at('A23'))).toBe('ORD-1021')
        expect(e.getRaw(...at('J23'))).toBe('')
        expect(e.getRaw(...at('J22'))).toBe('$3,344.00')
    })

    it('f04 with row 1 frozen first: unfreezes, and one undo freezes it again', async () => {
        const e = setup({})
        e.setFrozen(1, 0)
        const action = await actionFor(e, 'Unfreeze the header row')
        expect(applyFormat(e, action, { measure }).result).toBe('APPLIED')
        expect(e.getFrozen().rows).toBe(0)
        e.undo()
        expect(e.getFrozen().rows).toBe(1)
    })

    it('f01 also auto-fits every column and sets the header last (it wins over column alignment)', async () => {
        const e = setup({})
        applyFormat(e, golden.cases[0].action, { measure })
        expect(e.getStyle(0, 7)).toMatchObject({ align: 'center', numberFormat: 'general' })
        for (let c = 0; c < 10; c++) expect(e.getColWidth(c)).toBeGreaterThanOrEqual(30)
        expect(e.getColWidth(10)).toBeNull() // K is outside the table
    })
})

describe('format prompts on sales-large.tsv', () => {
    it('finds the totals row at 2,992 and applies every action in under 300 ms', async () => {
        const timings = []
        for (const c of golden.cases) {
            const e = createEngine(100000, 200)
            loadSampleLarge(e)
            expect(inspectSheet(e).totalsRow).toBe(2991) // row 2,992
            const t0 = performance.now()
            const res = applyFormat(e, c.action, { measure })
            const ms = performance.now() - t0
            timings.push(`${c.id} ${res.result} ${ms.toFixed(1)}ms`)
            expect(ms).toBeLessThan(300)
            if (c.id === 'f09') {
                expect(e.getStyle(2991, 0).bg).toBe('#ffff99')
                expect(e.getStyle(2990, 0).bg).toBe('white')
            }
            if (c.id === 'f01') {
                expect(e.getStyle(2991, 0).bold).toBe(true)
                expect(displayText(e.getCell(1, 7), e.getStyle(1, 7))).toBe('$499.00')
            }
        }
        console.log('sales-large format timings:', timings.join(', '))
    }, 60000)
})
