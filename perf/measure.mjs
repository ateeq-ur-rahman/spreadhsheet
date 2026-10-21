// Perf numbers against the production build.
//
//   npm run build
//   npm run preview -- --port 4173 --strictPort    (separate terminal)
//   npm run perf -- [--url http://localhost:4173] [--runs 5] [--browser /path/to/chrome]
//
// Opens the app with ?debug so window.__engine is available, runs each
// scenario a few times (undoing in between) and prints median/max for the
// engine call and for "until the next paint".
//
// Uses playwright-core, which doesn't download a browser. Point it at one
// with --browser or CHROME_PATH.
import { chromium } from 'playwright-core'

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => {
        if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true])
        return acc
    }, []),
)
const URL = (args.url || 'http://localhost:4173') + '/?debug'
const RUNS = Number(args.runs || 5)
const executablePath = args.browser || process.env.CHROME_PATH || undefined

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const fmt = (xs) => `median ${median(xs).toFixed(1)} ms, max ${Math.max(...xs).toFixed(1)} ms (n=${xs.length})`

const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(URL)
await page.waitForFunction(() => window.__engine)

console.log(`Browser: ${browser.version()}  URL: ${URL}  runs: ${RUNS}`)

// run `body` in the page (it gets the engine as `e`) and time it
async function timeInPage(body) {
    return page.evaluate(async (src) => {
        const e = window.__engine
        const fn = new Function('e', src)
        const t0 = performance.now()
        fn(e)
        const t1 = performance.now()
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        return { engineMs: t1 - t0, paintMs: performance.now() - t0 }
    }, body)
}

async function scenario(name, setup, body) {
    await page.evaluate(new Function(setup))
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const engineMs = []
    const paintMs = []
    for (let i = 0; i < RUNS; i++) {
        const t = await timeInPage(body)
        engineMs.push(t.engineMs)
        paintMs.push(t.paintMs)
        await page.evaluate(() => window.__engine.undo())
    }
    console.log(`\n${name}\n  engine:        ${fmt(engineMs)}\n  to next paint: ${fmt(paintMs)}`)
    return { engineMs, paintMs }
}

// start from Sample 33, loaded with the toolbar button like a user would
await page.getByText('Sample 33').click()

// Challenge 1: fill 5,000 cells
await scenario(
    'C1 fill: K2 (=G2*H2) dragged down to K5001 — 5,000 formula cells',
    "window.__engine.setCell(1, 10, '=G2*H2')",
    'e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 5001, c2: 10 })',
)
await scenario(
    'C1 fill: A2:E3 (id, date, text) dragged down 1,000 rows — 5,000 cells',
    '',
    'e.fill({ r1: 1, c1: 0, r2: 2, c2: 4 }, { r1: 1, c1: 0, r2: 1002, c2: 4 })',
)

await browser.close()
