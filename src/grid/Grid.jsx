// The grid: cells, headers, selection box, fill handle and the cell editor.
// All sheet data comes from the engine, nothing is copied into React state.
//
// What re-renders when:
//   CellsLayer  only when engine.version changes
//   Overlay     when the selection or the fill preview changes
//   CellEditor  on each keystroke (it reads the edit store directly)

import { memo, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { colToLetters } from '../engine/address.js'
import { DEFAULT_STYLE } from '../engine/core.js'
import { displayText } from '../engine/display.js'
import {
    HEADER_WIDTH, HEADER_HEIGHT, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, uniformAxis,
} from './layout.js'
import {
    cellSelection, selectionRange, rangeSelection, moveSelection, extendTo,
    rowSelection, columnSelection, fillTarget,
} from './selection.js'
import { commitEdit, cancelEdit } from './editing.js'
import './Grid.css'

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

// Cells

const CellsLayer = memo(function CellsLayer({ engine, version, rowAxis, colAxis }) {
    void version // the layer re-renders exactly when the engine changes
    const out = []
    // nothing outside this box has content or styling, so skip it
    const box = engine.getContentBounds()
    const rEnd = box ? Math.min(box.r2, rowAxis.count - 1) : -1
    const cEnd = box ? Math.min(box.c2, colAxis.count - 1) : -1
    for (let r = box ? box.r1 : 0; r <= rEnd; r++) {
        for (let c = box.c1; c <= cEnd; c++) {
            const cell = engine.getCell(r, c)
            const style = engine.getStyle(r, c)
            if (cell.raw === '' && style === DEFAULT_STYLE) continue // grid lines come from the background
            out.push(
                <div
                    key={r + ':' + c}
                    className={'grid-cell' + (cell.error ? ' error' : '')}
                    style={{
                        left: colAxis.offset(c), top: rowAxis.offset(r),
                        width: colAxis.size(c), height: rowAxis.size(r),
                        ...cellCss(style, !!cell.error),
                    }}
                >
                    {displayText(cell)}
                </div>,
            )
        }
    }
    return (
        <div
            className="grid-cells"
            style={{
                width: colAxis.total(), height: rowAxis.total(),
                backgroundSize: `${DEFAULT_COL_WIDTH}px ${DEFAULT_ROW_HEIGHT}px`,
            }}
        >
            {out}
        </div>
    )
})

// Headers

function ColumnHeaders({ colAxis, selRange, fullCols }) {
    const items = []
    for (let c = 0; c < colAxis.count; c++) {
        const inSel = c >= selRange.c1 && c <= selRange.c2
        items.push(
            <div
                key={c}
                className={'grid-col-header' + (inSel ? (fullCols ? ' selected-full' : ' selected') : '')}
                style={{ left: HEADER_WIDTH + colAxis.offset(c), width: colAxis.size(c) }}
            >
                {colToLetters(c)}
            </div>,
        )
    }
    return (
        <div className="grid-col-headers" style={{ width: HEADER_WIDTH + colAxis.total() }}>
            <div className="grid-corner" title="Select used range (Ctrl+A)" />
            {items}
        </div>
    )
}

function RowHeaders({ rowAxis, selRange, fullRows }) {
    const items = []
    for (let r = 0; r < rowAxis.count; r++) {
        const inSel = r >= selRange.r1 && r <= selRange.r2
        items.push(
            <div
                key={r}
                className={'grid-row-header' + (inSel ? (fullRows ? ' selected-full' : ' selected') : '')}
                style={{ top: rowAxis.offset(r), height: rowAxis.size(r) }}
            >
                {r + 1}
            </div>,
        )
    }
    return <div className="grid-row-headers" style={{ height: rowAxis.total() }}>{items}</div>
}

// Selection overlay + fill handle

function rectOf(range, rowAxis, colAxis) {
    const left = colAxis.offset(range.c1)
    const top = rowAxis.offset(range.r1)
    return {
        left, top,
        width: colAxis.offset(range.c2) + colAxis.size(range.c2) - left,
        height: rowAxis.offset(range.r2) + rowAxis.size(range.r2) - top,
    }
}

function Overlay({ selection, fillPreview, rowAxis, colAxis, showHandle }) {
    const range = selectionRange(selection)
    const rect = rectOf(range, rowAxis, colAxis)
    const active = rectOf({ r1: selection.anchor.r, c1: selection.anchor.c, r2: selection.anchor.r, c2: selection.anchor.c }, rowAxis, colAxis)
    return (
        <div className="grid-overlay">
            <div className="grid-selection" style={rect} />
            <div className="grid-active" style={active} />
            {fillPreview && <div className="grid-fill-preview" style={rectOf(fillPreview, rowAxis, colAxis)} />}
            {showHandle && (
                <div
                    className="grid-fill-handle"
                    data-role="fill-handle"
                    title="Drag to fill"
                    style={{ left: rect.left + rect.width - 4, top: rect.top + rect.height - 4 }}
                />
            )}
        </div>
    )
}

// In-cell editor

function CellEditor({ editStore, rowAxis, colAxis, styleOf, onKey, onBlur }) {
    const state = useSyncExternalStore(editStore.subscribe, editStore.get)
    if (!state.editing) return null
    const { r, c } = state.editing
    const style = styleOf(r, c)
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
                left: colAxis.offset(c), top: rowAxis.offset(r),
                minWidth: colAxis.size(c), height: rowAxis.size(r),
                ...cellCss(style, false),
            }}
        />
    )
}

