// Pixel geometry for the grid. Sizes are uniform for now; the variable
// size version (prefix sums) will keep the same offset/size/indexAt/total
// shape so the grid doesn't need to change.

export const HEADER_WIDTH = 50
export const HEADER_HEIGHT = 26
export const DEFAULT_COL_WIDTH = 100
export const DEFAULT_ROW_HEIGHT = 24

export function uniformAxis(count, size) {
    return {
        count,
        offset: (i) => i * size,
        size: () => size,
        total: () => count * size,
        // which index is at pixel px (clamped)
        indexAt: (px) => Math.max(0, Math.min(count - 1, Math.floor(px / size))),
    }
}
