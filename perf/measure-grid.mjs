// Challenge 3 measurements against the production build, driven through the
// UI the way a user would do it.
//
//   npm run build
//   npm run preview -- --port 4173 --strictPort    (separate terminal)
//   npm run perf:grid -- [--url http://localhost:4173] [--browser /path/to/chrome]
//
// 1. First paint: fresh page loads; first-contentful-paint from the browser,
//    plus the time until grid cells are in the DOM.
// 2. Load Sample 3k, put =J2*2 in K2, name box K2:K100000, Ctrl+D.
// 3. Name box J95000, then scroll with the mouse wheel around row 95,000
//    while recording every animation frame.
// 4. Type into J95000 (about 130k filled cells at this point). Per key we
//    record: work = keydown until React has committed the update (the
//    'input' event has finished bubbling; React flushes typing updates
//    synchronously), and frame = keydown until the next animation frame
//    starts, i.e. when the browser paints it. Plus React commit counts.
import { chromium } from 'playwright-core'

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => {
        if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true])
        return acc
    }, []),
)
const BASE = (args.url || 'http://localhost:4173')
const executablePath = args.browser || process.env.CHROME_PATH || undefined
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
const median = (xs) => pct(xs, 0.5)
const f = (x) => x.toFixed(1)

const browser = await chromium.launch({ executablePath })
console.log(`Browser: ${browser.version()}`)

// 1. First paint
const fcps = []
const firstGrid = []
for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(BASE + '/?debug')
    await page.waitForSelector('.grid-line')
    const t = await page.evaluate(() => new Promise((resolve) => {
        new PerformanceObserver((list) => {
            const fcp = list.getEntries().find(e => e.name === 'first-contentful-paint')
            if (fcp) resolve({ fcp: fcp.startTime })
        }).observe({ type: 'paint', buffered: true })
        setTimeout(() => resolve({ fcp: NaN }), 2000)
    }))
    const nav = await page.evaluate(() => performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd)
    fcps.push(t.fcp)
    firstGrid.push(nav)
    await ctx.close()
}
console.log(`\nFirst paint (5 cold loads, 100,000 x 200 empty sheet)`)
console.log(`  first-contentful-paint: median ${f(median(fcps))} ms, max ${f(Math.max(...fcps))} ms`)
console.log(`  DOMContentLoaded end:   median ${f(median(firstGrid))} ms`)

// 2. Sample 3k + K2:K100000
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(BASE + '/?debug')
await page.getByText('Sample 3k').click()
await page.waitForFunction(() => window.__engine.getRaw(2991, 0) === 'Total') // the sample loads asynchronously
const nameBox = page.getByTestId('name-box')
const goto = async (ref) => { await nameBox.click(); await nameBox.fill(ref); await nameBox.press('Enter') }
await goto('K2')
await page.keyboard.type('=J2*2')
await page.keyboard.press('Enter')
await goto('K2:K100000')
const fillMs = await page.evaluate(() => new Promise((resolve) => {
    const t0 = performance.now()
    document.querySelector('[data-testid="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)))
}))
const filled = await page.evaluate(() => {
    const e = window.__engine
    let n = 0
    const used = e.getUsedRange()
    for (let r = 0; r <= used.r2; r++) for (let c = 0; c <= used.c2; c++) if (e.getRaw(r, c) !== '') n++
    return { n, k100000: e.getRaw(99999, 10) }
})
console.log(`\nCtrl+D on K2:K100000: ${f(fillMs)} ms until the next paint; K100000 = ${filled.k100000}; filled cells now ${filled.n}`)

// 3. Scroll around row 95,000 with the mouse wheel
await goto('J95000')
const box = await page.getByTestId('grid').boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.evaluate(() => {
    window.__frames = []
    const loop = (t) => { window.__frames.push(t); if (window.__recording) requestAnimationFrame(loop) }
    window.__recording = true
    requestAnimationFrame(loop)
})
const before = await page.evaluate(() => ({ ...window.__counters }))
for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, i < 30 ? 240 : -240)
    await page.waitForTimeout(16)
}
for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(i < 10 ? 400 : -400, 0)
    await page.waitForTimeout(16)
}
const frames = await page.evaluate(() => { window.__recording = false; return window.__frames })
const deltas = frames.slice(1).map((t, i) => t - frames[i])
const after = await page.evaluate(() => ({ ...window.__counters }))
const dom = await page.evaluate(() => document.querySelectorAll('.grid-cell').length)
console.log(`\nWheel scrolling near row 95,000 (80 wheel events, ${deltas.length} frames recorded)`)
console.log(`  frame time: median ${f(median(deltas))} ms, p95 ${f(pct(deltas, 0.95))} ms, max ${f(Math.max(...deltas))} ms`)
console.log(`  frames over 16.7 ms: ${deltas.filter(d => d > 16.7 + 1).length}, over 33 ms: ${deltas.filter(d => d > 33.4).length}`)
console.log(`  cell divs in the DOM: ${dom}; Grid commits ${after.grid - before.grid}, CellBlock commits ${after.cellBlocks - before.cellBlocks}`)

// 4. Type into J95000
await goto('J95000')
await page.evaluate(() => {
    window.__keys = []
    let t0 = 0
    let cur = null
    window.addEventListener('keydown', () => {
        t0 = performance.now()
        cur = { work: NaN, frame: NaN }
        window.__keys.push(cur)
        const mine = cur
        requestAnimationFrame(() => { mine.frame = performance.now() - t0 })
    }, true)
    // first key opens the editor (keydown); the rest arrive as input events
    window.addEventListener('input', () => { if (cur) cur.work = performance.now() - t0 })
    window.addEventListener('keydown', () => { if (cur && Number.isNaN(cur.work)) queueMicrotask(() => { if (Number.isNaN(cur.work)) cur.work = performance.now() - t0 }) })
})
const c0 = await page.evaluate(() => ({ ...window.__counters }))
await page.keyboard.type('1234567', { delay: 50 })
await page.waitForTimeout(100)
const c1 = await page.evaluate(() => ({ ...window.__counters }))
const keyStats = await page.evaluate(() => window.__keys)
const work = keyStats.map(k => k.work).filter(x => !Number.isNaN(x))
const frame = keyStats.map(k => k.frame).filter(x => !Number.isNaN(x))
const commitMs = await page.evaluate(() => new Promise((resolve) => {
    const input = document.querySelector('.grid-editor')
    const t0 = performance.now()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)))
}))
const c2 = await page.evaluate(() => ({ ...window.__counters }))
const result = await page.evaluate(() => ({ j: window.__engine.getRaw(94999, 9), k: window.__engine.getCell(94999, 10).computed }))
console.log(`\nTyping "1234567" into J95000 (${filled.n} filled cells)`)
console.log(`  keydown -> update committed: median ${f(median(work))} ms, max ${f(Math.max(...work))} ms (n=${work.length})`)
console.log(`  keydown -> next frame starts: median ${f(median(frame))} ms, max ${f(Math.max(...frame))} ms`)
console.log(`  React commits while typing 7 keys: Grid ${c1.grid - c0.grid}, CellBlock ${c1.cellBlocks - c0.cellBlocks}, CellEditor ${c1.editor - c0.editor}`)
console.log(`  Enter (commit + recalc K95000 + repaint): ${f(commitMs)} ms; commits: Grid ${c2.grid - c1.grid}, CellBlock ${c2.cellBlocks - c1.cellBlocks}`)
console.log(`  J95000 = ${result.j}, K95000 = ${result.k}`)

await browser.close()
