// Spreadsheet engine. Plain JS, no React or DOM in here.
//
// Cells are keyed by a number (row * MAX_COLS + col) instead of "A1"
// strings. Every change goes through a small op (cell / style / struct)
// that records its own inverse, and a transaction groups those ops into
// one undo step. After each transaction we recalc only the touched cells
// and whatever depends on them. See DESIGN_NOTES.md for the full picture.

import {
    parseFormula, evaluate, isFormula, isErrorValue, FormulaError, ERR,
    translateFormula, remapFormulaStructural, structuralMapper,
} from './formula.js'
import { parseNumberLiteral } from './values.js'
import { normalizeRange } from './address.js'
import { createSeries } from './fill.js'

export const MAX_COLS = 16384
const MAX_UNDO_HISTORY = 100

export const DEFAULT_STYLE = Object.freeze({
    bold: false,
    italic: false,
    underline: false,
    bg: 'white',
    color: '#202124',
    align: 'left',
    fontSize: 13,
    numberFormat: 'general',
})
const STYLE_KEYS = Object.keys(DEFAULT_STYLE)

const keyOf = (row, col) => row * MAX_COLS + col
const rowOf = (key) => Math.floor(key / MAX_COLS)
const colOf = (key) => key % MAX_COLS

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    let version = 0

    const cells = new Map()
    const computed = new Map()
    const styles = new Map()
    const refDeps = new Map()
    const rangeDeps = new Map()
    const rangeCols = new Map()

    const undoStack = []
    const redoStack = []
    const listeners = new Set()
    // current transaction: { label, inverse, dirty }
    let tx = null

    // cached used range; any content write sets usedRangeVersion back to -1
    let usedRangeCache = null
    let usedRangeVersion = -1

    // Identical styles share one frozen object, so formatting 100k cells
    // the same way doesn't create 100k objects.

    const styleIntern = new Map()
    function internStyle(style) {
        let isDefault = true
        let sig = ''
        for (const k of STYLE_KEYS) {
            const v = style[k] === undefined ? DEFAULT_STYLE[k] : style[k]
            if (v !== DEFAULT_STYLE[k]) isDefault = false
            sig += v + '|'
        }
        if (isDefault) return null
        let s = styleIntern.get(sig)
        if (!s) {
            const full = {}
            for (const k of STYLE_KEYS) full[k] = style[k] === undefined ? DEFAULT_STYLE[k] : style[k]
            s = Object.freeze(full)
            styleIntern.set(sig, s)
        }
        return s
    }

    // Dependency index

    function indexFormula(key, f) {
        if (!f || f.error) return
        for (const ref of f.refs) {
            const rk = keyOf(ref.row, ref.col)
            let set = refDeps.get(rk)
            if (!set) refDeps.set(rk, (set = new Set()))
            set.add(key)
        }
        if (f.ranges.length) {
            rangeDeps.set(key, f.ranges)
            for (const rg of f.ranges) {
                for (let c = rg.c1; c <= rg.c2; c++) {
                    let set = rangeCols.get(c)
                    if (!set) rangeCols.set(c, (set = new Set()))
                    set.add(key)
                }
            }
        }
    }

    function unindexFormula(key, f) {
        if (!f || f.error) return
        for (const ref of f.refs) {
            const rk = keyOf(ref.row, ref.col)
            const set = refDeps.get(rk)
            if (set) {
                set.delete(key)
                if (set.size === 0) refDeps.delete(rk)
            }
        }
        if (f.ranges.length) {
            rangeDeps.delete(key)
            for (const rg of f.ranges) {
                for (let c = rg.c1; c <= rg.c2; c++) {
                    const set = rangeCols.get(c)
                    if (set) {
                        set.delete(key)
                        if (set.size === 0) rangeCols.delete(c)
                    }
                }
            }
        }
    }

    function rebuildIndex() {
        refDeps.clear()
        rangeDeps.clear()
        rangeCols.clear()
        for (const [key, cell] of cells) if (cell.f) indexFormula(key, cell.f)
    }

    // formulas that read this cell, directly or via a range
    function dependentsOf(key) {
        const out = []
        const direct = refDeps.get(key)
        if (direct) for (const d of direct) out.push(d)
        const byCol = rangeCols.get(colOf(key))
        if (byCol) {
            const r = rowOf(key)
            const c = colOf(key)
            for (const fk of byCol) {
                for (const rg of rangeDeps.get(fk)) {
                    if (r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2) { out.push(fk); break }
                }
            }
        }
        return out
    }

    // Recalculation

    function valueOfCell(key) {
        const cell = cells.get(key)
        if (!cell) return ''
        if (cell.f) return computed.get(key) ?? { error: ERR.CYCLE }
        return cell.value
    }

    // Recalc `roots` plus everything downstream. We DFS over dependents with
    // an explicit stack (long chains would blow the call stack otherwise) and
    // evaluate in reverse post-order, i.e. dependencies first. If a formula
    // reads a cell that's still pending, we're in a cycle -> #CYCLE!.
    function recalc(roots) {
        if (roots.size === 0) return
        const visited = new Set()
        const post = []
        for (const root of roots) {
            if (visited.has(root)) continue
            visited.add(root)
            const stack = [[root, dependentsOf(root), 0]]
            while (stack.length) {
                const frame = stack[stack.length - 1]
                if (frame[2] < frame[1].length) {
                    const next = frame[1][frame[2]++]
                    if (!visited.has(next)) {
                        visited.add(next)
                        stack.push([next, dependentsOf(next), 0])
                    }
                } else {
                    post.push(frame[0])
                    stack.pop()
                }
            }
        }
        const pending = new Set(post)
        const valueAt = (r, c) => {
            const k = keyOf(r, c)
            if (pending.has(k) && cells.get(k)?.f) return { error: ERR.CYCLE }
            return valueOfCell(k)
        }
        for (let i = post.length - 1; i >= 0; i--) {
            const key = post[i]
            const cell = cells.get(key)
            if (cell && cell.f) {
                // key stays pending until it's evaluated, so =A1+1 in A1 hits the cycle check
                let v
                if (cell.f.error) v = { error: cell.f.error }
                else {
                    try {
                        v = evaluate(cell.f.ast, valueAt)
                        if (typeof v === 'number' && !Number.isFinite(v)) v = { error: ERR.VALUE }
                    } catch (e) {
                        if (!(e instanceof FormulaError)) throw e
                        v = { error: e.code }
                    }
                }
                computed.set(key, v)
            } else {
                computed.delete(key)
            }
            pending.delete(key)
        }
    }

    // Primitive ops. Each one records how to undo itself

    function record(op) {
        tx.inverse.push(op)
    }

    function writeRaw(row, col, raw) {
        const key = keyOf(row, col)
        const old = cells.get(key)
        const oldRaw = old ? old.raw : ''
        const next = raw === null || raw === undefined ? '' : String(raw)
        const isEmpty = next.trim() === ''
        if (isEmpty ? oldRaw === '' : oldRaw === next) return
        record({ t: 'cell', row, col, raw: oldRaw })
        usedRangeVersion = -1
        if (old && old.f) unindexFormula(key, old.f)
        if (isEmpty) {
            cells.delete(key)
        } else if (isFormula(next)) {
            const f = parseFormula(next)
            cells.set(key, { raw: next, value: null, f })
            indexFormula(key, f)
        } else {
            const n = parseNumberLiteral(next)
            cells.set(key, { raw: next, value: n === null ? next : n })
        }
        tx.dirty.add(key)
    }

    function writeStyle(row, col, style) {
        const key = keyOf(row, col)
        const old = styles.get(key) || null
        const next = style ? internStyle(style) : null
        if (old === next) return
        record({ t: 'style', row, col, style: old })
        if (next) styles.set(key, next)
        else styles.delete(key)
    }

    function remapKeyedMap(map, axis, mapper, onDropped) {
        const entries = Array.from(map)
        map.clear()
        for (const [key, val] of entries) {
            const r = rowOf(key)
            const c = colOf(key)
            const idx = mapper.index(axis === 'row' ? r : c)
            if (idx < 0) {
                if (onDropped) onDropped(r, c, val)
                continue
            }
            map.set(axis === 'row' ? keyOf(idx, c) : keyOf(r, idx), val)
        }
    }

    // Insert/delete rows or columns. Formula text gets rewritten (absolute refs
    // too), cells and styles move, and only formulas whose text changed get
    // recalculated. Undoing a delete = insert again, then put back the deleted
    // cells/styles and the original text of every formula we rewrote.
    function structural(axis, kind, at, count) {
        const mapper = structuralMapper(kind, at, count)
        const restoreCells = []
        const restoreStyles = []
        const rewritten = new Map() // pre-op key → pre-op raw of formulas whose text changed
        usedRangeVersion = -1

        // rewrite formula text first, while keys still point at the old positions
        for (const [key, cell] of cells) {
            if (!cell.f) continue
            const next = remapFormulaStructural(cell.raw, axis, kind, at, count)
            if (next !== cell.raw) {
                rewritten.set(key, cell.raw)
                cell.raw = next
                cell.f = parseFormula(next)
                cell.changed = true
            }
        }

        const deletedKeys = new Set()
        remapKeyedMap(cells, axis, mapper, (row, col, cell) => {
            const key = keyOf(row, col)
            deletedKeys.add(key)
            restoreCells.push({ row, col, raw: rewritten.has(key) ? rewritten.get(key) : cell.raw })
        })
        remapKeyedMap(styles, axis, mapper, (row, col, style) => restoreStyles.push({ row, col, style }))
        remapKeyedMap(computed, axis, mapper)

        const oldDirty = Array.from(tx.dirty)
        tx.dirty.clear()
        for (const key of oldDirty) {
            const r = rowOf(key)
            const c = colOf(key)
            const idx = mapper.index(axis === 'row' ? r : c)
            if (idx >= 0) tx.dirty.add(axis === 'row' ? keyOf(idx, c) : keyOf(r, idx))
        }
        for (const [key, cell] of cells) {
            if (cell.changed) {
                delete cell.changed
                tx.dirty.add(key)
            }
        }

        if (axis === 'row') rows += kind === 'insert' ? count : -count
        else cols += kind === 'insert' ? count : -count
        rebuildIndex()

        if (kind === 'insert') {
            record({ t: 'struct', axis, kind: 'delete', at, count })
        } else {
            // undo replays these backwards, so the insert has to go in last
            for (const [key, raw] of rewritten) {
                if (!deletedKeys.has(key)) record({ t: 'cell', row: rowOf(key), col: colOf(key), raw })
            }
            for (const c of restoreCells) record({ t: 'cell', row: c.row, col: c.col, raw: c.raw })
            for (const s of restoreStyles) record({ t: 'style', row: s.row, col: s.col, style: s.style })
            record({ t: 'struct', axis, kind: 'insert', at, count })
        }
    }

    function applyOp(op) {
        switch (op.t) {
            case 'cell': return writeRaw(op.row, op.col, op.raw)
            case 'style': return writeStyle(op.row, op.col, op.style)
            case 'struct': return structural(op.axis, op.kind, op.at, op.count)
            // placeholder so an action that changed nothing still gets an undo step
            case 'noop': return record(op)
            default: throw new Error('Unknown op ' + op.t)
        }
    }

    // Transactions

    function notify() {
        version++
        for (const fn of listeners) fn()
    }

    function rollback(t) {
        const saved = tx
        tx = { label: 'rollback', inverse: [], dirty: t.dirty }
        for (let i = t.inverse.length - 1; i >= 0; i--) applyOp(t.inverse[i])
        tx = saved
    }

    // Run fn as a single undo step. Nested calls just join the outer one.
    // If fn throws we roll back whatever it did and rethrow.
    function transact(label, fn) {
        if (tx) return fn()
        const t = { label, inverse: [], dirty: new Set() }
        tx = t
        let result
        try {
            result = fn()
        } catch (e) {
            rollback(t)
            tx = null
            recalc(t.dirty)
            notify()
            throw e
        }
        tx = null
        recalc(t.dirty)
        if (t.inverse.length > 0) {
            undoStack.push({ label, ops: t.inverse })
            if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
            redoStack.length = 0
            notify()
        }
        return result
    }

    function replay(from, to) {
        if (from.length === 0) return false
        const entry = from.pop()
        const t = { label: entry.label, inverse: [], dirty: new Set() }
        tx = t
        for (let i = entry.ops.length - 1; i >= 0; i--) applyOp(entry.ops[i])
        tx = null
        recalc(t.dirty)
        to.push({ label: entry.label, ops: t.inverse })
        notify()
        return true
    }

    // Reading

    function getCell(row, col) {
        const key = keyOf(row, col)
        const cell = cells.get(key)
        if (!cell) return { raw: '', computed: '', error: null }
        if (cell.f) {
            const v = computed.get(key)
            if (isErrorValue(v)) return { raw: cell.raw, computed: null, error: v.error }
            return { raw: cell.raw, computed: v ?? '', error: null }
        }
        return { raw: cell.raw, computed: cell.value, error: null }
    }

    // number, string ('' if blank) or an error code like '#REF!'
    function getValue(row, col) {
        const v = valueOfCell(keyOf(row, col))
        return isErrorValue(v) ? v.error : v
    }

    function getRaw(row, col) {
        const cell = cells.get(keyOf(row, col))
        return cell ? cell.raw : ''
    }

    function getStyle(row, col) {
        return styles.get(keyOf(row, col)) || DEFAULT_STYLE
    }

    // bounding box of non-empty cells (null if the sheet is empty); styles don't count
    function getUsedRange() {
        if (usedRangeVersion === 0) return usedRangeCache
        let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1
        for (const key of cells.keys()) {
            const r = rowOf(key)
            const c = colOf(key)
            if (r < r1) r1 = r
            if (r > r2) r2 = r
            if (c < c1) c1 = c
            if (c > c2) c2 = c
        }
        usedRangeCache = r2 < 0 ? null : { r1, c1, r2, c2 }
        usedRangeVersion = 0
        return usedRangeCache
    }

    // like getUsedRange, but styled empty cells count too
    function getContentBounds() {
        const used = getUsedRange()
        let r1 = used ? used.r1 : Infinity, c1 = used ? used.c1 : Infinity
        let r2 = used ? used.r2 : -1, c2 = used ? used.c2 : -1
        for (const key of styles.keys()) {
            const r = rowOf(key)
            const c = colOf(key)
            if (r < r1) r1 = r
            if (r > r2) r2 = r
            if (c < c1) c1 = c
            if (c > c2) c2 = c
        }
        return r2 < 0 ? null : { r1, c1, r2, c2 }
    }

    // walk the range or the map, whichever is smaller
    function forEachKeyInRange(map, range, fn) {
        const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
        if (area <= map.size) {
            for (let r = range.r1; r <= range.r2; r++) {
                for (let c = range.c1; c <= range.c2; c++) if (map.has(keyOf(r, c))) fn(r, c)
            }
        } else {
            const hits = []
            for (const key of map.keys()) {
                const r = rowOf(key)
                const c = colOf(key)
                if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) hits.push([r, c])
            }
            for (const [r, c] of hits) fn(r, c)
        }
    }

    // Public mutators. Each call is one undo step

    function setCell(row, col, raw) {
        transact('Edit cell', () => writeRaw(row, col, raw))
    }

    // updates: [{ row, col, raw }]
    function setCells(updates, label = 'Edit cells') {
        transact(label, () => {
            for (const u of updates) writeRaw(u.row, u.col, u.raw)
        })
    }

    // clears contents only, formatting stays
    function clearRange(range, label = 'Clear') {
        const rg = normalizeRange(range)
        transact(label, () => forEachKeyInRange(cells, rg, (r, c) => writeRaw(r, c, '')))
    }

    function setStyle(range, patch, label = 'Format') {
        const rg = normalizeRange(range)
        transact(label, () => {
            for (let r = rg.r1; r <= rg.r2; r++) {
                for (let c = rg.c1; c <= rg.c2; c++) {
                    writeStyle(r, c, { ...getStyle(r, c), ...patch })
                }
            }
        })
    }

    function clearStyles(range, label = 'Clear formatting') {
        const rg = normalizeRange(range)
        transact(label, () => forEachKeyInRange(styles, rg, (r, c) => writeStyle(r, c, null)))
    }

    // Fill handle. `source` is what was selected, `target` is where the drag
    // ended. Target either grows the source in one direction (we fill the new
    // cells from the seeds and copy the seed styles) or shrinks it from the
    // bottom/right (we clear what got cut off).
    function fill(source, target) {
        const s = normalizeRange(source)
        const t = normalizeRange(target)
        const sameCols = t.c1 === s.c1 && t.c2 === s.c2
        const sameRows = t.r1 === s.r1 && t.r2 === s.r2
        let dir = null
        if (sameCols && t.r1 === s.r1 && t.r2 > s.r2) dir = 'down'
        else if (sameCols && t.r2 === s.r2 && t.r1 < s.r1) dir = 'up'
        else if (sameRows && t.c1 === s.c1 && t.c2 > s.c2) dir = 'right'
        else if (sameRows && t.c2 === s.c2 && t.c1 < s.c1) dir = 'left'
        else if (sameCols && t.r1 === s.r1 && t.r2 < s.r2) dir = 'shrink-rows'
        else if (sameRows && t.c1 === s.c1 && t.c2 < s.c2) dir = 'shrink-cols'
        if (!dir) {
            if (sameRows && sameCols) return { filled: 0, cleared: 0 }
            throw new Error('fill: target must extend or shrink the source in one direction')
        }
        if (dir === 'shrink-rows' || dir === 'shrink-cols') {
            const cut = dir === 'shrink-rows'
                ? { r1: t.r2 + 1, c1: s.c1, r2: s.r2, c2: s.c2 }
                : { r1: s.r1, c1: t.c2 + 1, r2: s.r2, c2: s.c2 }
            clearRange(cut, 'Fill (shrink)')
            return { filled: 0, cleared: (cut.r2 - cut.r1 + 1) * (cut.c2 - cut.c1 + 1) }
        }

        const vertical = dir === 'down' || dir === 'up'
        const n = vertical ? s.r2 - s.r1 + 1 : s.c2 - s.c1 + 1
        let filled = 0
        if (t.r2 >= rows) rows = t.r2 + 1
        if (t.c2 >= cols) cols = t.c2 + 1
        transact('Fill', () => {
            // Always give a fill its own undo step, even if it wrote the same
            // values that were already there. Otherwise Ctrl+Z right after it
            // would undo something older (on sales.tsv: the whole sample load).
            record({ t: 'noop' })
            const lines = vertical ? [s.c1, s.c2] : [s.r1, s.r2]
            for (let line = lines[0]; line <= lines[1]; line++) {
                const seedPos = (i) => (vertical ? [s.r1 + i, line] : [line, s.c1 + i])
                const seeds = []
                const seedStyles = []
                for (let i = 0; i < n; i++) {
                    const [r, c] = seedPos(i)
                    seeds.push(getRaw(r, c))
                    seedStyles.push(styles.get(keyOf(r, c)) || null)
                }
                const series = createSeries(seeds)
                const from = vertical ? (dir === 'down' ? s.r2 + 1 : t.r1) : (dir === 'right' ? s.c2 + 1 : t.c1)
                const to = vertical ? (dir === 'down' ? t.r2 : s.r1 - 1) : (dir === 'right' ? t.c2 : s.c1 - 1)
                const origin = vertical ? s.r1 : s.c1
                for (let pos = from; pos <= to; pos++) {
                    const p = pos - origin
                    const j = ((p % n) + n) % n
                    let raw = series(p)
                    if (isFormula(raw)) raw = vertical ? translateFormula(raw, p - j, 0) : translateFormula(raw, 0, p - j)
                    const r = vertical ? pos : line
                    const c = vertical ? line : pos
                    writeRaw(r, c, raw)
                    writeStyle(r, c, seedStyles[j])
                    filled++
                }
            }
        })
        return { filled, cleared: 0 }
    }

    function insertRow(at, count = 1) { transact('Insert row', () => structural('row', 'insert', at, count)) }
    function deleteRow(at, count = 1) { transact('Delete row', () => structural('row', 'delete', at, count)) }
    function insertColumn(at, count = 1) { transact('Insert column', () => structural('col', 'insert', at, count)) }
    function deleteColumn(at, count = 1) { transact('Delete column', () => structural('col', 'delete', at, count)) }

    function clearAll() {
        transact('Clear all', () => {
            for (const key of Array.from(cells.keys())) writeRaw(rowOf(key), colOf(key), '')
            for (const key of Array.from(styles.keys())) writeStyle(rowOf(key), colOf(key), null)
        })
    }

    return {
        get rows() { return rows },
        get cols() { return cols },
        // bumps on every change; the UI uses it as its snapshot
        get version() { return version },
        getCell,
        getValue,
        getRaw,
        getStyle,
        getUsedRange,
        getContentBounds,
        setCell,
        setCells,
        clearRange,
        setStyle,
        clearStyles,
        clearAll,
        fill,
        insertRow,
        deleteRow,
        insertColumn,
        deleteColumn,
        transact,
        undo: () => replay(undoStack, redoStack),
        redo: () => replay(redoStack, undoStack),
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        undoLabel: () => undoStack.at(-1)?.label ?? null,
        redoLabel: () => redoStack.at(-1)?.label ?? null,
        // only moves the bounds, nothing is allocated
        ensureCapacity: (minRows, minCols) => {
            let changed = false
            if (minRows > rows) { rows = minRows; changed = true }
            if (minCols > cols) { cols = minCols; changed = true }
            if (changed) notify()
        },
        subscribe(fn) {
            listeners.add(fn)
            return () => listeners.delete(fn)
        },
    }
}
