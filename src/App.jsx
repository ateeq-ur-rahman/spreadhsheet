import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { toA1, rangeToA1, parseRange } from './engine/address.js'
import Grid from './grid/Grid.jsx'
import { createEditStore } from './grid/editStore.js'
import { commitEdit, cancelEdit } from './grid/editing.js'
import FormulaBar from './grid/FormulaBar.jsx'
import { cellSelection, selectionRange, rangeSelection } from './grid/selection.js'
import { counters } from './grid/perfCounters.js'

// The AI panel (and the mock provider's fixtures) load the first time it's opened.
const AiPanel = lazy(() => import('./ai/AiPanel.jsx'))

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200

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
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) {
      window.__engine = e
      window.__counters = counters
    }
    return e
  })
  const [editStore] = useState(createEditStore)
  const version = useSyncExternalStore(engine.subscribe, () => engine.version)
  const [rawSelection, setSelection] = useState(() => cellSelection(0, 0))
  // { r, c } the grid should scroll to (a new object each time we ask)
  const [reveal, setReveal] = useState(null)
  // name box: null while it just shows the selection, the typed text while editing
  const [nameDraft, setNameDraft] = useState(null)
  const [nameError, setNameError] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  // Ctrl+K (Cmd+K) opens and closes the AI panel from anywhere
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setAiOpen(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selection = clampSelection(rawSelection, engine.rows, engine.cols)
  const range = selectionRange(selection)
  const active = selection.anchor
  const activeStyle = engine.getStyle(active.r, active.c)

  // formatting applies to everything selected

  const applyStyle = (patch) => engine.setStyle(range, patch)
  const toggle = (prop) => applyStyle({ [prop]: !activeStyle[prop] })

  // insert/delete use however many rows or columns are selected

  const rowCount = range.r2 - range.r1 + 1
  const colCount = range.c2 - range.c1 + 1
  const insertRows = () => engine.insertRow(range.r1, rowCount)
  const deleteRows = () => engine.deleteRow(range.r1, Math.min(rowCount, engine.rows - 1))
  const insertCols = () => engine.insertColumn(range.c1, colCount)
  const deleteCols = () => engine.deleteColumn(range.c1, Math.min(colCount, engine.cols - 1))

  const goTo = (sel) => {
    setSelection(sel)
    setReveal({ r: sel.anchor.r, c: sel.anchor.c })
  }

  // The sample files are about 250 KB of text, so they're only downloaded
  // when a sample button is clicked (keeps the first paint fast).
  const loadSample = async (which) => {
    cancelEdit(editStore)
    const samples = await import('./fixtures/loadSample.js')
    if (which === 'large') samples.loadSampleLarge(engine)
    else samples.loadSampleSmall(engine)
    goTo(cellSelection(0, 0))
  }

  const clearAll = () => {
    cancelEdit(editStore)
    engine.clearAll()
    goTo(cellSelection(0, 0))
  }

  // name box: type A1, AZ5000 or K2:K100000 and press Enter
  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = parseRange(nameDraft ?? '')
      if (!target || target.r2 >= engine.rows || target.c2 >= engine.cols) {
        setNameError(true) // say so instead of silently ignoring it
        return
      }
      setNameError(false)
      setNameDraft(null)
      goTo(rangeSelection(target))
      document.querySelector('[data-testid="grid"]')?.focus({ preventScroll: true })
    } else if (e.key === 'Escape') {
      setNameDraft(null)
      setNameError(false)
      e.currentTarget.blur()
    }
  }

  const frozen = engine.getFrozen()

  const filterInfo = engine.filterStatus()

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
            <button className={`toolbar-btn ${frozen.rows ? 'active' : ''}`} onClick={() => engine.setFrozen(frozen.rows ? 0 : 1, frozen.cols)} title="Keep row 1 in view while scrolling">❄ Row 1</button>
            <button className={`toolbar-btn ${frozen.cols ? 'active' : ''}`} onClick={() => engine.setFrozen(frozen.rows, frozen.cols ? 0 : 1)} title="Keep column A in view while scrolling">❄ Col A</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample('small')} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample('large')} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
          </div>

          <div className="toolbar-group">
            <button className={`toolbar-btn ${aiOpen ? 'active' : ''}`} onClick={() => setAiOpen(open => !open)} title="Ask your data (Ctrl+K)">✨ Ask (Ctrl+K)</button>
          </div>
        </div>

        {/* Formula Bar */}
        <div className="formula-bar">
          <input
            className={`name-box ${nameError ? 'error' : ''}`}
            data-testid="name-box"
            value={nameDraft ?? (range.r1 === range.r2 && range.c1 === range.c2 ? toA1(active.r, active.c) : rangeToA1(range))}
            onFocus={(e) => { setNameDraft(e.target.value); e.target.select() }}
            onChange={(e) => { setNameDraft(e.target.value); setNameError(false) }}
            onBlur={() => { setNameDraft(null); setNameError(false) }}
            onKeyDown={handleNameKeyDown}
            title={nameError ? 'Not a cell or range on this sheet (try A1, AZ5000 or K2:K100000)' : 'Go to a cell or range'}
            spellCheck={false}
          />
          <span className="formula-bar-label" data-testid="selection-label">{status}</span>
          <FormulaBar
            engine={engine}
            editStore={editStore}
            active={active}
            onCommitted={(cell) => setSelection(cellSelection(Math.min(cell.r + 1, engine.rows - 1), cell.c))}
          />
        </div>

        {/* Grid + AI panel */}
        <div className="workspace">
          <Grid
            engine={engine}
            version={version}
            selection={selection}
            onSelectionChange={setSelection}
            editStore={editStore}
            onFormat={toggle}
            reveal={reveal}
          />
          {aiOpen && (
            <Suspense fallback={<aside className="ai-panel ai-loading">Loading…</aside>}>
              <AiPanel engine={engine} selection={range} activeCell={active} onClose={() => setAiOpen(false)} />
            </Suspense>
          )}
        </div>

        <div className="footer-hint status-line">
          {filterInfo && (
            <span className="filter-status" data-testid="filter-status">
              {filterInfo.visible} of {filterInfo.total} rows
              <button className="toolbar-btn" onClick={() => engine.clearFilters()}>Clear filters</button>
            </span>
          )}
          <span>
            Drag / Shift+Click / Shift+Arrow to select · double-click, Enter, F2 or type to edit · drag ■ to fill, Ctrl+D fills down · ⇅ sorts, ▾ filters · drag a header border to resize, double-click to fit · name box: A1, K2:K100000
          </span>
        </div>
      </div>
    </div>
  )
}
