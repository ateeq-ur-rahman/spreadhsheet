// Pixel geometry for the grid. An axis answers: where does row/column i
// start (offset), how big is it (size), how long is everything (total), and
// which one is at pixel px (indexAt). When every size is the default we use
// plain multiplication; otherwise prefix sums with a binary search.

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

// Rows or columns with different sizes (a hidden row is size 0). prefix[i]
// is where item i starts, so offset is a lookup and indexAt is a binary
// search over prefix.
export function variableAxis(count, sizeAt) {
    const prefix = new Float64Array(count + 1)
    for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + sizeAt(i)
    return {
        count,
        offset: (i) => prefix[i],
        size: (i) => prefix[i + 1] - prefix[i],
        total: () => prefix[count],
        indexAt(px) {
            if (px <= 0) return firstVisible(0)
            if (px >= prefix[count]) return lastVisible(count - 1)
            // last i with prefix[i] <= px; zero-size items share a prefix with
            // the next one, so this lands on a visible item
            let lo = 0
            let hi = count - 1
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1
                if (prefix[mid] <= px) lo = mid
                else hi = mid - 1
            }
            return lo
        },
    }
    function firstVisible(i) {
        while (i < count - 1 && prefix[i + 1] === prefix[i]) i++
        return i
    }
    function lastVisible(i) {
        while (i > 0 && prefix[i + 1] === prefix[i]) i--
        return i
    }
}

// Pick the cheap axis when nothing is customised. customSize(i) returns a
// size in px or null for the default; hidden is a Set of zero-size indices.
export function buildAxis(count, defaultSize, { customSize = null, hidden = null } = {}) {
    if (!customSize && (!hidden || hidden.size === 0)) return uniformAxis(count, defaultSize)
    return variableAxis(count, (i) => {
        if (hidden && hidden.has(i)) return 0
        return (customSize && customSize(i)) ?? defaultSize
    })
}
