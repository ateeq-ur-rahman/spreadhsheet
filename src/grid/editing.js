// Shared by the cell editor and the formula bar.

// Save the current edit and close the editor. Returns the cell that was
// edited, or null. Unchanged text isn't written, so no empty undo step.
export function commitEdit(engine, editStore) {
    const { editing, value } = editStore.get()
    if (!editing) return null
    if (engine.getRaw(editing.r, editing.c) !== value) engine.setCell(editing.r, editing.c, value)
    editStore.stop()
    return { r: editing.r, c: editing.c }
}

export function cancelEdit(editStore) {
    editStore.stop()
}
