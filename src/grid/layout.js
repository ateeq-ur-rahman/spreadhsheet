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
