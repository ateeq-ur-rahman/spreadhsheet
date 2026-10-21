// The cell being edited and its current text. This lives outside React
// state on purpose: typing should re-render the editor and the formula
// bar, not the whole grid.
//
// mode 'enter': started by typing over a cell, arrow keys commit and move
// mode 'edit':  started with F2 / Enter / double-click / formula bar,
//               arrow keys move the caret

export function createEditStore() {
    let state = { editing: null, value: '' }
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn() }
    return {
        get: () => state,
        subscribe(fn) {
            listeners.add(fn)
            return () => listeners.delete(fn)
        },
        start(r, c, value, mode) {
            state = { editing: { r, c, mode }, value }
            emit()
        },
        setValue(value) {
            if (value === state.value) return
            state = { ...state, value }
            emit()
        },
        stop() {
            if (!state.editing) return
            state = { editing: null, value: '' }
            emit()
        },
    }
}
