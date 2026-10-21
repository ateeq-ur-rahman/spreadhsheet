// Works out what a fill-handle drag should write.
//
// createSeries(seeds) takes the raw text of the seed cells along one line
// (a column for up/down, a row for left/right) and returns valueAt(p).
// Seeds are p = 0..n-1; dragging forward asks for p >= n, dragging
// backward for p < 0.
//
// What we recognise (every seed has to be the same kind):
//   numbers        1 seed copies, 2+ follow the trend
//   dates          1 seed is +1 day, 2+ follow the trend in days; each new
//                  cell borrows the format of seed p mod n
//   Mon / January  +1 or the trend, wrapping around, case from the seed
//   "ORD-1001"     same prefix, number counts up, zero padding kept
// Anything else (plain text, formulas, mixed) just repeats the seeds.
// The engine shifts formula references afterwards.

import {
    parseNumberLiteral, parseDateParts, formatDateParts,
    partsToDayNumber, dayNumberToParts, MONTHS_SHORT, MONTHS_LONG,
} from './values.js'

const WEEK_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEK_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const NAME_LISTS = { weekShort: WEEK_SHORT, weekLong: WEEK_LONG, monthShort: MONTHS_SHORT, monthLong: MONTHS_LONG }

const mod = (a, n) => ((a % n) + n) % n

// so 0.1 + 0.2 shows as 0.3
export function cleanNumber(v) {
    return parseFloat(v.toPrecision(12))
}

// best-fit line through the seeds; exact when the seeds are evenly spaced
export function linearTrend(ys) {
    const n = ys.length
    const xMean = (n - 1) / 2
    let yMean = 0
    for (const y of ys) yMean += y
    yMean /= n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (ys[i] - yMean)
        den += (i - xMean) * (i - xMean)
    }
    const slope = den === 0 ? 0 : num / den
    return (p) => yMean + slope * (p - xMean)
}

function caseOf(text) {
    if (text === text.toUpperCase()) return 'upper'
    if (text === text.toLowerCase()) return 'lower'
    return 'title'
}

function applyCase(text, kase) {
    if (kase === 'upper') return text.toUpperCase()
    if (kase === 'lower') return text.toLowerCase()
    return text
}

function parseName(raw) {
    const s = raw.trim()
    if (!/^[A-Za-z]+$/.test(s)) return null
    const lower = s.toLowerCase()
    const families = new Set()
    let index = -1
    for (const [family, list] of Object.entries(NAME_LISTS)) {
        const i = list.findIndex(x => x.toLowerCase() === lower)
        if (i >= 0) {
            families.add(family)
            index = i
        }
    }
    if (families.size === 0) return null
    // only "May" shows up in two lists, at the same index in both
    return { families, index, kase: caseOf(s) }
}

const TEXT_NUM_RE = /^(.*?)(\d+)$/

function parseTextNumber(raw) {
    const m = TEXT_NUM_RE.exec(raw)
    if (!m || m[1] === '') return null
    return { prefix: m[1], digits: m[2], n: parseInt(m[2], 10) }
}

function classify(raw) {
    if (raw === '' || raw.startsWith('=')) return null
    const num = parseNumberLiteral(raw)
    if (num !== null) return { kind: 'number', num, raw }
    const date = parseDateParts(raw)
    if (date) return { kind: 'date', date }
    const name = parseName(raw)
    if (name) return { kind: 'name', name }
    const tn = parseTextNumber(raw)
    if (tn) return { kind: 'textnum', tn }
    return null
}

function cyclic(seeds) {
    return (p) => seeds[mod(p, seeds.length)]
}

export function createSeries(seeds) {
    const n = seeds.length
    if (n === 0) return () => ''
    const info = seeds.map(classify)
    if (info.some(x => x === null)) return cyclic(seeds)
    const kind = info[0].kind
    if (info.some(x => x.kind !== kind)) return cyclic(seeds)

    if (kind === 'number') {
        if (n === 1) return cyclic(seeds)
        const trend = linearTrend(info.map(x => x.num))
        return (p) => (p >= 0 && p < n ? seeds[p] : String(cleanNumber(trend(p))))
    }

    if (kind === 'date') {
        const days = info.map(x => partsToDayNumber(x.date))
        const trend = n === 1 ? (p) => days[0] + p : linearTrend(days)
        return (p) => {
            if (p >= 0 && p < n) return seeds[p]
            const parts = dayNumberToParts(Math.round(trend(p)))
            return formatDateParts(parts, info[mod(p, n)].date.format)
        }
    }

    if (kind === 'name') {
        // pick a list every seed belongs to
        const common = [...info[0].name.families].filter(f => info.every(x => x.name.families.has(f)))
        if (common.length === 0) return cyclic(seeds)
        const list = NAME_LISTS[common[0]]
        const L = list.length
        // treat Sat, Sun, Mon as 5, 6, 7 rather than 5, 6, 0
        const idx = [info[0].name.index]
        for (let i = 1; i < n; i++) idx.push(idx[i - 1] + mod(info[i].name.index - info[i - 1].name.index, L))
        const trend = n === 1 ? (p) => idx[0] + p : linearTrend(idx)
        return (p) => {
            if (p >= 0 && p < n) return seeds[p]
            const word = list[mod(Math.round(trend(p)), L)]
            return applyCase(word, info[mod(p, n)].name.kase)
        }
    }

    // text + trailing number
    const prefix = info[0].tn.prefix
    if (info.some(x => x.tn.prefix !== prefix)) return cyclic(seeds)
    const padded = info.some(x => x.tn.digits.length > 1 && x.tn.digits.startsWith('0'))
    const width = padded ? Math.max(...info.map(x => x.tn.digits.length)) : 0
    const nums = info.map(x => x.tn.n)
    const trend = n === 1 ? (p) => nums[0] + p : linearTrend(nums)
    return (p) => {
        if (p >= 0 && p < n) return seeds[p]
        const v = Math.abs(Math.round(trend(p)))
        return prefix + String(v).padStart(width, '0')
    }
}
