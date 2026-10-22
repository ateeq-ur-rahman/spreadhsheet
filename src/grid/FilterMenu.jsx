// Dropdown for one column header: sort buttons, a condition, and a checklist
// of the column's distinct values. Nothing changes until Apply, and Apply is
// one undo step.

import { useEffect, useMemo, useRef, useState } from 'react'
import { colToLetters } from '../engine/address.js'

const CONDITIONS = [
    { op: '', label: 'No condition' },
    { op: 'contains', label: 'Text contains' },
    { op: 'gt', label: 'Greater than' },
    { op: 'lt', label: 'Less than' },
    { op: 'isEmpty', label: 'Is empty' },
]

export default function FilterMenu({ engine, col, anchor, onSort, onClose }) {
    const values = useMemo(() => engine.getFilterValues(col), [engine, col])
    const current = engine.getFilter(col)
    const [search, setSearch] = useState('')
    const [checked, setChecked] = useState(() => new Set(current?.include ?? values.map(v => v.key)))
    const [op, setOp] = useState(current?.condition?.op ?? '')
    const [opValue, setOpValue] = useState(current?.condition?.value ?? '')
    const ref = useRef(null)

    // Close on Escape or a click anywhere else. The listeners go on in the
    // next tick: React runs this effect while the mousedown that opened the
    // menu is still bubbling, and we'd catch our own opening click otherwise.
    // Clicks on a header ▾ are left to the grid, which toggles the menu.
    useEffect(() => {
        const onDown = (e) => {
            if (ref.current?.contains(e.target)) return
            if (e.target.dataset?.action === 'filter') return
            onClose()
        }
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', onDown)
            document.addEventListener('keydown', onKey)
        }, 0)
        return () => {
            clearTimeout(timer)
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    const needle = search.trim().toLowerCase()
    const shown = needle ? values.filter(v => v.label.toLowerCase().includes(needle)) : values
    const allShownChecked = shown.every(v => checked.has(v.key))

    const toggle = (key) => {
        const next = new Set(checked)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        setChecked(next)
    }

    const toggleAllShown = () => {
        const next = new Set(checked)
        for (const v of shown) {
            if (allShownChecked) next.delete(v.key)
            else next.add(v.key)
        }
        setChecked(next)
    }

    const apply = () => {
        // with a search typed in, only the matching values that are ticked count
        const keys = (needle ? shown : values).filter(v => checked.has(v.key)).map(v => v.key)
        const include = keys.length === values.length ? null : keys
        const condition = op ? { op, value: op === 'isEmpty' ? null : opValue } : null
        engine.setFilter(col, include || condition ? { include, condition } : null)
        onClose()
    }

    const clearThis = () => {
        engine.setFilter(col, null)
        onClose()
    }

    const clearAll = () => {
        engine.clearFilters()
        onClose()
    }

    return (
        <div ref={ref} className="filter-menu" style={{ left: anchor.x, top: anchor.y }} role="dialog" aria-label={`Filter column ${colToLetters(col)}`}>
            <div className="filter-menu-row">
                <button className="toolbar-btn" onClick={() => { onSort('asc'); onClose() }}>Sort A → Z</button>
                <button className="toolbar-btn" onClick={() => { onSort('desc'); onClose() }}>Sort Z → A</button>
            </div>

            <div className="filter-menu-section">Filter by condition</div>
            <div className="filter-menu-row">
                <select className="toolbar-select" value={op} onChange={(e) => setOp(e.target.value)}>
                    {CONDITIONS.map(c => <option key={c.op} value={c.op}>{c.label}</option>)}
                </select>
                {op && op !== 'isEmpty' && (
                    <input className="filter-menu-input" value={opValue} onChange={(e) => setOpValue(e.target.value)} placeholder="Value" />
                )}
            </div>

            <div className="filter-menu-section">Filter by values</div>
            <input className="filter-menu-input wide" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" />
            <label className="filter-menu-item">
                <input type="checkbox" checked={allShownChecked} onChange={toggleAllShown} />
                <span>(Select all{needle ? ' shown' : ''})</span>
            </label>
            <div className="filter-menu-list">
                {shown.map(v => (
                    <label key={v.key} className="filter-menu-item">
                        <input type="checkbox" checked={checked.has(v.key)} onChange={() => toggle(v.key)} />
                        <span>{v.label}</span>
                        <span className="filter-menu-count">{v.count}</span>
                    </label>
                ))}
                {shown.length === 0 && <div className="filter-menu-empty">No matches</div>}
            </div>

            <div className="filter-menu-row end">
                <button className="toolbar-btn" onClick={clearThis} disabled={!current}>Clear column</button>
                <button className="toolbar-btn" onClick={clearAll}>Clear all</button>
                <button className="toolbar-btn active" onClick={apply}>Apply</button>
            </div>
        </div>
    )
}
