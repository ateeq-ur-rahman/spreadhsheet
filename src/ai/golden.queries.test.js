// All 20 cases in fixtures/ai-eval/queries.json, through the same path the
// panel uses: mock provider -> extract JSON -> validate -> execute over
// sales-large.tsv loaded into the engine. Compared the way AI_CONTRACT 5
// says graders compare: columns exact, numbers within 0.01, row order only
// when the plan sorts, error codes exact.
import { describe, it, expect, beforeAll } from 'vitest'
import golden from '../../fixtures/ai-eval/queries.json'
import { createEngine } from '../engine/core.js'
import { loadSampleLarge } from '../fixtures/loadSample.js'
import { createMockProvider } from './mockProvider.js'
import { requestAction } from './pipeline.js'
import { readTable } from './sheetTable.js'
import { buildContext } from './context.js'
import { executeQuery } from './executor.js'

let engine
const timings = []

beforeAll(() => {
    engine = createEngine(100000, 200)
    loadSampleLarge(engine)
})

const close = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.01 : a === b)
const sameRow = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]))

function expectRows(actual, expected, ordered) {
    expect(actual.length).toBe(expected.length)
    if (ordered) {
        actual.forEach((row, i) => expect(sameRow(row, expected[i]), `row ${i}: ${JSON.stringify(row)} vs ${JSON.stringify(expected[i])}`).toBe(true))
    } else {
        // unsorted results: every expected row has a match
        const left = [...actual]
        for (const want of expected) {
            const at = left.findIndex(row => sameRow(row, want))
            expect(at, `missing row ${JSON.stringify(want)}`).toBeGreaterThanOrEqual(0)
            left.splice(at, 1)
        }
    }
}

describe('golden queries (sales-large.tsv)', () => {
    for (const c of golden.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const provider = createMockProvider()
            const table = readTable(engine)
            const context = buildContext(table, null)
            const answer = await requestAction({ provider, prompt: c.prompt, context })

            // the mock returns exactly the golden plan (wrapped in prose / fences)
            expect(answer.action).toEqual(c.plan)

            const t0 = performance.now()
            let result
            if (answer.kind === 'error') result = { error: answer.error, detail: answer.detail }
            else result = executeQuery(answer.action, readTable(engine))
            timings.push({ id: c.id, ms: performance.now() - t0 })

            const want = c.expect
            if (want.error) {
                expect(result.error).toBe(want.error)
                if (want.detail) expect(result.detail).toBe(want.detail)
                return
            }
            expect(result.error).toBeUndefined()
            expect(result.columns).toEqual(want.columns)
            expect(result.rowCount).toBe(want.rowCount)
            expect(result.truncated).toBe(want.truncated)
            const ordered = Boolean(c.plan.sort?.length)
            if (want.rows) expectRows(result.rows, want.rows, ordered)
            if (want.rowsPreview) expectRows(result.rows.slice(0, want.rowsPreview.length), want.rowsPreview, true)
        })
    }

    it('every golden plan (table read + execute) runs in under 50 ms', () => {
        const slowest = timings.reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0 })
        console.log('golden plan timings (ms):', timings.map(t => `${t.id} ${t.ms.toFixed(1)}`).join(', '))
        expect(timings.length).toBe(golden.cases.length)
        expect(slowest.ms).toBeLessThan(50)
    })
})
