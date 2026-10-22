// The grid: cells, headers, selection box, fill handle and the cell editor.
// All sheet data comes from the engine, nothing is copied into React state.
//
// Only what's on screen is rendered: the rows and columns in view plus a
// few extra on each side (OVERSCAN). Positions come from the axes in
// layout.js (prefix sums + binary search once sizes vary).
//
// Layout inside the scroll container, all in "canvas" pixels:
//   top strip   sticky to the top: column headers + frozen rows
//     corner    sticky to the left inside it: the top-left box, headers
//               of frozen columns, and frozen-row x frozen-column cells
//   left strip  sticky to the left: row numbers + frozen columns
//   body        everything else
// Sticky positioning is done by the browser, so frozen panes never lag
// behind the scroll. Each pane draws its own copy of the selection box and
// clips it, so the selection looks continuous across panes.
//
// What re-renders when:
//   CellBlock   when the engine changes or the visible window moves
//   overlays    when the selection or the fill preview changes
//   CellEditor  on each keystroke (it reads the edit store directly)

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { colToLetters } from '../engine/address.js'
import { displayText } from '../engine/display.js'
import { DEFAULT_STYLE } from '../engine/core.js'
import {
    HEADER_WIDTH, HEADER_HEIGHT, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, buildAxis,
} from './layout.js'
import {
    cellSelection, selectionRange, rangeSelection, moveSelection, extendTo,
    rowSelection, columnSelection, fillTarget,
} from './selection.js'
import { commitEdit, cancelEdit } from './editing.js'
import { measureText } from './measure.js'
import { counters } from './perfCounters.js'
import FilterMenu from './FilterMenu.jsx'
import './Grid.css'

const OVERSCAN_ROWS = 8
const OVERSCAN_COLS = 3
const HW = HEADER_WIDTH
const HH = HEADER_HEIGHT

function cellCss(style, isError) {
    return {
        fontWeight: style.bold ? 'bold' : 'normal',
        fontStyle: style.italic ? 'italic' : 'normal',
        textDecoration: style.underline ? 'underline' : 'none',
        color: isError ? '#d93025' : style.color,
        fontSize: style.fontSize + 'px',
        background: style.bg,
        textAlign: style.align,
    }
}

// Cells for rows r1..r2 x cols c1..c2, positioned in canvas pixels minus
// (dx, dy) so the same component works in every pane. Empty, unformatted
// cells aren't rendered at all; GridLines draws the lines between them.
const CellBlock = memo(function CellBlock({ engine, version, r1, r2, c1, c2, rowAxis, colAxis, dx = 0, dy = 0 }) {
    void version // re-render when the engine changes
    useEffect(() => { counters.cellBlocks++ })
    const out = []
    for (let r = r1; r <= r2; r++) {
        const h = rowAxis.size(r)
        if (h === 0) continue // filtered out
        const top = HH + rowAxis.offset(r) - dy
        for (let c = c1; c <= c2; c++) {
            const cell = engine.getCell(r, c)
            const style = engine.getStyle(r, c)
            if (cell.raw === '' && style === DEFAULT_STYLE) continue
            const box = { left: HW + colAxis.offset(c) - dx, top, width: colAxis.size(c), height: h }
            out.push(
                <div
                    key={r * 1000 + c}
                    className={'grid-cell' + (cell.error ? ' error' : '')}
                    style={style === DEFAULT_STYLE && !cell.error ? box : { ...box, ...cellCss(style, !!cell.error) }}
                >
                    {cell.raw === '' ? null : displayText(cell, style)}
                </div>,
            )
        }
    }
    return out
})

// One 1px line per visible row and column boundary (about 60 divs), instead
// of a border on every cell. Works with any row/column sizes.
const GridLines = memo(function GridLines({ r1, r2, c1, c2, rowAxis, colAxis, dx = 0, dy = 0 }) {
    if (r2 < r1 || c2 < c1) return null
    const left = HW + colAxis.offset(c1) - dx
    const top = HH + rowAxis.offset(r1) - dy
    const width = colAxis.offset(c2) + colAxis.size(c2) - colAxis.offset(c1)
    const height = rowAxis.offset(r2) + rowAxis.size(r2) - rowAxis.offset(r1)
    const lines = []
    for (let r = r1; r <= r2; r++) {
        const h = rowAxis.size(r)
        if (h === 0) continue
        lines.push(<div key={'r' + r} className="grid-line" style={{ left, top: HH + rowAxis.offset(r) + h - 1 - dy, width, height: 1 }} />)
    }
    for (let c = c1; c <= c2; c++) {
        lines.push(<div key={'c' + c} className="grid-line" style={{ left: HW + colAxis.offset(c) + colAxis.size(c) - 1 - dx, top, width: 1, height }} />)
    }
    return lines
})

