# Design notes

## Challenges

- **Challenge 1: range selection and fill handle** (`challenge-1-fill-handle`). Before the fill handle could work I had to fix the engine underneath it: the formula parser couldn't parse ranges, recalc redid everything on every edit, and undo didn't group anything. So this branch also carries the engine groundwork the later challenges build on.
- **Challenge 2: sort and filter** (`challenge-2-sort-filter`, built on Challenge 1). Rows and columns got stable ids, sort is a real edit that moves rows (and formulas follow them), and filters are a view that only hides rows.
- **Challenge 3: virtualized grid** (`challenge-3-virtual-grid`, built on Challenge 2). The sheet is 100,000 × 200 and only what's on screen is rendered. Frozen first row/column use sticky panes. Column widths and row heights live in the engine, keyed by id. Adds the name box, Ctrl+Home/End, Page Up/Down and Ctrl+D.

## Data model changes

The engine (`src/engine/core.js`) owns everything: values, formulas, styles and undo. React only holds the current selection. The text you're typing into a cell lives in a tiny store (`src/grid/editStore.js`), so keystrokes don't re-render the grid.

What's inside the engine:

- **`cells`**: a `Map` keyed by `row * 16384 + col`. I switched from `"A1"` strings to numbers because they're cheaper to build and compare. Each entry holds the raw text, the value if it's a constant, and the parsed formula if it starts with `=`. Formulas are parsed once when written, not on every read.
- **`computed`**: the current value of every formula cell. Recalc fills it in; reading a cell never triggers evaluation.
- **`styles`**: full style objects per cell (bold, italic, underline, bg, color, align, fontSize, numberFormat). Identical styles share one frozen object. They used to be React state keyed by `"r,c"`, which meant they couldn't be undone and didn't move when you inserted a row.
- **Dependency index**: `refDeps` maps a cell to the formulas that reference it directly. `rangeDeps` and `rangeCols` handle ranges, so `SUM(A1:A100)` depends on all 100 cells, not just A1 and A100.
- **Undo/redo stacks**: each entry is a label plus the list of operations that reverse it.
- **Row and column ids** (`rowIds`, `colIds`): one number per position. Inserting, deleting or sorting moves the ids along with the data. Sort uses row ids to get back to the original order. Filters are stored per column id, so inserting a column in front doesn't move a filter onto the wrong column. Undoing a delete puts the same ids back.
- **Filters**: a `Map` from column id to `{ include, condition }`. Hidden rows aren't stored; they're worked out from the current values and cached until something changes.
- **Sort state**: which column is sorted and which way, plus the block's row ids from before the first sort (for the third click, "original order").
- **Column widths and row heights**: two `Map`s from column/row id to pixels. Missing means the default (100 × 24). Keying by id is what makes sizes travel with their column: insert a column before D and the new D has no entry (default width), while the old D, now E, keeps its 300 px. Undoing a delete brings back the same ids, so their sizes come back too.
- **Frozen panes**: `{ rows, cols }`, how many top rows and left columns stay put. It's in the engine (not React state) because changing it is an undo step, and the AI format action will set it too.

Things that are always true:
- After a transaction finishes, every formula cell has a computed value.
- Raw text is stored exactly as typed. Cells that are empty after trimming aren't stored.
- Formula text is the real data; the parsed AST is just a cache of it. Inserting or deleting rows rewrites the text.
- A transaction that changes nothing doesn't create an undo entry. The one exception is fill (explained below).

## Formulas

`src/engine/formula.js` is a small recursive-descent parser. I replaced the original shunting-yard parser because it couldn't handle `A1:A2` at all.

- It supports `+ - * /`, unary minus, brackets, `A1` / `$A$1` / `$A1` / `A$1`, ranges, `#REF!`, and `SUM`, `AVG`/`AVERAGE`, `MIN`, `MAX`, `COUNT` with any number of arguments.
- Arithmetic reads text the way the AI contract's `toNum` does: `"$9,720.00"` is 9720 and `"10%"` is 0.1. Blank is 0. Text that isn't a number gives `#VALUE!`.
  - I did this because the sample data stores prices as text, and the acceptance checks (`=G2*H2`, `=J2/G2`) expect real numbers.
  - SUM and friends skip blanks and text.
  - `/0` gives `#DIV/0!`, an unknown function gives `#NAME?`, and a cycle gives `#CYCLE!`.
