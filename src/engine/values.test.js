import { describe, it, expect } from 'vitest'
import { toNum, toDate, norm, parseNumberLiteral, parseDateParts, formatDateParts } from './values.js'

describe('values (AI_CONTRACT §3.2)', () => {
    it('toNum', () => {
        expect(toNum('$1,200.00')).toBe(1200)
        expect(toNum('10%')).toBe(0.1)
        expect(toNum('0.1')).toBe(0.1)
        expect(toNum('$ 49.99')).toBe(49.99)
        expect(toNum('-5')).toBe(-5)
        expect(toNum('N/A')).toBeNull()
        expect(toNum('n/a')).toBeNull()
        expect(toNum('')).toBeNull()
        expect(toNum('12abc')).toBeNull()
        expect(toNum(42)).toBe(42)
    })

    it('toDate accepts the three sample formats', () => {
        expect(toDate('2024-01-15')).toBe('2024-01-15')
        expect(toDate('2024-1-5')).toBe('2024-01-05')
        expect(toDate('1/15/2024')).toBe('2024-01-15')
        expect(toDate('15 Jan 2024')).toBe('2024-01-15')
        expect(toDate('15 January 2024')).toBe('2024-01-15')
        expect(toDate('2024-02-30')).toBeNull()
        expect(toDate('Jan 15 2024')).toBeNull()
    })

    it('norm trims and lower-cases', () => {
        expect(norm('  West ')).toBe('west')
    })

    it('parseNumberLiteral is strict', () => {
        expect(parseNumberLiteral('12')).toBe(12)
        expect(parseNumberLiteral('1e3')).toBe(1000)
        expect(parseNumberLiteral('12abc')).toBeNull()
        expect(parseNumberLiteral('$5')).toBeNull()
    })

    it('round-trips date formats including padding', () => {
        for (const s of ['2024-01-15', '2024-1-5', '1/15/2024', '01/05/2024', '15 Jan 2024', '5 JAN 2024']) {
            const p = parseDateParts(s)
            expect(formatDateParts(p, p.format)).toBe(s)
        }
    })
})