// Column headers c1..c2. Columns with data get sort / filter buttons, and
// every header has a resize handle on its right edge.
function ColumnHeaders({ c1, c2, colAxis, selRange, fullCols, used, sortState, isFiltered }) {
    const items = []
    for (let c = c1; c <= c2; c++) {
        const inSel = c >= selRange.c1 && c <= selRange.c2
        const hasData = used && c >= used.c1 && c <= used.c2
        const sorted = sortState && sortState.col === c ? sortState.dir : null
        const filtered = hasData && isFiltered(c)
        items.push(
            <div
                key={c}
                className={'grid-col-header' + (inSel ? (fullCols ? ' selected-full' : ' selected') : '')}
                style={{ left: HW + colAxis.offset(c), width: colAxis.size(c) }}
            >
                {colToLetters(c)}
                {hasData && (
                    <span className="grid-header-tools">
                        <button className={'grid-header-btn' + (sorted ? ' on' : '')} data-action="sort" data-col={c}
                            title="Sort: ascending, descending, original order">
                            {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '⇅'}
                        </button>
                        <button className={'grid-header-btn' + (filtered ? ' on' : '')} data-action="filter" data-col={c}
                            title={filtered ? 'Filter (active)' : 'Filter'}>▾</button>
                    </span>
                )}
                <div className="grid-col-resize" data-action="col-resize" data-col={c} title="Drag to resize, double-click to fit" />
            </div>,
        )
    }
    return items
}

function RowHeaders({ r1, r2, rowAxis, selRange, fullRows, dy = 0 }) {
    const items = []
    for (let r = r1; r <= r2; r++) {
        const h = rowAxis.size(r)
        if (h === 0) continue // hidden by a filter: leaves a gap in the numbers
        const inSel = r >= selRange.r1 && r <= selRange.r2
        items.push(
            <div
                key={r}
                className={'grid-row-header' + (inSel ? (fullRows ? ' selected-full' : ' selected') : '')}
                style={{ top: HH + rowAxis.offset(r) - dy, height: h }}
            >
                {r + 1}
                <div className="grid-row-resize" data-action="row-resize" data-row={r} title="Drag to resize, double-click to reset" />
            </div>,
        )
    }
    return items
}

function rectOf(range, rowAxis, colAxis, dx = 0, dy = 0) {
    return {
        left: HW + colAxis.offset(range.c1) - dx,
        top: HH + rowAxis.offset(range.r1) - dy,
        width: colAxis.offset(range.c2) + colAxis.size(range.c2) - colAxis.offset(range.c1),
        height: rowAxis.offset(range.r2) + rowAxis.size(range.r2) - rowAxis.offset(range.r1),
    }
}

function Overlay({ selection, fillPreview, rowAxis, colAxis, showHandle, dx = 0, dy = 0 }) {
    const rect = rectOf(selectionRange(selection), rowAxis, colAxis, dx, dy)
    const a = selection.anchor
    const active = rectOf({ r1: a.r, c1: a.c, r2: a.r, c2: a.c }, rowAxis, colAxis, dx, dy)
    return (
        <>
            <div className="grid-selection" style={rect} />
            <div className="grid-active" style={active} />
            {fillPreview && <div className="grid-fill-preview" style={rectOf(fillPreview, rowAxis, colAxis, dx, dy)} />}
            {showHandle && (
                <div className="grid-fill-handle" data-role="fill-handle" title="Drag to fill"
                    style={{ left: rect.left + rect.width - 4, top: rect.top + rect.height - 4 }} />
            )}
        </>
    )
}