- References are rewritten on the token list, not with a regex. Every token remembers where it sits in the original text, so I splice in the new reference and leave everything else (spacing, function-name case) alone.
  - `translateFormula` is used by fill. It moves references except the `$` parts.
  - `remapFormulaStructural` is used by insert/delete. Here `$` references move too, because they should keep pointing at the same cell.
  - Deleting a referenced row gives `#REF!` instead of silently pointing at the wrong row.

## Engine API

Coordinates are zero-based; a range is `{r1, c1, r2, c2}`, inclusive.

| Method | What it does | One Ctrl+Z undoes |
|---|---|---|
| `getCell(r, c)` | `{raw, computed, error}`, same shape as before (`computed` is `''` when blank) | |
| `getValue(r, c)` | computed value: a number, text, or an error code like `#REF!` | |
| `getRaw(r, c)` | raw text, `''` when blank | |
| `getStyle(r, c)` | the cell's style, or `DEFAULT_STYLE` | |
| `getUsedRange()` | box around all non-empty cells, or null | |
| `getContentBounds()` | same, but styled empty cells count too (used to limit rendering) | |
| `setCell(r, c, raw)` | write one cell | that edit |
| `setCells(updates, label?)` | write many cells at once (`[{row, col, raw}]`) | all of them |
| `clearRange(range)` | clear contents; formatting stays | the whole clear |
| `setStyle(range, patch)` | merge `patch` into every cell's style | the whole range |
| `clearStyles(range)` | reset formatting | the whole range |
| `clearAll()` | wipe content and formatting | everything |
| `fill(source, target, { copy })` | the fill handle, see below; `copy: true` just repeats the seeds (Ctrl+D / Ctrl+R); returns `{filled, cleared}` | the whole fill |
| `insertRow(at, n)` / `deleteRow(at, n)` | rows; formulas, styles and values move | the insert/delete |
| `insertColumn(at, n)` / `deleteColumn(at, n)` | same for columns | the insert/delete |
| `transact(label, fn)` | run `fn` as one undo step; if it throws, everything it did is rolled back | everything inside |
| `undo()` / `redo()` | | |
| `canUndo()`, `canRedo()`, `undoLabel()`, `redoLabel()` | for the toolbar and tests | |
| `ensureCapacity(rows, cols)` | grow the sheet bounds (not undoable, doesn't touch data) | |
| `subscribe(fn)` / `version` | change notifications; the UI uses `version` as its snapshot | |
| `sortColumn(col, dir, range?)` | sort by a column, `dir` is `'asc'`, `'desc'` or `'original'`; `range` is a selection to sort instead of the whole table | the sort |
| `cycleSort(col, range?)` | what the ⇅ button does: asc, then desc, then original; returns the direction it used | that click |
| `getSortState()` | `{ col, dir }` or null | |
| `clearSortState()` | forget the sort (used when loading a sample) | |
| `setFilter(col, spec)` | set or clear (`null`) one column's filter, see below | that change |
| `getFilter(col)` | the column's filter spec or null | |
| `clearFilters()` | remove every filter | all of them |
| `getFilterValues(col)` | distinct values for the checklist: `[{ key, label, count }]` | |
| `getHiddenRows()` / `isRowHidden(r)` | rows hidden by filters | |
| `filterStatus()` | `{ visible, total }` data rows, or null with no filter on | |
| `getRowId(r)` / `getColId(c)` | stable ids | |
| `getColWidth(c)` / `getRowHeight(r)` | size in px, or null for the default | |
| `hasCustomColWidths()` / `hasCustomRowHeights()` | whether any size is set (the grid uses the cheap uniform layout if not) | |
| `setColWidth(cols, width)` / `setRowHeight(rows, height)` | one index or a list; `null` resets to the default | the resize |
| `autoFitColumns(cols, measure)` | widest displayed text + padding, clamped to 30..600 px; `measure(text, style)` is passed in because the engine can't measure text itself (no DOM); returns the widths | the whole auto-fit |
| `getFrozen()` / `setFrozen(rows, cols)` | frozen panes | the change |
| `sizeVersion` | bumps when a size or the frozen panes change | |

## How fill decides what to write

`src/engine/fill.js` looks at one line of seeds at a time: a column if you drag up or down, a row if you drag left or right. Seed positions are 0..n−1. Dragging forward asks for position n and up; dragging backward asks for −1 and down, which is how dragging upward continues a series in reverse.

- **Numbers.** One seed is copied. Two or more follow a best-fit line, which is exact for evenly spaced seeds (1, 2 → 3, 4).
- **Dates** (the three formats in the sample). One seed goes +1 day. Two or more follow the trend in days. Each new cell uses the format of the seed it lines up with.
- **Weekday and month names.** Mon → Tue, Sat, Sun → Mon, Jan → Feb. Case is copied from the seed (MON, mon, Mon).
- **Text ending in a number with the same prefix** (ORD-1001, Q4, 2024-W01). The number counts up and zero padding is kept.
- **Everything else** (plain text, formulas, mixed seeds) repeats. Formulas are then shifted, so `=G2*H2` filled 30 rows down becomes `=G32*H32`.
- Filled cells take the style of the seed they line up with.
- Dragging back into the selection shrinks it and clears the cells that got cut off.

Three decisions worth knowing about:
- **A single seed.** A plain number or plain text is copied, but "Item 1", a date or "Mon" counts up by one. That's what Excel does, and I read "one seed → copy" in the spec as being about plain values.
- **The date acceptance check.** B2:B4 is 2024-01-03, 2024-01-05, 1/8/2024: days 0, 2 and 5, so not evenly spaced. I use the same best-fit rule as for numbers (2.5 days per step, rounded), giving 2024-01-10, 2024-01-13, 1/15/2024, 2024-01-18. Each cell keeps its seed's format.
- **Fill always gets its own undo step,** even when it writes what was already there. In `sales.tsv`, A4:A6 already contain ORD-1003…1005, so the A2:A3 → A6 acceptance fill changes nothing. Without the extra step, pressing Ctrl+Z afterwards would undo the whole sample load.

## Sort and filter

**Sorting is a real edit.** Rows get moved, and that's one undo step. Which rows move:
- With a multi-cell selection (not whole rows or columns), exactly the selected rows. Whole rows move, not just the selected columns, so nothing gets out of line.
- Otherwise row 2 to the last used row. Row 1 is the header. A last row that starts with Total/Totals/Subtotal/Sum (the contract's rule) stays pinned at the bottom.
- With a filter on, only the visible rows swap places among themselves. Hidden rows keep their positions.

How values compare:
- Numbers come before dates, then text, then errors. Blanks always go last, whichever direction.
- Currency and percent text count as numbers (`$9,720.00` is 9720).
- The three date formats are compared as dates.
- Text is compared ignoring case and surrounding spaces.
- Ties keep their current order (stable).
- Descending flips everything except blanks, so text comes before numbers, as in Excel.
- A row with no typed content goes after everything else, even rows whose key is just blank. Formulas don't count as content, because in the sample the empty row 19 still gets `=J19/G19` from the fill. So in the acceptance check ORD-1021 (no Total) comes second to last and the empty row last, just above Total.

Formulas follow rows. Sorting is a "permute" operation:
- Every single reference into the sorted block is rewritten to where its row went, across the whole sheet, `$` refs included. `=J2/G2` sitting in a moved row still points at its own row afterwards.
- Ranges are left exactly as written, so `=SUM(J2:J32)` doesn't change. Partly overlapping ranges are also left alone (that's what Excel does).
- Styles and row ids move with their rows.
- Undo is the inverse permutation.

The ⇅ button cycles ascending → descending → original order. "Original" puts the rows back in the order they had before the first sort, matched by row id, so it still works after you've edited values in between.

**Filters are a view.** They never change data, formulas still see hidden rows, and hidden rows have zero height in the grid, so the row numbers show gaps. Each column's filter is:
- `include`: the ticked values from the checklist (as trimmed lower-case keys, `''` for blanks), or `null` for everything
- `condition`: contains, greater than, less than or is empty, or `null`

A row must pass both parts, and every filtered column (AND). Greater/less than compare as dates when the value is a date, otherwise as numbers, the same rule as the AI query executor. Filtering covers rows 2 to the last used row. The totals row isn't special here: it hides like any other row that doesn't match.

**"West", "West " and "west".** Filtering Region to West matches all three. The checklist groups values the same way the contract normalises text (trim and lower-case), so the three spellings are one entry, "West" (whichever came first), with a count of 8. I think that's what someone filtering by region expects. Treating "west" as a different region would hide data because of a typo.

Changing a filter is an undo step, since the acceptance check expects "undo twice" to remove both the sort and the filter.

UI:
- Clicking a column letter still selects the column (Challenge 1). Each column with data gets two small buttons: ⇅ to sort and ▾ for the filter menu.
- The menu has sort buttons, a condition, a search box, a checklist with counts and (Blanks), and Apply / Clear column / Clear all.
- The status line shows "8 of 32 rows" with a Clear filters button.
- Arrow keys skip hidden rows.

## Undo

Every change is made of small operations: set a cell, set a style, insert/delete rows or columns, move rows (sort), set a filter. Each one records how to reverse itself as it runs, and a transaction collects them into one undo entry. Undo plays the reversals backwards, and that records the redo steps in the same way.

Deleting rows records "insert them back, restore the deleted cells and styles, and restore the original text of every formula the delete rewrote". Nothing takes a full copy of the sheet any more.

| Action | One Ctrl+Z undoes |
|---|---|
| Editing a cell (Enter, Tab, clicking away, formula bar) | that cell |
| Delete/Backspace on a selection, or ✕ Clear | the whole selection |
| Dragging the fill handle (filling or shrinking) | the whole fill |
| Bold/italic/underline/size/align/colour on a selection | the whole selection |
| Insert/delete rows or columns (as many as are selected) | the whole insert/delete |
| ⬇ Sample 33 / ⬇ Sample 3k | the whole load |
| ✕ All | everything (content, formatting, filters, sort state) |
| ⇅ click or Sort A→Z / Z→A in the menu | that sort (each click is its own step) |
| Apply in the filter menu, Clear column, Clear all, Clear filters | that filter change |
| Dragging a column or row border | that resize (the drag previews live; the engine is written once on release) |
| Double-click a column border (auto-fit), double-click a row border (reset height) | that change |
| ❄ Row 1 / ❄ Col A | the freeze change |
| Ctrl+D / Ctrl+R | the whole fill |

## UI

- **Selection.** Click to select, drag for a rectangle, Shift+Click or Shift+Arrow to extend. Clicking a row or column header selects the whole row or column (drag across headers for several). The top-left corner and Ctrl+A select the used range. The logic is in `src/grid/selection.js`, kept separate from React so it's easy to test.
- **Grid** (`src/grid/Grid.jsx`). One scrolling area. Mouse events are worked out from coordinates rather than a handler on every cell. While dragging, it keeps scrolling if you go past the edge.
  - **Only what's visible is rendered.** On each scroll (at most once per animation frame) the grid works out which rows and columns are in view, adds 8 rows and 3 columns of overscan on each side, and renders those.
  - **Positions come from an axis per direction** (`src/grid/layout.js`). With all-default sizes it's plain multiplication. Once any size differs, or a filter hides rows, it's a prefix-sum array (`Float64Array`) built once per change, and "which row is at pixel y" is a binary search over it. For 100,000 rows that array takes well under a millisecond to build.
  - **Frozen panes are sticky divs.** A top strip (column headers + frozen rows) is `position: sticky; top: 0`. A left strip (row numbers + frozen columns) is `sticky; left: 0`. Inside the top strip, a corner block is sticky to the left. The browser keeps them in place, so they can't lag behind the scroll the way a JS-synced copy would. Each pane draws its own copy of the selection box and clips it, so a selection crossing into frozen rows looks continuous. The fill handle is drawn once, in the pane holding the selection's corner.
  - **Grid lines** are one 1px div per visible row and column boundary (about 60), not a border on every cell. Only cells with content or formatting become DOM nodes. On an empty screen that's zero cell divs; scrolling near row 95,000 with column K filled, it was 43.
  - **No React state per cell.** Cells render from the engine inside a memoized `CellBlock` that only re-renders when the engine changes or the visible window moves. Typing goes through the edit store, so a keystroke re-renders only the cell editor and the formula bar (`FormulaBar.jsx` subscribes on its own). The grid and the cell blocks don't re-render.
- **Resize.** Drag a column header's right border or a row number's bottom border. The new size shows live while dragging and is written to the engine once, on release (one undo step). Double-click a column border to auto-fit (text measured with a canvas, `src/grid/measure.js`); double-click a row border to reset its height.
- **Name box** (left of the formula bar). Type `AZ5000` to jump there, or `K2:K100000` to select a range, then Enter. Anything that isn't a cell or range on the sheet turns the box red with a tooltip, rather than being ignored.
- **Keyboard.** Ctrl+Home goes to A1, Ctrl+End to the last used cell, Page Up/Down move a screen of rows (Shift extends). Ctrl+D fills the top row of the selection down into the rest; Ctrl+R fills right. Both copy, they don't continue a series, like Excel. All of this works far from the origin because it only uses row/column indices and the axes.
- **How to fill K2 = `=J2*2` down to row 100,000.** Type `=J2*2` in K2, type `K2:K100000` in the name box and press Enter, then press Ctrl+D. (Dragging the fill handle 100,000 rows would also work, but nobody wants to watch that.)
- **Editing.** Double-click, Enter or F2 open the editor with the current text; arrow keys move the caret. Typing a character replaces the content, and arrow keys then save and move. Enter/Shift+Enter save and move down/up, Tab/Shift+Tab save and move right/left, Escape cancels. Clicking somewhere else saves.
- **Formatting.** Toolbar buttons and Ctrl+B/I/U apply to the whole selection. Toggles look at the active cell.

## Bugs I found in the existing code

| # | Where | What went wrong | Why | Fix |
|---|---|---|---|---|
| D1 | parser | `=SUM(A1:A2)` gave `#PARSE!`, and the starter test failed | When the parser hit `:`, the cell after it hadn't been read yet, so there was only one cell to pop | Rewrote the parser |
| D2 | `executeSetCell` | Every edit made every formula recompute on the next read | `_generation++` on each edit invalidated the whole cache | Recalc only the changed cells and what depends on them |
| D3 | `updateDependencies` | Changing a cell in the middle of a SUM range didn't update the SUM | Only the two corners of a range were tracked | Track every cell in a range (indexed by column) |
| D4 | recalc | Slow (O(n²)) and could overflow the stack on long chains | `sorted.includes` in a loop, `queue.shift`, recursive DFS | Iterative DFS; tested on a 20,000-cell chain |
| D5 | insert/delete | 7.5 s to insert a row with 50k filled cells | Rebuilt everything and recalculated every cell | Only rewrite and recalc formulas whose text changes |
| D6 | delete | Deleting row 5 turned `=A5` into `=A4`, which is different data; deleting row 1 turned a reference into a self-reference | Never produced `#REF!` | References to deleted cells become `#REF!` |
| D7 | tokenizer | `$A$1` and `=2-3*-1` gave `#PARSE!` | Not supported | New tokenizer |
| D8 | value parsing | `"12abc"` became 12, while `"$1,200.00"` stayed text, so `=G2*H2` failed on the sample | `parseFloat` everywhere | Strict check for typed numbers, contract `toNum` in arithmetic |
| D9 | `AVG`/`MIN`/`MAX` | Blanks and text counted as 0 | NaN was turned into 0 and kept | Skip non-numbers |
| D10 | self-reference | `=A1+1` in A1 showed `#VALUE!` | The `#CYCLE!` string ended up in arithmetic | Proper cycle check during recalc |
| D11 | sample load / clear all | One undo entry per cell, so loading 3k rows wiped the 100-step history | No grouping | Load and clear are each one transaction |
| D12 | styles in `App.jsx` | Didn't move with rows, couldn't be undone, only applied to one cell | React state keyed by position | Styles moved into the engine |
| D13 | structural undo | Every insert/delete copied the whole sheet | Snapshot-based undo | Undo records only what changed |
| D14 | layout | With a wide grid the whole page scrolled sideways, not the grid | Vite's `index.css` centres `body` with flexbox, so `#root` grew to the grid's width | Pin `#root` to the screen; `min-width: 0` on the grid |

## Measurements

**Environment.** Linux cloud container with 2 vCPUs (Intel Xeon 2.8 GHz) and headless Chromium 141 through Playwright, against the production build (`npm run build` then `vite preview`). This machine is slow: a plain 100-million-iteration JS loop takes 1.3 s here, roughly 10× slower than a current laptop. A blank HTML page reaches first contentful paint in about 50 ms, and a bare React "hello" page (same React build, nothing else) in about 96 ms. So read every number below as a pessimistic upper bound. To re-run on your own machine: `npm run build`, `npm run preview -- --port 4173 --strictPort`, then `npm run perf` and `npm run perf:grid` (add `--browser` with your Chrome path).

**Scripts.**
- `perf/measure.mjs` (fill and sort): opens the app with `?debug` (which exposes `window.__engine` and `window.__counters`), loads the sample with the toolbar button, and runs each scenario 5 times, undoing in between. "Engine" is just the engine call, including recalculation. "Until next paint" adds React rendering and two animation frames.
- `perf/measure-grid.mjs` (the grid): drives the UI the way a user would (sample button, name box, Ctrl+D, mouse wheel, typing) and records frames with `requestAnimationFrame`.

**Commit counts** come from `src/grid/perfCounters.js`: `useEffect` hooks without dependencies count each commit of the Grid, each CellBlock and each cell editor. React's `<Profiler>` doesn't report in production builds, so this is the production-build equivalent of what the React DevTools profiler shows.

Fill and sort (measured on `challenge-3-virtual-grid`, so painting now benefits from virtualization):

| Budget | Scenario | Engine | Until next paint |
|---|---|---|---|
| Fill 5,000 cells in under 200 ms | K2 `=G2*H2` dragged to K5001 (5,000 formulas) | median 35.3 ms, max 58.7 ms | median 49.8 ms, max 68.6 ms |
| Fill 5,000 cells in under 200 ms | A2:E3 (IDs, dates, names) dragged down 1,000 rows | median 6.2 ms, max 7.3 ms | median 24.1 ms, max 30.3 ms |
| Sort 10,000 rows in under 300 ms | 10,000 generated rows, 4 columns including a formula column, by a number column, descending | median 77.7 ms, max 124.9 ms | median 88.0 ms, max 132.5 ms |
| Report: sort sales-large.tsv by Date | Sample 3k (2,990 data rows), Date ascending | median 37.2 ms, max 122.8 ms | median 50.4 ms, max 148.9 ms |

On the Challenge 1 and 2 branches, before virtualization, the same fill took 284 ms to paint and the Date sort 987 ms, because every row was in the DOM.

The grid (`npm run perf:grid`):

| Budget | What | Result |
|---|---|---|
| First paint under 100 ms | 5 cold loads of the empty 100,000 × 200 sheet, `first-contentful-paint` | median 268 ms, max 284 ms. **Not met on this machine.** DOMContentLoaded ends at a median 93 ms. See below. |
| Scrolling at 60 fps | 80 mouse-wheel events (vertical, then horizontal) near row 95,000 with K2:K100000 filled, 171 frames recorded | median frame 16.7 ms, p95 16.7 ms, max 16.8 ms; 0 frames over 16.7 ms. 43 cell divs in the DOM. 80 Grid commits and 160 CellBlock commits (one per wheel event; two cell blocks are visible). |
| Keystroke latency under 16 ms with 50,000 filled cells | typing `1234567` into J95000 with 129,593 filled cells | keydown until React has committed the update: median 1.5 ms, max 2.1 ms. Keydown until the next frame starts: median 2.6 ms, max 10.3 ms. Commits while typing 7 keys: Grid 1 (opening the editor), CellBlock 0, cell editor 32 (four panes × 8 updates). |
| Edits recalculate only dependent cells | Enter on J95000 | 22.3 ms from Enter to the next frame; Grid 2 commits, CellBlock 6. K95000 = 2,469,134 (only that formula was re-evaluated; recalc only follows dependency edges). |
| Acceptance: fill K2 = `=J2*2` to row 100,000 | name box `K2:K100000` + Ctrl+D | 766 ms until the next paint, 129,593 filled cells afterwards. No budget for this one; it's 100,000 formula parses plus one recalc pass. |

**First paint.** In this container the app reaches first contentful paint at about 270 ms, against about 96 ms for a bare React page and 50 ms for plain HTML. A trace splits our part into:
- about 25 ms evaluating the 249 KB bundle
- about 50 ms for React's first render
- about 50–60 ms of layout before the first frame

What I changed for it:
- The two sample files (264 KB of text) are now downloaded only when you click a sample button, which halved the main bundle.
- Grid lines are about 60 divs instead of a bordered div per visible cell.
- The first render already uses the window's size, so it covers the screen before the exact viewport size is measured.

I checked that canvas size (1,000 vs 100,000 rows; 20 vs 200 columns), fonts, emoji and shadows each make no measurable difference. Given that a bare React page needs 96 ms here, the budget can't be met on this hardware without dropping React from the first paint. On a typical laptop, about 10× faster here, the same work should land well under 100 ms, but I haven't measured that, so I'm not claiming it. `npm run perf:grid` reports it on whatever machine you run it on.

Acceptance (also scripted with Playwright on the production build): freeze row 1, drag D's border to 300 px, insert a column before D. Result: new D at the default width (`getColWidth` null), old D (now E) at 300 px with its data. Row 1 stays under the column headers while scrolling. Five undos take it all back.

For comparison, before these changes: loading Sample 3k and rendering it took 8.5 s (153,612 `<td>` elements), and inserting a row with 50,000 filled cells took 7.5 s in Node.

## Tests

`npm test` runs 83 tests:

- `values.test.js`: how numbers, dates and text are read.
- `formula.test.js`: parser, errors, fill translation, insert/delete rewriting, and regression tests for the bugs above.
- `fill.test.js`: every kind of series.
- `engine.test.js`: transactions, rollback, no-op edits, styles through insert/delete, clearing, fill in each direction, used range.
- `selection.test.js`: selection and fill-handle direction.
- `acceptance.challenge1.test.js`: the four acceptance checks from the challenge, on `sales.tsv`.
- `sortFilter.test.js`: the comparator, filter conditions, totals label, sort cycling, formulas and styles following rows, selection sorts, filters with AND, distinct values, filters surviving a column insert, row ids on undo.
- `acceptance.challenge2.test.js`: the Challenge 2 checks on `sales.tsv` (Total descending with K = J/G, West filter then Units sort, undo twice).
- `acceptance.challenge3.test.js`: K2:K100000 filled on `sales-large.tsv` (and editing J95000 updates K95000), freeze + resize D + insert column, row heights through sort/insert/delete, auto-fit clamping, Ctrl+D copying.
- `core.test.js`: the original starter tests, unchanged.

I also drove the UI in the production build with Playwright using real mouse and keyboard input: Shift+Click, header clicks, fill-handle drags that scroll past the edge, F2, double-click, Escape, Delete then undo, Ctrl+A, and drag-select. For Challenge 2 the same script runs the acceptance flow through the ⇅ buttons and the filter menu: sort Total descending, filter Region to West (8 of 32 rows, gaps in the row numbers), sort by Units with hidden rows staying put, two undos, arrow keys skipping hidden rows, and a condition filter combined with the checklist. For Challenge 3 a third script freezes row 1, resizes D by dragging its border, inserts a column, scrolls, auto-fits a column, drags a row height, checks Ctrl+End / Ctrl+Home / Page Down, and undoes everything. The Challenge 1 and 2 scripts were re-run on the virtualized grid and still pass.

## AI

Not started yet (Challenges 4 and 5).

## Trade-offs and what I'd do next

- Formatting a whole column writes one style entry per cell. They share one object, so it's cheap, but row- and column-level formatting would be better.
- The range index scans every range formula in a column when a cell in that column changes. With thousands of overlapping ranges I'd switch to an interval tree.
- Currency text like `$1.00, $2.00` repeats instead of counting up.
- No copy/paste yet.
- Hidden rows are recomputed from scratch after any change. That's fine at a few thousand rows; for 100k I'd only re-test the rows that changed.
- Fill and Delete on a filtered range still touch hidden rows (Excel skips them).
- Sorting a selection moves whole rows. Sorting only the selected columns would be closer to Excel, but it splits rows apart, and formulas following rows gets messy.
- First paint: next I'd render the toolbar and empty grid frame before React hydrates the cells, or ship a static shell in `index.html`. That's the only way I see to get under 100 ms on hardware this slow.
- Each wheel event re-renders the Grid component (cheap, since the cell blocks are memoized). A pure-DOM scroll layer that only re-renders when the window moves past the overscan would cut that further.
- Very long columns of formulas: the 100,000-row fill spends most of its time parsing the same formula shape 100,000 times; caching parsed ASTs by relative shape would make that much faster.
- Row heights are adjustable but text doesn't wrap, so a taller row just has more space.

## Use of AI tools

I used Claude as a coding assistant: for the initial audit of the repo, drafting the engine rewrite and the tests, and drafting these notes. I reviewed the code, and every result in this file comes from running the tests and scripts in this repo.
