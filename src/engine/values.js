// How we read numbers, dates and text. Formulas, sort, filter and the AI
// executor all use these so they agree with each other. Follows
// AI_CONTRACT.md section 3.2.

export function norm(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

const NUM_BODY_RE = /^-?\d+(\.\d+)?$/

// "$1,200.00" -> 1200, "10%" -> 0.1, "$ 49.99" -> 49.99, "N/A" -> null
export function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v === null || v === undefined || typeof v === 'boolean') return null
    const s = String(v).trim()
    if (s === '') return null
    const percent = s.endsWith('%')
    const body = s.replace(/[$,%\s]/g, '')
    if (!NUM_BODY_RE.test(body)) return null
    const n = Number(body)
    return percent ? n / 100 : n
}

// Stricter than toNum: decides whether a typed value is a number at all.
// No $ or %, and unlike parseFloat, "12abc" is not 12.
const LITERAL_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
export function parseNumberLiteral(raw) {
    const s = String(raw).trim()
    if (!LITERAL_RE.test(s)) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
}

// Dates

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const US_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const DMY_RE = /^(\d{1,2}) ([A-Za-z]{3,}) (\d{4})$/

function monthFromName(name) {
    const lower = name.toLowerCase()
    for (let i = 0; i < 12; i++) {
        const long = MONTHS_LONG[i].toLowerCase()
        // "Jan", "Janu", "January" all work
        if (lower.length >= 3 && long.startsWith(lower)) return i + 1
    }
    return 0
}

function validYMD(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return d <= days
}

// Parses the three formats in the sample data (2024-01-15, 1/15/2024,
// 15 Jan 2024) and remembers the format, so fill can write new dates the
// same way.
export function parseDateParts(v) {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    let m = ISO_RE.exec(s)
    if (m) {
        const y = +m[1], mo = +m[2], d = +m[3]
        if (!validYMD(y, mo, d)) return null
        return { y, m: mo, d, format: { kind: 'iso', ...padding(m[2], m[3], true) } }
    }
    m = US_RE.exec(s)
    if (m) {
        const mo = +m[1], d = +m[2], y = +m[3]
        if (!validYMD(y, mo, d)) return null
        return { y, m: mo, d, format: { kind: 'us', ...padding(m[1], m[2], false) } }
    }
    m = DMY_RE.exec(s)
    if (m) {
        const d = +m[1], mo = monthFromName(m[2]), y = +m[3]
        if (!mo || !validYMD(y, mo, d)) return null
        const name = m[2]
        const long = name.length > 3
        const kase = name === name.toUpperCase() ? 'upper' : name === name.toLowerCase() ? 'lower' : 'title'
        return { y, m: mo, d, format: { kind: 'dmy', padD: m[1].startsWith('0'), long, kase } }
    }
    return null
}

const pad2 = (n) => String(n).padStart(2, '0')

// Is the date zero-padded? "05" yes, "5" no, "15" can't tell, so it
// follows the other part, or the format's usual style (ISO pads).
function padding(mText, dText, isoDefault) {
    const decide = (t) => (t.length === 1 ? false : t.startsWith('0') ? true : null)
    const pm = decide(mText)
    const pd = decide(dText)
    const fallback = pm ?? pd ?? isoDefault
    return { padM: pm ?? fallback, padD: pd ?? fallback }
}

// returns "YYYY-MM-DD" or null
export function toDate(v) {
    const p = parseDateParts(v)
    if (!p) return null
    return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
}

const MS_PER_DAY = 86400000

export function partsToDayNumber({ y, m, d }) {
    return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

export function dayNumberToParts(day) {
    const dt = new Date(day * MS_PER_DAY)
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function applyCase(text, kase) {
    if (kase === 'upper') return text.toUpperCase()
    if (kase === 'lower') return text.toLowerCase()
    return text
}

export function formatDateParts({ y, m, d }, format) {
    const pm = (n, pad) => (pad ? pad2(n) : String(n))
    if (format.kind === 'iso') return `${y}-${pm(m, format.padM)}-${pm(d, format.padD)}`
    if (format.kind === 'us') return `${pm(m, format.padM)}/${pm(d, format.padD)}/${y}`
    const name = format.long ? MONTHS_LONG[m - 1] : MONTHS_SHORT[m - 1]
    return `${pm(d, format.padD)} ${applyCase(name, format.kase)} ${y}`
}
