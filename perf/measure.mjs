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
import fs from 'node:fs'

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
await page.waitForFunction(() => window.__engine.getRaw(32, 0) === 'Total') // the sample loads asynchronously

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



// Challenge 2: sort sales-large.tsv by Date, and 10,000 generated rows
await page.getByText('Sample 3k').click()
await page.waitForFunction(() => window.__engine.getRaw(2991, 0) === 'Total')
await scenario(
    'C2 sort: Sample 3k (2,990 data rows) by Date, ascending',
    '',
    "e.sortColumn(1, 'asc')",
)
await scenario(
    'C2 sort: 10,000 generated rows (4 columns incl. a formula column) by a number column, descending',
    `const e = window.__engine
     e.clearAll()
     const ups = [{ row: 0, col: 0, raw: 'id' }, { row: 0, col: 1, raw: 'n' }]
     for (let r = 1; r <= 10000; r++) {
         ups.push({ row: r, col: 0, raw: 'ID-' + r }, { row: r, col: 1, raw: String((r * 7919) % 10007) },
                  { row: r, col: 2, raw: '$' + (r % 500) + '.00' }, { row: r, col: 3, raw: '=B' + (r + 1) + '*2' })
     }
     e.setCells(ups)`,
    "e.sortColumn(1, 'desc')",
)

// Challenge 4: every golden plan over sales-large.tsv, and a two-level
// group-by over 100,000 generated rows. Ctrl+K loads the AI module.
await page.getByText('Sample 3k').click()
await page.waitForFunction(() => window.__engine.getRaw(2991, 0) === 'Total')
await page.keyboard.press('Control+k')
await page.waitForFunction(() => window.__ai)
const golden = JSON.parse(fs.readFileSync(new globalThis.URL('../fixtures/ai-eval/queries.json', import.meta.url), 'utf8'))
const plans = golden.cases.filter(c => c.plan.type === 'query').map(c => ({ id: c.id, plan: c.plan }))
const perPlan = await page.evaluate((plans) => plans.map(({ id, plan }) => {
    const times = []
    for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        window.__ai.executeQuery(plan, window.__ai.readTable(window.__engine))
        times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    return { id, median: times[2], max: times[4] }
}), plans)
console.log('\nC4 golden plans over sales-large.tsv (read table + execute, 5 runs each)')
console.log('  ' + perPlan.map(p => `${p.id} ${p.median.toFixed(1)}/${p.max.toFixed(1)}`).join(', ') + '  (median/max ms)')
console.log(`  slowest max: ${Math.max(...perPlan.map(p => p.max)).toFixed(1)} ms`)
const groupBy = await page.evaluate(() => {
    const regions = ['North', 'South', 'East', 'West', 'Central']
    const cats = ['Electronics', 'Furniture', 'Accessories', 'Software']
    const rows = Array.from({ length: 100000 }, (_, i) => [regions[i % 5], String((i * 13) % 97), '$' + ((i % 1000) + 0.5), cats[(i * 7) % 4]])
    const table = { headers: ['Region', 'Units', 'Total', 'Category'], rows, totalsRow: null, range: { r1: 0, c1: 0, r2: 100000, c2: 3 } }
    const plan = { type: 'query', groupBy: ['Region', 'Category'], aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }, { fn: 'avg', column: 'Units', as: 'Avg units' }], sort: [{ column: 'Region' }, { column: 'Sales', dir: 'desc' }] }
    const times = []
    for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        window.__ai.executeQuery(plan, table)
        times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    return { median: times[2], max: times[4] }
})
console.log(`\nC4 two-level group-by over 100,000 generated rows: median ${groupBy.median.toFixed(1)} ms, max ${groupBy.max.toFixed(1)} ms`)
await browser.close()
