import { useState, useSyncExternalStore } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { toA1, rangeToA1 } from './engine/address.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import Grid from './grid/Grid.jsx'
import { createEditStore } from './grid/editStore.js'
import { commitEdit, cancelEdit } from './grid/editing.js'
import { cellSelection, selectionRange } from './grid/selection.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50

const clampSelection = (sel, rows, cols) => {
  const fix = (p) => ({ r: Math.min(p.r, rows - 1), c: Math.min(p.c, cols - 1) })
  return { anchor: fix(sel.anchor), focus: fix(sel.focus) }
}

export default function App() {
  // The engine has all the sheet data (values, styles, undo). React only
  // keeps the selection; the text being typed lives in editStore.
  const [engine] = useState(() => {
    const e = createEngine(TOTAL_ROWS, TOTAL_COLS)
    // ?debug exposes the engine for perf/measure.mjs
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) window.__engine = e
    return e
  })
  const [editStore] = useState(createEditStore)
  const version = useSyncExternalStore(engine.subscribe, () => engine.version)
  const editState = useSyncExternalStore(editStore.subscribe, editStore.get)
  const [rawSelection, setSelection] = useState(() => cellSelection(0, 0))

  const selection = clampSelection(rawSelection, engine.rows, engine.cols)
  const range = selectionRange(selection)
  const active = selection.anchor
  const activeStyle = engine.getStyle(active.r, active.c)

  // formatting applies to everything selected

  const applyStyle = (patch) => engine.setStyle(range, patch)
  const toggle = (prop) => applyStyle({ [prop]: !activeStyle[prop] })

  // formula bar

  const formulaBarValue = editState.editing ? editState.value : engine.getRaw(active.r, active.c)

  const handleFormulaBarFocus = () => {
    if (!editState.editing) editStore.start(active.r, active.c, engine.getRaw(active.r, active.c), 'edit')
  }

  const handleFormulaBarKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const cell = commitEdit(engine, editStore)
      if (cell) setSelection(cellSelection(Math.min(cell.r + 1, engine.rows - 1), cell.c))
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit(editStore)
      e.currentTarget.blur()
    }
  }

  // insert/delete use however many rows or columns are selected

  const rowCount = range.r2 - range.r1 + 1
  const colCount = range.c2 - range.c1 + 1
  const insertRows = () => engine.insertRow(range.r1, rowCount)
  const deleteRows = () => engine.deleteRow(range.r1, Math.min(rowCount, engine.rows - 1))
  const insertCols = () => engine.insertColumn(range.c1, colCount)
  const deleteCols = () => engine.deleteColumn(range.c1, Math.min(colCount, engine.cols - 1))

  const loadSample = (loader) => {
    cancelEdit(editStore)
    loader(engine)
    setSelection(cellSelection(0, 0))
  }

  const clearAll = () => {
    cancelEdit(editStore)
    engine.clearAll()
    setSelection(cellSelection(0, 0))
  }

  const status = range.r1 === range.r2 && range.c1 === range.c2
    ? toA1(active.r, active.c)
    : `${rangeToA1(range)} (${rowCount}R × ${colCount}C)`


  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
      </div>

      <div className="main-content">

        {/* Toolbar */}
        <div className="toolbar" onMouseDown={() => commitEdit(engine, editStore)}>
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${activeStyle.bold ? 'active' : ''}`} onClick={() => toggle('bold')} title="Bold (Ctrl+B)">B</button>
            <button className={`toolbar-btn italic-btn ${activeStyle.italic ? 'active' : ''}`} onClick={() => toggle('italic')} title="Italic (Ctrl+I)">I</button>
            <button className={`toolbar-btn underline-btn ${activeStyle.underline ? 'active' : ''}`} onClick={() => toggle('underline')} title="Underline (Ctrl+U)">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={activeStyle.fontSize} onChange={(e) => applyStyle({ fontSize: parseInt(e.target.value, 10) })}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${activeStyle.align === 'left' ? 'active' : ''}`} onClick={() => applyStyle({ align: 'left' })} title="Align Left">⬤←</button>
            <button className={`align-btn ${activeStyle.align === 'center' ? 'active' : ''}`} onClick={() => applyStyle({ align: 'center' })} title="Align Center">⬤</button>
            <button className={`align-btn ${activeStyle.align === 'right' ? 'active' : ''}`} onClick={() => applyStyle({ align: 'right' })} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={activeStyle.color}
              onChange={(e) => applyStyle({ color: e.target.value })}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={activeStyle.bg} onChange={(e) => applyStyle({ bg: e.target.value })}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => engine.undo()} disabled={!engine.canUndo()} title={`Undo ${engine.undoLabel() ?? ''} (Ctrl+Z)`}>↶ Undo</button>
            <button className="toolbar-btn" onClick={() => engine.redo()} disabled={!engine.canRedo()} title={`Redo ${engine.redoLabel() ?? ''} (Ctrl+Y)`}>↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRows} title="Insert row(s) above the selection">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRows} title="Delete the selected row(s)">- Row</button>
            <button className="toolbar-btn" onClick={insertCols} title="Insert column(s) left of the selection">+ Col</button>
            <button className="toolbar-btn" onClick={deleteCols} title="Delete the selected column(s)">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={() => engine.clearRange(range)} title="Clear the selection (Delete)">✕ Clear</button>
            <button className="toolbar-btn danger" onClick={clearAll}>✕ All</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
          </div>
        </div>

        {/* Formula Bar */}
        <div className="formula-bar">
          <span className="formula-bar-label" data-testid="selection-label">{status}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => editStore.setValue(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
          />
        </div>

        {/* Grid */}
        <Grid
          engine={engine}
          version={version}
          selection={selection}
          onSelectionChange={setSelection}
          editStore={editStore}
          onFormat={toggle}
        />

        <p className="footer-hint">
          Click to select · drag / Shift+Click / Shift+Arrow to extend · double-click, Enter, F2 or type to edit · drag the ■ handle to fill · Delete clears · Ctrl+Z / Ctrl+Y
        </p>
      </div>
    </div>
  )
}
