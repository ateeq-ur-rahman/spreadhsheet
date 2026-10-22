// How many times each part of the grid has committed (rendered and been
// applied to the DOM). Counted in effects, read by perf/measure.mjs through
// window.__counters when the app is opened with ?debug.
export const counters = { grid: 0, cellBlocks: 0, editor: 0 }
