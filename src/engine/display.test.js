// The display table from AI_CONTRACT 4, cell by cell. "unchanged" means
// the cell shows what it shows with no format at all.
import { describe, it, expect } from 'vitest'
import { formatValue, displayText } from './display.js'

const inputs = [79, '$1,200.00', 0.1, '10%', 'n/a', '2024-01-15', '1/15/2024', '15 Jan 2024']
const U = 'unchanged'
const table = {
    number: ['79.00', '1,200.00', '0.10', '0.10', 'n/a', U, U, U],
    currency: ['$79.00', '$1,200.00', '$0.10', '$0.10', 'n/a', U, U, U],
    percent: ['7900%', '120000%', '10%', '10%', 'n/a', U, U, U],
    date: [U, U, U, U, 'n/a', '2024-01-15', '2024-01-15', '2024-01-15'],
}

describe('number formats follow the contract table', () => {
    for (const [fmt, row] of Object.entries(table)) {
        inputs.forEach((value, i) => {
            const want = row[i] === U ? formatValue(value, 'general') : row[i]
            it(`${fmt}(${JSON.stringify(value)}) -> ${want}`, () => {
                expect(formatValue(value, fmt)).toBe(want)
            })
        })
    }
})

describe('the edges around it', () => {
    it('blank stays blank in every format', () => {
        for (const fmt of ['general', 'number', 'currency', 'percent', 'date']) {
            expect(formatValue('', fmt)).toBe('')
            expect(formatValue(null, fmt)).toBe('')
        }
    })
    it('a space after the dollar sign still reads as money', () => {
        expect(formatValue('$ 49.99', 'currency')).toBe('$49.99')
    })
    it('negative currency puts the sign before the dollar', () => {
        expect(formatValue(-12.5, 'currency')).toBe('-$12.50')
    })
    it('errors win over the format', () => {
        expect(displayText({ computed: null, error: '#DIV/0!' }, { numberFormat: 'currency' })).toBe('#DIV/0!')
    })
    it('no style means general', () => {
        expect(displayText({ computed: 0.1 }, null)).toBe('0.1')
    })
})
