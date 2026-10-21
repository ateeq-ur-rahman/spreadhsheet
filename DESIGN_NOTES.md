# Design notes

## Challenges

- **Challenge 1: range selection and fill handle** (`challenge-1-fill-handle`). Before the fill handle could work I had to fix the engine underneath it: the formula parser couldn't parse ranges, recalc redid everything on every edit, and undo didn't group anything. So this branch also carries the engine groundwork the later challenges build on.

## Data model changes

The engine (`src/engine/core.js`) owns everything: values, formulas, styles and undo. React only holds the current selection. The text you're typing into a cell lives in a tiny store (`src/grid/editStore.js`), so keystrokes don't re-render the grid.

What's inside the engine:

- **`cells`**: a `Map` keyed by `row * 16384 + col`. I switched from `"A1"` strings to numbers because they're cheaper to build and compare. Each entry holds the raw text, the value if it's a constant, and the parsed formula if it starts with `=`. Formulas are parsed once when written, not on every read.
- **`computed`**: the current value of every formula cell. Recalc fills it in; reading a cell never triggers evaluation.
- **`styles`**: full style objects per cell (bold, italic, underline, bg, color, align, fontSize, numberFormat). Identical styles share one frozen object. They used to be React state keyed by `"r,c"`, which meant they couldn't be undone and didn't move when you inserted a row.
- **Dependency index**: `refDeps` maps a cell to the formulas that reference it directly. `rangeDeps` and `rangeCols` handle ranges, so `SUM(A1:A100)` depends on all 100 cells, not just A1 and A100.
- **Undo/redo stacks**: each entry is a label plus the list of operations that reverse it.

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
| `fill(source, target)` | the fill handle, see below; returns `{filled, cleared}` | the whole fill |
| `insertRow(at, n)` / `deleteRow(at, n)` | rows; formulas, styles and values move | the insert/delete |
| `insertColumn(at, n)` / `deleteColumn(at, n)` | same for columns | the insert/delete |
| `transact(label, fn)` | run `fn` as one undo step; if it throws, everything it did is rolled back | everything inside |
| `undo()` / `redo()` | | |
| `canUndo()`, `canRedo()`, `undoLabel()`, `redoLabel()` | for the toolbar and tests | |
| `ensureCapacity(rows, cols)` | grow the sheet bounds (not undoable, doesn't touch data) | |
| `subscribe(fn)` / `version` | change notifications; the UI uses `version` as its snapshot | |

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

## Undo

Every change is made of small operations: set a cell, set a style, insert/delete rows or columns. Each one records how to reverse itself as it runs, and a transaction collects them into one undo entry. Undo plays the reversals backwards, and that records the redo steps in the same way.

Deleting rows records "insert them back, restore the deleted cells and styles, and restore the original text of every formula the delete rewrote". Nothing takes a full copy of the sheet any more.

| Action | One Ctrl+Z undoes |
|---|---|
| Editing a cell (Enter, Tab, clicking away, formula bar) | that cell |
| Delete/Backspace on a selection, or ✕ Clear | the whole selection |
| Dragging the fill handle (filling or shrinking) | the whole fill |
| Bold/italic/underline/size/align/colour on a selection | the whole selection |
| Insert/delete rows or columns (as many as are selected) | the whole insert/delete |
| ⬇ Sample 33 / ⬇ Sample 3k | the whole load |
| ✕ All | everything |

## UI

- **Selection.** Click to select, drag for a rectangle, Shift+Click or Shift+Arrow to extend. Clicking a row or column header selects the whole row or column (drag across headers for several). The top-left corner and Ctrl+A select the used range. The logic is in `src/grid/selection.js`, kept separate from React so it's easy to test.
- **Grid** (`src/grid/Grid.jsx`). One scrolling area with sticky headers. Mouse events are worked out from coordinates rather than a handler on every cell. While dragging, it keeps scrolling if you go past the edge.
  - Cells only re-render when the engine changes, not when the selection moves or you type.
  - Empty cells aren't rendered; the grid lines are a CSS background.
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

Setup: Linux container, headless Chromium 141 through Playwright, production build (`npm run build` then `vite preview`). The script is `perf/measure.mjs` (`npm run perf`). It opens the app with `?debug` (which exposes the engine as `window.__engine`), loads Sample 33 with the toolbar button, and runs each scenario 5 times, undoing in between.

- "Engine" is just the `fill` call, including recalculation.
- "Until next paint" also includes React rendering and two animation frames.

| Budget | Scenario | Engine | Until next paint |
|---|---|---|---|
| Fill 5,000 cells in under 200 ms | K2 `=G2*H2` dragged to K5001 (5,000 formulas) | median 35.9 ms, max 48.2 ms | median 283.8 ms, max 575.9 ms |
| Fill 5,000 cells in under 200 ms | A2:E3 (IDs, dates, names) dragged down 1,000 rows | median 4.0 ms, max 8.2 ms | median 180.1 ms, max 219.0 ms |

The fill itself is well within budget. Painting the result isn't yet, because this branch still renders every row header and every filled cell. Only rendering what's on screen is Challenge 3. The same 5,000-formula fill took 70 ms in Node (Vitest, cold start).

For comparison, before these changes: loading Sample 3k and rendering it took 8.5 s (153,612 `<td>` elements), and inserting a row with 50,000 filled cells took 7.5 s in Node.

## Tests

`npm test` runs 59 tests:

- `values.test.js`: how numbers, dates and text are read.
- `formula.test.js`: parser, errors, fill translation, insert/delete rewriting, and regression tests for the bugs above.
- `fill.test.js`: every kind of series.
- `engine.test.js`: transactions, rollback, no-op edits, styles through insert/delete, clearing, fill in each direction, used range.
- `selection.test.js`: selection and fill-handle direction.
- `acceptance.challenge1.test.js`: the four acceptance checks from the challenge, on `sales.tsv`.
- `core.test.js`: the original starter tests, unchanged.

I also drove the UI in the production build with Playwright using real mouse and keyboard input: Shift+Click, header clicks, fill-handle drags that scroll past the edge, F2, double-click, Escape, Delete then undo, Ctrl+A, and drag-select.

## AI

Not started yet (Challenges 4 and 5).

## Trade-offs and what I'd do next

- Formatting a whole column writes one style entry per cell. They share one object, so it's cheap, but row- and column-level formatting would be better.
- The range index scans every range formula in a column when a cell in that column changes. With thousands of overlapping ranges I'd switch to an interval tree.
- Currency text like `$1.00, $2.00` repeats instead of counting up.
- No copy/paste yet.

## Use of AI tools

I used Claude as a coding assistant: for the initial audit of the repo, drafting the engine rewrite and the tests, and drafting these notes. I reviewed the code, and every result in this file comes from running the tests and scripts in this repo.
