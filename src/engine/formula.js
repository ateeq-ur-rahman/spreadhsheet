// Formulas: tokenizer, parser, evaluator, and the code that rewrites
// references when you fill or insert/delete rows.
//
// Grammar, lowest precedence first:
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := ('-' | '+') unary | primary
//   primary := NUMBER | REF (':' REF)? | '#REF!' | NAME '(' args? ')' | '(' expr ')'
//   args    := expr (',' expr)*

import { refToString } from './address.js'
import { toNum } from './values.js'

export const ERR = Object.freeze({
    PARSE: '#PARSE!',
    REF: '#REF!',
    VALUE: '#VALUE!',
    DIV0: '#DIV/0!',
    NAME: '#NAME?',
    CYCLE: '#CYCLE!',
})

export class FormulaError extends Error {
    constructor(code) {
        super(code)
        this.code = code
    }
}

export const isFormula = (raw) => typeof raw === 'string' && raw.startsWith('=')

// Tokenizer

const REF_RE = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/y
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.]*/y
const NUM_RE = /(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/y

// Tokens keep their start/end positions in the source string, so when we
// rewrite references we can splice into the original text and leave the
// user's spacing and casing alone.
export function tokenize(src, from = 0) {
    const tokens = []
    let i = from
    while (i < src.length) {
        const ch = src[i]
        if (ch === ' ' || ch === '\t') { i++; continue }
        if ('+-*/(),:'.includes(ch)) {
            tokens.push({ type: ch, start: i, end: i + 1 })
            i++
            continue
        }
        if (src.startsWith('#REF!', i)) {
            tokens.push({ type: 'err', code: ERR.REF, start: i, end: i + 5 })
            i += 5
            continue
        }
        if ((ch >= '0' && ch <= '9') || ch === '.') {
            NUM_RE.lastIndex = i
            const m = NUM_RE.exec(src)
            if (!m) throw new FormulaError(ERR.PARSE)
            tokens.push({ type: 'num', value: Number(m[0]), start: i, end: i + m[0].length })
            i += m[0].length
            continue
        }
        REF_RE.lastIndex = i
        const ref = REF_RE.exec(src)
        if (ref) {
            const row = parseInt(ref[4], 10) - 1
            if (row < 0) throw new FormulaError(ERR.PARSE)
            tokens.push({
                type: 'ref', start: i, end: i + ref[0].length,
                ref: { row, col: lettersToColFast(ref[2]), absCol: ref[1] === '$', absRow: ref[3] === '$' },
            })
            i += ref[0].length
            continue
        }
        IDENT_RE.lastIndex = i
        const id = IDENT_RE.exec(src)
        if (id) {
            tokens.push({ type: 'name', value: id[0].toUpperCase(), start: i, end: i + id[0].length })
            i += id[0].length
            continue
        }
        throw new FormulaError(ERR.PARSE)
    }
    return tokens
}

function lettersToColFast(letters) {
    let index = 0
    for (let i = 0; i < letters.length; i++) index = index * 26 + ((letters.charCodeAt(i) & ~32) - 64)
    return index - 1
}

// Parser

export const FUNCTIONS = Object.freeze(['SUM', 'AVG', 'AVERAGE', 'MIN', 'MAX', 'COUNT'])

// Parse "=...". Gives back { ast, refs, ranges } (refs/ranges feed the
// dependency index) or { error } if the formula doesn't parse.
export function parseFormula(raw) {
    try {
        const tokens = tokenize(raw, 1)
        if (tokens.length === 0) return { error: ERR.PARSE }
        const refs = []
        const ranges = []
        let pos = 0
        const peek = () => tokens[pos]
        const take = (type) => {
            const t = tokens[pos]
            if (!t || (type && t.type !== type)) throw new FormulaError(ERR.PARSE)
            pos++
            return t
        }

        const expr = () => {
            let node = term()
            while (peek() && (peek().type === '+' || peek().type === '-')) {
                const op = take().type
                node = { t: 'bin', op, a: node, b: term() }
            }
            return node
        }
        const term = () => {
            let node = unary()
            while (peek() && (peek().type === '*' || peek().type === '/')) {
                const op = take().type
                node = { t: 'bin', op, a: node, b: unary() }
            }
            return node
        }
        const unary = () => {
            const t = peek()
            if (t && t.type === '-') { take(); return { t: 'neg', e: unary() } }
            if (t && t.type === '+') { take(); return unary() }
            return primary()
        }
        const primary = () => {
            const t = take()
            if (t.type === 'num') return { t: 'num', v: t.value }
            if (t.type === 'err') return { t: 'err', code: t.code }
            if (t.type === 'ref') {
                if (peek() && peek().type === ':') {
                    take(':')
                    const end = take('ref').ref
                    const range = {
                        r1: Math.min(t.ref.row, end.row), c1: Math.min(t.ref.col, end.col),
                        r2: Math.max(t.ref.row, end.row), c2: Math.max(t.ref.col, end.col),
                    }
                    ranges.push(range)
                    return { t: 'range', ...range }
                }
                refs.push({ row: t.ref.row, col: t.ref.col })
                return { t: 'ref', row: t.ref.row, col: t.ref.col }
            }
            if (t.type === 'name') {
                take('(')
                const args = []
                if (peek() && peek().type !== ')') {
                    args.push(expr())
                    while (peek() && peek().type === ',') { take(','); args.push(expr()) }
                }
                take(')')
                if (!FUNCTIONS.includes(t.value)) throw new FormulaError(ERR.NAME)
                return { t: 'fn', name: t.value, args }
            }
            if (t.type === '(') {
                const node = expr()
                take(')')
                return node
            }
            throw new FormulaError(ERR.PARSE)
        }

        const ast = expr()
        if (pos !== tokens.length) return { error: ERR.PARSE }
        return { ast, refs, ranges }
    } catch (e) {
        if (e instanceof FormulaError) return { error: e.code }
        throw e
    }
}

// Evaluator

// errors are stored as { error: '#REF!' } etc.
export const isErrorValue = (v) => typeof v === 'object' && v !== null && typeof v.error === 'string'

// blank counts as 0, and text like "$1,200.00" or "10%" is read as a number
function toOperand(v) {
    if (isErrorValue(v)) throw new FormulaError(v.error)
    if (v === '' || v === null || v === undefined) return 0
    if (typeof v === 'number') return v
    const n = toNum(v)
    if (n === null) throw new FormulaError(ERR.VALUE)
    return n
}

// valueAt(row, col) returns a cell's computed value. Errors are thrown as
// FormulaError and caught by the engine.
export function evaluate(node, valueAt) {
    switch (node.t) {
        case 'num': return node.v
        case 'err': throw new FormulaError(node.code)
        case 'ref': {
            const v = valueAt(node.row, node.col)
            if (isErrorValue(v)) throw new FormulaError(v.error)
            return v === undefined || v === null ? '' : v
        }
        case 'range': throw new FormulaError(ERR.VALUE)
        case 'neg': return -toOperand(evaluate(node.e, valueAt))
        case 'bin': {
            const a = toOperand(evaluate(node.a, valueAt))
            const b = toOperand(evaluate(node.b, valueAt))
            switch (node.op) {
                case '+': return a + b
                case '-': return a - b
                case '*': return a * b
                case '/':
                    if (b === 0) throw new FormulaError(ERR.DIV0)
                    return a / b
                default: throw new FormulaError(ERR.VALUE)
            }
        }
        case 'fn': return evaluateFunction(node, valueAt)
        default: throw new FormulaError(ERR.VALUE)
    }
}

// SUM/AVG/etc. skip blanks and text that isn't a number
function collectNumbers(args, valueAt) {
    const out = []
    const take = (v) => {
        if (isErrorValue(v)) throw new FormulaError(v.error)
        if (typeof v === 'number') { out.push(v); return }
        const n = toNum(v)
        if (n !== null) out.push(n)
    }
    for (const arg of args) {
        if (arg.t === 'range') {
            for (let r = arg.r1; r <= arg.r2; r++) {
                for (let c = arg.c1; c <= arg.c2; c++) take(valueAt(r, c))
            }
        } else {
            take(evaluate(arg, valueAt))
        }
    }
    return out
}

function evaluateFunction(node, valueAt) {
    const nums = collectNumbers(node.args, valueAt)
    switch (node.name) {
        case 'SUM': {
            let s = 0
            for (const n of nums) s += n
            return s
        }
        case 'AVG':
        case 'AVERAGE': {
            if (nums.length === 0) throw new FormulaError(ERR.DIV0)
            let s = 0
            for (const n of nums) s += n
            return s / nums.length
        }
        case 'MIN': {
            if (nums.length === 0) return 0
            let m = Infinity
            for (const n of nums) if (n < m) m = n
            return m
        }
        case 'MAX': {
            if (nums.length === 0) return 0
            let m = -Infinity
            for (const n of nums) if (n > m) m = n
            return m
        }
        case 'COUNT': return nums.length
        default: throw new FormulaError(ERR.NAME)
    }
}

// Reference rewriting

// Rebuild the formula text, passing every reference and range through the
// callbacks. Returning null means "this cell is gone" and we write #REF!.
// Returns the same string if nothing changed; bad formulas are left as is.
export function rewriteReferences(raw, onRef, onRange) {
    if (!isFormula(raw)) return raw
    let tokens
    try {
        tokens = tokenize(raw, 1)
    } catch {
        return raw
    }
    let out = ''
    let last = 0
    let changed = false
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.type !== 'ref') continue
        const isRange = tokens[i + 1]?.type === ':' && tokens[i + 2]?.type === 'ref'
        let text
        let end
        if (isRange) {
            const res = onRange(t.ref, tokens[i + 2].ref)
            text = res ? refToString(res[0]) + ':' + refToString(res[1]) : ERR.REF
            end = tokens[i + 2].end
            i += 2
        } else {
            const res = onRef(t.ref)
            text = res ? refToString(res) : ERR.REF
            end = t.end
        }
        const original = raw.slice(t.start, end)
        if (text !== original) changed = true
        out += raw.slice(last, t.start) + text
        last = end
    }
    if (!changed) return raw
    return out + raw.slice(last)
}

