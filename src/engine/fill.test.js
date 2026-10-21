import { describe, it, expect } from 'vitest'
import { createSeries } from './fill.js'

const run = (seeds, from, to) => {
    const s = createSeries(seeds)
    const out = []
    for (let p = from; p <= to; p++) out.push(s(p))
    return out
}

describe('createSeries', () => {
    it('copies a single number or plain text', () => {
        expect(run(['5'], 1, 3)).toEqual(['5', '5', '5'])
        expect(run(['West'], 1, 2)).toEqual(['West', 'West'])
    })

    it('extends numeric series by their step, forward and backward', () => {
        expect(run(['1', '2'], 2, 4)).toEqual(['3', '4', '5'])
        expect(run(['10', '7'], 2, 3)).toEqual(['4', '1'])
        expect(run(['0.1', '0.2'], 2, 3)).toEqual(['0.3', '0.4'])
        expect(run(['1', '2'], -2, -1)).toEqual(['-1', '0'])
    })

    it('increments text ending in a number and keeps zero padding', () => {
        expect(run(['ORD-1001', 'ORD-1002'], 2, 4)).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        expect(run(['Item 1'], 1, 2)).toEqual(['Item 2', 'Item 3'])
        expect(run(['Q4'], 1, 1)).toEqual(['Q5'])
        expect(run(['2024-W01'], 1, 2)).toEqual(['2024-W02', '2024-W03'])
        expect(run(['A009'], 1, 2)).toEqual(['A010', 'A011'])
    })

    it('repeats seeds whose prefixes differ', () => {
        expect(run(['A1', 'B2'], 2, 3)).toEqual(['A1', 'B2'])
    })

    it('steps dates in days and keeps each seed format', () => {
        expect(run(['2024-01-15'], 1, 2)).toEqual(['2024-01-16', '2024-01-17'])
        expect(run(['1/15/2024', '1/22/2024'], 2, 3)).toEqual(['1/29/2024', '2/5/2024'])
        expect(run(['30 Jan 2024'], 1, 2)).toEqual(['31 Jan 2024', '1 Feb 2024'])
        // mixed formats: each new date copies the format of the seed it lines up with
        const out = run(['2024-01-01', '1/2/2024', '3 Jan 2024'], 3, 5)
        expect(out).toEqual(['2024-01-04', '1/5/2024', '6 Jan 2024'])
    })

    it('cycles weekday and month names preserving case', () => {
        expect(run(['Mon'], 1, 2)).toEqual(['Tue', 'Wed'])
        expect(run(['Sat', 'Sun'], 2, 3)).toEqual(['Mon', 'Tue'])
        expect(run(['JAN'], 1, 1)).toEqual(['FEB'])
        expect(run(['december'], 1, 1)).toEqual(['january'])
        expect(run(['Monday', 'Wednesday'], 2, 2)).toEqual(['Friday'])
        expect(run(['Mon'], -1, -1)).toEqual(['Sun'])
    })

    it('repeats formulas and mixed seeds unchanged (the engine translates formulas)', () => {
        expect(run(['=A1', 'x'], 2, 3)).toEqual(['=A1', 'x'])
        expect(run(['1', 'x'], 2, 3)).toEqual(['1', 'x'])
    })
})