function CellEditor({ editStore, rowAxis, colAxis, styleOf, onKey, onBlur, inPane, dx = 0, dy = 0 }) {
    const state = useSyncExternalStore(editStore.subscribe, editStore.get)
    useEffect(() => { counters.editor++ })
    if (!state.editing || !inPane(state.editing.r, state.editing.c)) return null
    const { r, c } = state.editing
    return (
        <input
            className="grid-editor"
            autoFocus
            spellCheck={false}
            value={state.value}
            onChange={(e) => editStore.setValue(e.target.value)}
            onKeyDown={onKey}
            onBlur={onBlur}
            onFocus={(e) => { const n = e.target.value.length; e.target.setSelectionRange(n, n) }}
            style={{
                left: HW + colAxis.offset(c) - dx, top: HH + rowAxis.offset(r) - dy,
                minWidth: colAxis.size(c), height: rowAxis.size(r),
                ...cellCss(styleOf(r, c), false),
            }}
        />
    )
}

const isPrintableKey = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export default function Grid({ engine, version, selection, onSelectionChange, editStore, onFormat, reveal }) {
    const viewportRef = useRef(null)
    // start with the window size so the first render already covers the screen
    const [view, setView] = useState(() => ({ top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }))
    const [fillPreview, setFillPreview] = useState(null)
    const [dragging, setDragging] = useState(false)
    const [filterMenu, setFilterMenu] = useState(null) // { col, x, y }
    const [resizing, setResizing] = useState(null) // { kind: 'col' | 'row', index, size } while dragging a border

    useEffect(() => { counters.grid++ })

    const rows = engine.rows
    const cols = engine.cols
    const bounds = { rows, cols }
    const sizeVersion = engine.sizeVersion
    const hidden = engine.getHiddenRows() // same Set until something changes

    const rowAxis = useMemo(() => {
        void sizeVersion
        const live = resizing?.kind === 'row' ? resizing : null
        const custom = engine.hasCustomRowHeights() || live
        return buildAxis(rows, DEFAULT_ROW_HEIGHT, {
            hidden,
            customSize: custom ? (r) => (live && live.index === r ? live.size : engine.getRowHeight(r)) : null,
        })
    }, [engine, rows, hidden, sizeVersion, resizing])

    const colAxis = useMemo(() => {
        void sizeVersion
        const live = resizing?.kind === 'col' ? resizing : null
        const custom = engine.hasCustomColWidths() || live
        return buildAxis(cols, DEFAULT_COL_WIDTH, {
            customSize: custom ? (c) => (live && live.index === c ? live.size : engine.getColWidth(c)) : null,
        })
    }, [engine, cols, sizeVersion, resizing])

    const frozen = engine.getFrozen()
    const fr = Math.min(frozen.rows, rows)
    const fc = Math.min(frozen.cols, cols)
    const frozenH = rowAxis.offset(fr)
    const frozenW = colAxis.offset(fc)

    // Keep `view` in sync with scrolling and resizing, at most once per frame.
    useLayoutEffect(() => {
        const vp = viewportRef.current
        let frame = 0
        const read = () => {
            frame = 0
            setView({ top: vp.scrollTop, left: vp.scrollLeft, width: vp.clientWidth, height: vp.clientHeight })
        }
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(read) }
        read()
        vp.addEventListener('scroll', onScroll, { passive: true })
        const ro = new ResizeObserver(onScroll)
        ro.observe(vp)
        return () => {
            vp.removeEventListener('scroll', onScroll)
            ro.disconnect()
            if (frame) cancelAnimationFrame(frame)
        }
    }, [])

    // The visible window of the scrolling part (rows >= fr, cols >= fc)
    const bodyR1 = Math.max(fr, rowAxis.indexAt(view.top + frozenH) - OVERSCAN_ROWS)
    const bodyR2 = Math.min(rows - 1, rowAxis.indexAt(view.top + view.height - HH) + OVERSCAN_ROWS)
    const bodyC1 = Math.max(fc, colAxis.indexAt(view.left + frozenW) - OVERSCAN_COLS)
    const bodyC2 = Math.min(cols - 1, colAxis.indexAt(view.left + view.width - HW) + OVERSCAN_COLS)

    const focusGrid = () => viewportRef.current?.focus({ preventScroll: true })

    // Scroll so that (r, c) is in view; frozen rows/cols are always in view.
    const scrollIntoView = (r, c) => {
        const vp = viewportRef.current
        if (!vp) return
        const viewH = vp.clientHeight - HH
        const viewW = vp.clientWidth - HW
        if (r >= fr) {
            const top = rowAxis.offset(r)
            const bottom = top + rowAxis.size(r)
            if (top < vp.scrollTop + frozenH) vp.scrollTop = top - frozenH
            else if (bottom > vp.scrollTop + viewH) vp.scrollTop = bottom - viewH
        }
        if (c >= fc) {
            const left = colAxis.offset(c)
            const right = left + colAxis.size(c)
            if (left < vp.scrollLeft + frozenW) vp.scrollLeft = left - frozenW
            else if (right > vp.scrollLeft + viewW) vp.scrollLeft = right - viewW
        }
    }

    // App asks us to bring a cell into view (name box)
    useEffect(() => {
        if (reveal) scrollIntoView(reveal.r, reveal.c)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reveal])

    const select = (sel) => {
        onSelectionChange(sel)
        scrollIntoView(sel.focus.r, sel.focus.c)
    }

    // Arrow keys, Page Up/Down and Enter skip rows hidden by a filter.
    const step = (sel, dr, dc, extend = false) => {
        let next = moveSelection(sel, dr, dc, bounds, extend)
        let guard = rows
        while (dr !== 0 && hidden.has(next.focus.r) && guard-- > 0) {
            const further = moveSelection(next, dr > 0 ? 1 : -1, 0, bounds, extend)
            if (further.focus.r === next.focus.r) return sel
            next = further
        }
        return next
    }

    const sortRange = () => {
        const r = selectionRange(selection)
        const multi = r.r1 !== r.r2 || r.c1 !== r.c2
        const whole = (r.r1 === 0 && r.r2 === rows - 1) || (r.c1 === 0 && r.c2 === cols - 1)
        return multi && !whole ? r : null
    }

    // Which cell / header is under the mouse. Frozen rows/cols don't scroll.
    const hitTest = (clientX, clientY) => {
        const vp = viewportRef.current
        const rect = vp.getBoundingClientRect()
        const vx = clientX - rect.left
        const vy = clientY - rect.top
        const x = vx - HW < frozenW ? vx - HW : vx - HW + vp.scrollLeft
        const y = vy - HH < frozenH ? vy - HH : vy - HH + vp.scrollTop
        const r = rowAxis.indexAt(y)
        const c = colAxis.indexAt(x)
        if (vx < HW && vy < HH) return { area: 'corner', r: 0, c: 0 }
        if (vy < HH) return { area: 'col', r, c }
        if (vx < HW) return { area: 'row', r, c }
        return { area: 'cell', r, c }
    }

    // Follow the mouse until it's released, scrolling when it leaves the grid.
    const startDrag = (onMove, onUp, autoScroll = true) => {
        const vp = viewportRef.current
        let last = null
        let timer = null
        setDragging(true)
        const stepScroll = () => {
            if (!last) return
            const rect = vp.getBoundingClientRect()
            let dy = 0
            let dx = 0
            if (last.y > rect.bottom - 8) dy = Math.min(60, last.y - (rect.bottom - 8))
            else if (last.y < rect.top + HH + frozenH) dy = -Math.min(60, rect.top + HH + frozenH - last.y)
            if (last.x > rect.right - 8) dx = Math.min(60, last.x - (rect.right - 8))
            else if (last.x < rect.left + HW + frozenW) dx = -Math.min(60, rect.left + HW + frozenW - last.x)
            if (dx || dy) {
                vp.scrollTop += dy
                vp.scrollLeft += dx
                onMove(hitTest(clamp(last.x, rect.left + HW + 1, rect.right - 10), clamp(last.y, rect.top + HH + 1, rect.bottom - 10)), last)
            }
        }
        const move = (e) => {
            last = { x: e.clientX, y: e.clientY }
            onMove(hitTest(e.clientX, e.clientY), last)
            if (autoScroll && !timer) timer = setInterval(stepScroll, 30)
        }
        const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            if (timer) clearInterval(timer)
            setDragging(false)
            onUp(last)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
    }

    const handleMouseDown = (e) => {
        if (e.button !== 0) return
        const vp = viewportRef.current
        const rect = vp.getBoundingClientRect()
        if (e.clientX - rect.left > vp.clientWidth || e.clientY - rect.top > vp.clientHeight) return // scrollbars
        if (e.target.classList.contains('grid-editor')) return
        e.preventDefault()
        commitEdit(engine, editStore)
        focusGrid()

        const action = e.target.dataset.action
        if (action === 'sort') {
            engine.cycleSort(Number(e.target.dataset.col), sortRange())
            return
        }
        if (action === 'filter') {
            const b = e.target.getBoundingClientRect()
            const col = Number(e.target.dataset.col)
            setFilterMenu((open) => (open && open.col === col ? null : { col, x: b.left, y: b.bottom + 2 }))
            return
        }
        if (action === 'col-resize' || action === 'row-resize') {
            // drag a header border: preview live, write once on release (one undo step)
            const isCol = action === 'col-resize'
            const index = Number(isCol ? e.target.dataset.col : e.target.dataset.row)
            const startSize = isCol ? colAxis.size(index) : rowAxis.size(index)
            const start = isCol ? e.clientX : e.clientY
            let size = startSize
            startDrag(
                (_hit, p) => {
                    size = clamp(startSize + (isCol ? p.x : p.y) - start, isCol ? 20 : 12, isCol ? 1000 : 400)
                    setResizing({ kind: isCol ? 'col' : 'row', index, size })
                },
                () => {
                    setResizing(null)
                    if (size !== startSize) {
                        if (isCol) engine.setColWidth(index, Math.round(size))
                        else engine.setRowHeight(index, Math.round(size))
                    }
                },
                false,
            )
            return
        }

        const source = selectionRange(selection)
        if (e.target.dataset.role === 'fill-handle') {
            let target = source
            startDrag(
                (hit) => {
                    target = fillTarget(source, hit.r, hit.c)
                    setFillPreview(target)
                },
                () => {
                    setFillPreview(null)
                    try {
                        engine.fill(source, target)
                        onSelectionChange(rangeSelection(target))
                    } catch (err) {
                        console.error(err)
                    }
                },
            )
            return
        }

        const hit = hitTest(e.clientX, e.clientY)
        if (hit.area === 'corner') {
            const used = engine.getUsedRange()
            select(used ? rangeSelection(used) : cellSelection(0, 0))
            return
        }
        if (hit.area === 'col') {
            const start = e.shiftKey ? selection.anchor.c : hit.c
            onSelectionChange(columnSelection(Math.min(start, hit.c), Math.max(start, hit.c), bounds))
            startDrag((h) => onSelectionChange(columnSelection(Math.min(start, h.c), Math.max(start, h.c), bounds)), () => {})
            return
        }
        if (hit.area === 'row') {
            const start = e.shiftKey ? selection.anchor.r : hit.r
            onSelectionChange(rowSelection(Math.min(start, hit.r), Math.max(start, hit.r), bounds))
            startDrag((h) => onSelectionChange(rowSelection(Math.min(start, h.r), Math.max(start, h.r), bounds)), () => {})
            return
        }
        const base = e.shiftKey ? extendTo(selection, hit.r, hit.c) : cellSelection(hit.r, hit.c)
        onSelectionChange(base)
        startDrag((h) => onSelectionChange(extendTo(base, h.r, h.c)), () => {})
    }

    const handleDoubleClick = (e) => {
        const action = e.target.dataset.action
        if (action === 'col-resize') {
            engine.autoFitColumns([Number(e.target.dataset.col)], measureText)
            return
        }
        if (action === 'row-resize') {
            engine.setRowHeight(Number(e.target.dataset.row), null)
            return
        }
        const hit = hitTest(e.clientX, e.clientY)
        if (hit.area !== 'cell') return
        onSelectionChange(cellSelection(hit.r, hit.c))
        editStore.start(hit.r, hit.c, engine.getRaw(hit.r, hit.c), 'edit')
    }

    const startEditing = (initial, mode) => {
        const { r, c } = selection.anchor
        scrollIntoView(r, c)
        editStore.start(r, c, initial ?? engine.getRaw(r, c), mode)
    }

    // rows that fit in the scrolling part of the view, for Page Up/Down
    const pageRows = () => {
        const vp = viewportRef.current
        const usable = (vp ? vp.clientHeight : view.height) - HH - frozenH
        return Math.max(1, Math.floor(usable / DEFAULT_ROW_HEIGHT) - 1)
    }

    const handleKeyDown = (e) => {
        if (editStore.get().editing) return
        const mod = e.ctrlKey || e.metaKey
        const key = e.key
        const range = selectionRange(selection)
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }

        if (arrows[key]) {
            e.preventDefault()
            const [dr, dc] = arrows[key]
            select(step(selection, dr, dc, e.shiftKey))
        } else if (key === 'PageDown' || key === 'PageUp') {
            e.preventDefault()
            select(step(selection, pageRows() * (key === 'PageDown' ? 1 : -1), 0, e.shiftKey))
        } else if (mod && key === 'Home') {
            e.preventDefault()
            select(e.shiftKey ? extendTo(selection, 0, 0) : cellSelection(0, 0))
        } else if (mod && key === 'End') {
            // last used cell
            e.preventDefault()
            const used = engine.getUsedRange()
            const r = used ? used.r2 : 0
            const c = used ? used.c2 : 0
            select(e.shiftKey ? extendTo(selection, r, c) : cellSelection(r, c))
        } else if (key === 'Tab') {
            e.preventDefault()
            select(moveSelection(selection, 0, e.shiftKey ? -1 : 1, bounds))
        } else if (key === 'Enter' || key === 'F2') {
            e.preventDefault()
            startEditing(null, 'edit')
        } else if (key === 'Delete' || key === 'Backspace') {
            e.preventDefault()
            engine.clearRange(range)
        } else if (mod && key.toLowerCase() === 'a') {
            e.preventDefault()
            const used = engine.getUsedRange()
            select(used ? rangeSelection(used) : cellSelection(0, 0))
        } else if (mod && key.toLowerCase() === 'd') {
            // fill down: copy the selection's top row into the rest of it
            e.preventDefault()
            if (range.r2 > range.r1) engine.fill({ ...range, r2: range.r1 }, range, { copy: true })
        } else if (mod && key.toLowerCase() === 'r') {
            // fill right: copy the left column across
            e.preventDefault()
            if (range.c2 > range.c1) engine.fill({ ...range, c2: range.c1 }, range, { copy: true })
        } else if (mod && key.toLowerCase() === 'z') {
            e.preventDefault()
            if (e.shiftKey) engine.redo()
            else engine.undo()
        } else if (mod && key.toLowerCase() === 'y') {
            e.preventDefault()
            engine.redo()
        } else if (mod && ['b', 'i', 'u'].includes(key.toLowerCase())) {
            e.preventDefault()
            onFormat({ b: 'bold', i: 'italic', u: 'underline' }[key.toLowerCase()])
        } else if (isPrintableKey(e)) {
            e.preventDefault()
            startEditing(key, 'enter')
        }
    }

    const finishEdit = (dr, dc) => {
        const cell = commitEdit(engine, editStore)
        if (cell) select(step(cellSelection(cell.r, cell.c), dr, dc))
        focusGrid()
    }

    const handleEditorKey = (e) => {
        const mode = editStore.get().editing?.mode
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); finishEdit(e.shiftKey ? -1 : 1, 0) }
        else if (e.key === 'Tab') { e.preventDefault(); finishEdit(0, e.shiftKey ? -1 : 1) }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(editStore); focusGrid() }
        else if (mode === 'enter' && e.key.startsWith('Arrow')) {
            e.preventDefault()
            const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
            finishEdit(d[0], d[1])
        }
    }

    const selRange = selectionRange(selection)
    const fullCols = selRange.r1 === 0 && selRange.r2 === rows - 1
    const fullRows = selRange.c1 === 0 && selRange.c2 === cols - 1
    const used = engine.getUsedRange()
    const sortState = engine.getSortState()
    const isFiltered = (c) => engine.getFilter(c) !== null
    const showHandle = !dragging || fillPreview !== null
    // the fill handle is drawn once, in the pane holding the selection's bottom-right cell
    const handleIn = (rows0, cols0) => showHandle && (selRange.r2 < fr) === rows0 && (selRange.c2 < fc) === cols0

    const shared = { engine, version, rowAxis, colAxis }
    const overlay = { selection, fillPreview, rowAxis, colAxis }
    const editor = {
        editStore, rowAxis, colAxis, styleOf: engine.getStyle, onKey: handleEditorKey,
        onBlur: () => commitEdit(engine, editStore),
    }
    const headers = { colAxis, selRange, fullCols, used, sortState, isFiltered }
    const leftTop = HH + frozenH // canvas y where the left strip starts
    const totalW = HW + colAxis.total()

    return (
        <>
            <div
                ref={viewportRef}
                className={'grid-viewport' + (dragging ? ' dragging' : '')}
                tabIndex={0}
                onMouseDown={handleMouseDown}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                data-testid="grid"
            >
                <div className="grid-canvas" style={{ width: totalW, height: HH + rowAxis.total() }}>
                    {/* body: scrolls both ways */}
                    <div className="grid-body" style={{ width: totalW, height: HH + rowAxis.total() }}>
                        <CellBlock {...shared} r1={bodyR1} r2={bodyR2} c1={bodyC1} c2={bodyC2} />
                        <GridLines rowAxis={rowAxis} colAxis={colAxis} r1={bodyR1} r2={bodyR2} c1={bodyC1} c2={bodyC2} />
                        <Overlay {...overlay} showHandle={handleIn(false, false)} />
                        <CellEditor {...editor} inPane={(r, c) => r >= fr && c >= fc} />
                    </div>

                    {/* top strip: column headers + frozen rows, sticks to the top */}
                    <div className="grid-top" style={{ width: totalW, height: HH + frozenH }}>
                        <ColumnHeaders {...headers} c1={bodyC1} c2={bodyC2} />
                        <div className="grid-clip" style={{ left: HW + frozenW, top: HH, width: colAxis.total() - frozenW, height: frozenH }}>
                            <CellBlock {...shared} r1={0} r2={fr - 1} c1={bodyC1} c2={bodyC2} dx={HW + frozenW} dy={HH} />
                            <GridLines rowAxis={rowAxis} colAxis={colAxis} r1={0} r2={fr - 1} c1={bodyC1} c2={bodyC2} dx={HW + frozenW} dy={HH} />
                            <Overlay {...overlay} showHandle={handleIn(true, false)} dx={HW + frozenW} dy={HH} />
                            <CellEditor {...editor} inPane={(r, c) => r < fr && c >= fc} dx={HW + frozenW} dy={HH} />
                        </div>
                        {/* corner: sticks to the left inside the top strip */}
                        <div className="grid-corner-block" style={{ width: HW + frozenW, height: HH + frozenH }}>
                            <div className="grid-corner" title="Select used range (Ctrl+A)" />
                            <ColumnHeaders {...headers} c1={0} c2={fc - 1} />
                            <RowHeaders r1={0} r2={fr - 1} rowAxis={rowAxis} selRange={selRange} fullRows={fullRows} />
                            <div className="grid-clip" style={{ left: HW, top: HH, width: frozenW, height: frozenH }}>
                                <CellBlock {...shared} r1={0} r2={fr - 1} c1={0} c2={fc - 1} dx={HW} dy={HH} />
                                <GridLines rowAxis={rowAxis} colAxis={colAxis} r1={0} r2={fr - 1} c1={0} c2={fc - 1} dx={HW} dy={HH} />
                                <Overlay {...overlay} showHandle={handleIn(true, true)} dx={HW} dy={HH} />
                                <CellEditor {...editor} inPane={(r, c) => r < fr && c < fc} dx={HW} dy={HH} />
                            </div>
                        </div>
                    </div>

                    {/* left strip: row numbers + frozen columns, sticks to the left */}
                    <div className="grid-left" style={{ width: HW + frozenW, height: rowAxis.total() - frozenH }}>
                        <RowHeaders r1={bodyR1} r2={bodyR2} rowAxis={rowAxis} selRange={selRange} fullRows={fullRows} dy={leftTop} />
                        <div className="grid-clip" style={{ left: HW, top: 0, width: frozenW, height: rowAxis.total() - frozenH }}>
                            <CellBlock {...shared} r1={bodyR1} r2={bodyR2} c1={0} c2={fc - 1} dx={HW} dy={leftTop} />
                            <GridLines rowAxis={rowAxis} colAxis={colAxis} r1={bodyR1} r2={bodyR2} c1={0} c2={fc - 1} dx={HW} dy={leftTop} />
                            <Overlay {...overlay} showHandle={handleIn(false, true)} dx={HW} dy={leftTop} />
                            <CellEditor {...editor} inPane={(r, c) => r >= fr && c < fc} dx={HW} dy={leftTop} />
                        </div>
                    </div>
                </div>
            </div>
            {filterMenu && (
                <FilterMenu
                    key={filterMenu.col}
                    engine={engine}
                    col={filterMenu.col}
                    anchor={filterMenu}
                    onSort={(dir) => engine.sortColumn(filterMenu.col, dir, sortRange())}
                    onClose={() => { setFilterMenu(null); focusGrid() }}
                />
            )}
        </>
    )
}
