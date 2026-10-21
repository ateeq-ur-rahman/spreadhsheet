// A1 notation helpers. Rows and columns are zero-based, so (0, 0) is A1.
// Ranges are { r1, c1, r2, c2 }, inclusive, with r1 <= r2 and c1 <= c2.

export function colToLetters(col) {
    let label = ''
    let n = col + 1
    while (n > 0) {
        n--
        label = String.fromCharCode(65 + (n % 26)) + label
        n = Math.floor(n / 26)
    }
    return label
}

export function lettersToCol(letters) {
    let index = 0
    const up = letters.toUpperCase()
    for (let i = 0; i < up.length; i++) index = index * 26 + (up.charCodeAt(i) - 64)
    return index - 1
}

export function toA1(row, col) {
    return colToLetters(col) + (row + 1)
}

// {row:1, col:6, absRow:true, absCol:true} -> "$G$2"
export function refToString({ row, col, absRow = false, absCol = false }) {
    return (absCol ? '$' : '') + colToLetters(col) + (absRow ? '$' : '') + (row + 1)
}

const CELL_RE = /^\s*(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})\s*$/

export function parseA1(text) {
    const m = CELL_RE.exec(String(text))
    if (!m) return null
    const row = parseInt(m[4], 10) - 1
    if (row < 0) return null
    return { row, col: lettersToCol(m[2]), absCol: m[1] === '$', absRow: m[3] === '$' }
}

// "A1" or "K2:K100000"
export function parseRange(text) {
    const parts = String(text).split(':')
    if (parts.length === 1) {
        const a = parseA1(parts[0])
        return a ? { r1: a.row, c1: a.col, r2: a.row, c2: a.col } : null
    }
    if (parts.length !== 2) return null
    const a = parseA1(parts[0])
    const b = parseA1(parts[1])
    if (!a || !b) return null
    return normalizeRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col })
}

export function normalizeRange({ r1, c1, r2, c2 }) {
    return {
        r1: Math.min(r1, r2), c1: Math.min(c1, c2),
        r2: Math.max(r1, r2), c2: Math.max(c1, c2),
    }
}

export function rangeToA1(range) {
    const a = toA1(range.r1, range.c1)
    if (range.r1 === range.r2 && range.c1 === range.c2) return a
    return a + ':' + toA1(range.r2, range.c2)
}

export function rangeContains(range, row, col) {
    return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2
}

export function rangeSize(range) {
    return (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
}