// Used by fill: move references by (dRow, dCol) except the $-pinned parts.
// translateFormula('=$G$2*H2', 30, 0) -> '=$G$2*H32'
export function translateFormula(raw, dRow, dCol) {
    if (dRow === 0 && dCol === 0) return raw
    const shift = (ref) => {
        const row = ref.absRow ? ref.row : ref.row + dRow
        const col = ref.absCol ? ref.col : ref.col + dCol
        if (row < 0 || col < 0) return null
        return { ...ref, row, col }
    }
    return rewriteReferences(raw, shift, (a, b) => {
        const s = shift(a)
        const e = shift(b)
        return s && e ? [s, e] : null
    })
}

// Where an index ends up after inserting/deleting `count` rows at `at`.
// index() returns -1 for deleted rows; span() returns null if a whole
// range was deleted.
export function structuralMapper(kind, at, count) {
    if (kind === 'insert') {
        return {
            index: (i) => (i >= at ? i + count : i),
            span: (lo, hi) => [lo >= at ? lo + count : lo, hi >= at ? hi + count : hi],
        }
    }
    const endEx = at + count
    return {
        index: (i) => (i < at ? i : i >= endEx ? i - count : -1),
        span: (lo, hi) => {
            if (lo >= at && hi < endEx) return null // the whole span was deleted
            const nlo = lo < at ? lo : lo >= endEx ? lo - count : at
            const nhi = hi < at ? hi : hi >= endEx ? hi - count : at - 1
            return [nlo, nhi]
        },
    }
}

// Rewrite references after an insert/delete. Unlike fill, $ refs move
// too, because they should keep pointing at the same cell.
export function remapFormulaStructural(raw, axis, kind, at, count) {
    const map = structuralMapper(kind, at, count)
    const key = axis === 'row' ? 'row' : 'col'
    return rewriteReferences(
        raw,
        (ref) => {
            const n = map.index(ref[key])
            return n < 0 ? null : { ...ref, [key]: n }
        },
        (a, b) => {
            const lo = Math.min(a[key], b[key])
            const hi = Math.max(a[key], b[key])
            const span = map.span(lo, hi)
            if (!span) return null
            const aIsLo = a[key] <= b[key]
            return [
                { ...a, [key]: aIsLo ? span[0] : span[1] },
                { ...b, [key]: aIsLo ? span[1] : span[0] },
            ]
        },
    )
}

// Used by sort: rows inside the sorted block move, so single references
// follow the row they pointed at (mapRow gives the new row). Ranges are left
// exactly as written, so =SUM(J2:J32) still covers the same block.
export function remapFormulaRows(raw, mapRow) {
    return rewriteReferences(raw, (ref) => ({ ...ref, row: mapRow(ref.row) }), (a, b) => [a, b])
}