// Grid

const isPrintableKey = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey

export default function Grid({ engine, version, selection, onSelectionChange, editStore, onFormat }) {
    const viewportRef = useRef(null)
    const [fillPreview, setFillPreview] = useState(null)
    const [dragging, setDragging] = useState(false)

    const rows = engine.rows
    const cols = engine.cols
    const bounds = { rows, cols }
    // stable between renders unless the sheet size changes (CellsLayer is memoized)
    const rowAxis = useAxis(rows, DEFAULT_ROW_HEIGHT)
    const colAxis = useAxis(cols, DEFAULT_COL_WIDTH)

    const focusGrid = () => viewportRef.current?.focus({ preventScroll: true })

    const scrollIntoView = (r, c) => {
        const vp = viewportRef.current
        if (!vp) return
        const top = rowAxis.offset(r)
        const bottom = top + rowAxis.size(r)
        const left = colAxis.offset(c)
        const right = left + colAxis.size(c)
        const viewH = vp.clientHeight - HEADER_HEIGHT
        const viewW = vp.clientWidth - HEADER_WIDTH
        if (top < vp.scrollTop) vp.scrollTop = top
        else if (bottom > vp.scrollTop + viewH) vp.scrollTop = bottom - viewH
        if (left < vp.scrollLeft) vp.scrollLeft = left
        else if (right > vp.scrollLeft + viewW) vp.scrollLeft = right - viewW
    }

    const select = (sel) => {
        onSelectionChange(sel)
        scrollIntoView(sel.focus.r, sel.focus.c)
    }

    // which cell / header is under the mouse
    const hitTest = (clientX, clientY) => {
        const vp = viewportRef.current
        const rect = vp.getBoundingClientRect()
        const vx = clientX - rect.left
        const vy = clientY - rect.top
        const x = vx + vp.scrollLeft - HEADER_WIDTH
        const y = vy + vp.scrollTop - HEADER_HEIGHT
        const r = rowAxis.indexAt(y)
        const c = colAxis.indexAt(x)
        if (vx < HEADER_WIDTH && vy < HEADER_HEIGHT) return { area: 'corner', r: 0, c: 0 }
        if (vy < HEADER_HEIGHT) return { area: 'col', r, c }
        if (vx < HEADER_WIDTH) return { area: 'row', r, c }
        return { area: 'cell', r, c }
    }

    // Follow the mouse until it's released. If it leaves the grid we keep
    // scrolling, so you can drag a selection or fill past the visible rows.
    const startDrag = (onMove, onUp) => {
        const vp = viewportRef.current
        let last = null
        let timer = null
        setDragging(true)
        const step = () => {
            if (!last) return
            const rect = vp.getBoundingClientRect()
            let dy = 0
            let dx = 0
            if (last.y > rect.bottom - 8) dy = Math.min(40, last.y - (rect.bottom - 8))
            else if (last.y < rect.top + HEADER_HEIGHT) dy = -Math.min(40, rect.top + HEADER_HEIGHT - last.y)
            if (last.x > rect.right - 8) dx = Math.min(40, last.x - (rect.right - 8))
            else if (last.x < rect.left + HEADER_WIDTH) dx = -Math.min(40, rect.left + HEADER_WIDTH - last.x)
            if (dx || dy) {
                vp.scrollTop += dy
                vp.scrollLeft += dx
                const rx = Math.min(Math.max(last.x, rect.left + HEADER_WIDTH + 1), rect.right - 10)
                const ry = Math.min(Math.max(last.y, rect.top + HEADER_HEIGHT + 1), rect.bottom - 10)
                onMove(hitTest(rx, ry))
            }
        }
        const move = (e) => {
            last = { x: e.clientX, y: e.clientY }
            onMove(hitTest(e.clientX, e.clientY))
            if (!timer) timer = setInterval(step, 30)
        }
        const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            if (timer) clearInterval(timer)
            setDragging(false)
            onUp()
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
    }

    const handleMouseDown = (e) => {
        if (e.button !== 0) return
        const vp = viewportRef.current
        const rect = vp.getBoundingClientRect()
        // ignore clicks on the scrollbars
        if (e.clientX - rect.left > vp.clientWidth || e.clientY - rect.top > vp.clientHeight) return
        if (e.target.classList.contains('grid-editor')) return
        e.preventDefault()
        commitEdit(engine, editStore)
        focusGrid()

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

    const handleKeyDown = (e) => {
        if (editStore.get().editing) return
        const mod = e.ctrlKey || e.metaKey
        const key = e.key
        const range = selectionRange(selection)
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }

        if (arrows[key]) {
            e.preventDefault()
            const [dr, dc] = arrows[key]
            select(moveSelection(selection, dr, dc, bounds, e.shiftKey))
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
        if (cell) select(moveSelection(cellSelection(cell.r, cell.c), dr, dc, bounds))
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

    return (
        <div
            ref={viewportRef}
            className={'grid-viewport' + (dragging ? ' dragging' : '')}
            tabIndex={0}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
        >
            <div className="grid-canvas" style={{ width: HEADER_WIDTH + colAxis.total(), height: HEADER_HEIGHT + rowAxis.total() }}>
                <ColumnHeaders colAxis={colAxis} selRange={selRange} fullCols={fullCols} />
                <RowHeaders rowAxis={rowAxis} selRange={selRange} fullRows={fullRows} />
                <div className="grid-body" style={{ left: HEADER_WIDTH, top: HEADER_HEIGHT }}>
                    <CellsLayer engine={engine} version={version} rowAxis={rowAxis} colAxis={colAxis} />
                    <Overlay
                        selection={selection}
                        fillPreview={fillPreview}
                        rowAxis={rowAxis}
                        colAxis={colAxis}
                        showHandle={!dragging || fillPreview !== null}
                    />
                    <CellEditor
                        editStore={editStore}
                        rowAxis={rowAxis}
                        colAxis={colAxis}
                        styleOf={engine.getStyle}
                        onKey={handleEditorKey}
                        onBlur={() => commitEdit(engine, editStore)}
                    />
                </div>
            </div>
        </div>
    )
}

function useAxis(count, size) {
    return useMemo(() => uniformAxis(count, size), [count, size])
}
