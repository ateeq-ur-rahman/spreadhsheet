// Selection helpers. A selection is { anchor, focus }: anchor is where you
// started (the active cell), focus is the corner that dragging, Shift+Click
// and Shift+Arrow move around.

export const cellSelection = (r, c) => ({ anchor: { r, c }, focus: { r, c } })

export function selectionRange(sel) {
    return {
        r1: Math.min(sel.anchor.r, sel.focus.r),
        c1: Math.min(sel.anchor.c, sel.focus.c),
        r2: Math.max(sel.anchor.r, sel.focus.r),
        c2: Math.max(sel.anchor.c, sel.focus.c),
    }
}

export function rangeSelection(range) {
    return { anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r2, c: range.c2 } }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// arrow keys: move the active cell, or grow the selection with Shift
export function moveSelection(sel, dr, dc, bounds, extend = false) {
    if (extend) {
        return {
            anchor: sel.anchor,
            focus: { r: clamp(sel.focus.r + dr, 0, bounds.rows - 1), c: clamp(sel.focus.c + dc, 0, bounds.cols - 1) },
        }
    }
    return cellSelection(clamp(sel.anchor.r + dr, 0, bounds.rows - 1), clamp(sel.anchor.c + dc, 0, bounds.cols - 1))
}

export function extendTo(sel, r, c) {
    return { anchor: sel.anchor, focus: { r, c } }
}

export function rowSelection(r1, r2, bounds) {
    return { anchor: { r: r1, c: 0 }, focus: { r: r2, c: bounds.cols - 1 } }
}

export function columnSelection(c1, c2, bounds) {
    return { anchor: { r: 0, c: c1 }, focus: { r: bounds.rows - 1, c: c2 } }
}

// Fill handle: given the pointer at (r, c), what range are we filling to?
// We grow in whichever direction the pointer is furthest out, or shrink if
// it's been dragged back inside the selection.
export function fillTarget(source, r, c) {
    const dDown = r - source.r2
    const dUp = source.r1 - r
    const dRight = c - source.c2
    const dLeft = source.c1 - c
    const dv = Math.max(dDown, dUp, 0)
    const dh = Math.max(dRight, dLeft, 0)
    if (dv === 0 && dh === 0) {
        // back inside: shrink from the bottom or right edge
        const rowsCut = source.r2 - r
        const colsCut = source.c2 - c
        if (rowsCut <= 0 && colsCut <= 0) return { ...source }
        if (rowsCut >= colsCut) return { ...source, r2: r }
        return { ...source, c2: c }
    }
    if (dv >= dh) {
        return dDown > 0 ? { ...source, r2: r } : { ...source, r1: r }
    }
    return dRight > 0 ? { ...source, c2: c } : { ...source, c1: c }
}
