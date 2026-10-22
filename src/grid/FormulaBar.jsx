// The formula bar. It subscribes to the edit store on its own, so typing
// re-renders just this input and the cell editor, not the whole app.

import { useSyncExternalStore } from 'react'
import { commitEdit, cancelEdit } from './editing.js'

export default function FormulaBar({ engine, editStore, active, onCommitted }) {
    const editState = useSyncExternalStore(editStore.subscribe, editStore.get)
    const value = editState.editing ? editState.value : engine.getRaw(active.r, active.c)

    const handleFocus = () => {
        if (!editStore.get().editing) editStore.start(active.r, active.c, engine.getRaw(active.r, active.c), 'edit')
    }

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            const cell = commitEdit(engine, editStore)
            if (cell) onCommitted(cell)
            e.currentTarget.blur()
        } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelEdit(editStore)
            e.currentTarget.blur()
        }
    }

    return (
        <input
            className="formula-bar-input"
            value={value}
            onChange={(e) => editStore.setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
        />
    )
}
