// "Ask your data" side panel (Ctrl+K).
//
// prompt -> model -> checked plan -> our executor -> result card.
// The model only ever produces the plan; every number on a card comes from
// executeQuery() running over the sheet. Re-run executes the same plan
// again without asking the model. Insert writes the table into the sheet
// as one undo step.

import { useEffect, useRef, useState } from 'react'
import { createProvider } from './provider.js'
import { requestAction } from './pipeline.js'
import { readTable } from './sheetTable.js'
import { buildContext } from './context.js'
import { executeQuery } from './executor.js'
import { describePlan } from './describePlan.js'
import { parseA1, toA1 } from '../engine/address.js'
import './AiPanel.css'

const EXAMPLES = [
    'What is the total sales by region?',
    'Top 3 sales reps by total sales',
    'How many orders were placed in February 2024?',
    'Break down sales by region and category',
]
const HISTORY_TURNS = 4 // earlier exchanges sent along for follow-up questions

const ERROR_TITLES = {
    PROVIDER_ERROR: "Couldn't get an answer from the model",
    INVALID_RESPONSE: "The model's answer wasn't a valid plan",
    READ_ONLY: 'That would change the sheet. I can only read it.',
    UNKNOWN_OP: 'The plan used a filter I don\'t know',
    UNKNOWN_FN: 'The plan used a calculation I don\'t know',
    UNKNOWN_SORT_COLUMN: 'The plan sorts by a column that isn\'t in the result',
}
const REASONS = {
    network: 'network', auth: 'authentication', rate_limit: 'rate limit', timeout: 'timeout', no_key: 'no API key', upstream: 'provider error', bad_response: 'bad response',
}

let nextId = 1

// ?debug (which sets window.__engine) also exposes the executor for perf/measure.mjs
if (typeof window !== 'undefined' && window.__engine) window.__ai = { readTable, executeQuery }

export default function AiPanel({ engine, selection, activeCell, onClose }) {
    const [provider] = useState(() => createProvider())
    const [entries, setEntries] = useState([])
    const [prompt, setPrompt] = useState('')
    const inputRef = useRef(null)
    const listRef = useRef(null)

    useEffect(() => { inputRef.current?.focus() }, [])
    useEffect(() => {
        const list = listRef.current
        if (list) list.scrollTop = list.scrollHeight
    }, [entries.length])

    const update = (id, patch) => setEntries(list => list.map(e => (e.id === id ? { ...e, ...patch } : e)))

    const ask = async (text) => {
        const question = text.trim()
        if (!question) return
        const id = nextId++
        setPrompt('')
        setEntries(list => [...list, { id, prompt: question, pending: true }])

        const table = readTable(engine)
        const context = buildContext(table, selection)
        const history = entries.filter(e => e.raw).slice(-HISTORY_TURNS)
            .flatMap(e => [{ role: 'user', content: e.prompt }, { role: 'assistant', content: e.raw }])
        const answer = await requestAction({ provider, prompt: question, context, history })

        if (answer.kind === 'query') {
            const result = executeQuery(answer.action, table)
            update(id, { pending: false, answer, result, ranAt: new Date() })
        } else {
            update(id, { pending: false, answer })
        }
    }

    const rerun = (entry) => {
        // same plan, fresh data, no model call
        update(entry.id, { result: executeQuery(entry.answer.action, readTable(engine)), ranAt: new Date(), reruns: (entry.reruns || 0) + 1 })
    }

    const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            ask(prompt)
        } else if (e.key === 'Escape') {
            onClose()
        }
    }

    return (
        <aside className="ai-panel" aria-label="Ask your data" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
            <header className="ai-panel-head">
                <strong>Ask your data</strong>
                <span className={'ai-badge ' + provider.name}>{provider.name === 'mock' ? 'mock provider' : 'live model'}</span>
                <button className="ai-close" onClick={onClose} title="Close (Esc)">✕</button>
            </header>

            <div className="ai-list" ref={listRef}>
                {entries.length === 0 && (
                    <div className="ai-empty">
                        <p>Ask a question about the table on the sheet. The model writes a plan; the numbers are worked out here, from your data.</p>
                        <div className="ai-examples">
                            {EXAMPLES.map(x => <button key={x} onClick={() => ask(x)}>{x}</button>)}
                        </div>
                    </div>
                )}
                {entries.map(entry => (
                    <div key={entry.id} className="ai-entry">
                        <div className="ai-prompt">{entry.prompt}</div>
                        {entry.pending
                            ? <div className="ai-card pending">Thinking…</div>
                            : <Answer entry={entry} engine={engine} activeCell={activeCell} onRerun={() => rerun(entry)} onToggle={(k) => update(entry.id, { [k]: !entry[k] })} />}
                    </div>
                ))}
            </div>

            <div className="ai-input">
                <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="e.g. Total sales by region   (Enter to ask, Shift+Enter for a new line)"
                    rows={2}
                />
                <button className="toolbar-btn active" onClick={() => ask(prompt)} disabled={!prompt.trim()}>Ask</button>
            </div>
        </aside>
    )
}

function Answer({ entry, engine, activeCell, onRerun, onToggle }) {
    const { answer, result } = entry

    if (answer.kind === 'clarify') {
        return <div className="ai-card clarify"><span className="ai-label">Question back</span>{answer.question}<PlanToggle entry={entry} onToggle={onToggle} /></div>
    }
    if (answer.kind === 'error') {
        return (
            <div className="ai-card error" role="alert">
                <div className="ai-error-title">{ERROR_TITLES[answer.error] || answer.error}</div>
                <div className="ai-error-code">
                    {answer.error}{answer.reason ? ` (${REASONS[answer.reason] || answer.reason})` : ''}
                </div>
                <div className="ai-error-detail">{answer.detail}</div>
                <PlanToggle entry={entry} onToggle={onToggle} />
            </div>
        )
    }

    // a query plan that ran
    if (result.error === 'UNKNOWN_COLUMN') {
        // ask the user rather than guess a similar column
        const missing = result.detail.replace(/^UNKNOWN_COLUMN:/, '')
        const names = readTable(engine).headers.map(h => String(h).trim()).filter(Boolean)
        return (
            <div className="ai-card clarify">
                <span className="ai-label">Question back</span>
                There's no column called <b>"{missing}"</b>. Which one did you mean? The columns are: {names.join(', ')}.
                <div className="ai-error-code">UNKNOWN_COLUMN</div>
                <PlanToggle entry={entry} onToggle={onToggle} />
            </div>
        )
    }
    if (result.error) {
        return (
            <div className="ai-card error" role="alert">
                <div className="ai-error-title">{ERROR_TITLES[result.error] || result.error}</div>
                <div className="ai-error-detail">{result.detail}</div>
                <PlanToggle entry={entry} onToggle={onToggle} />
            </div>
        )
    }
    return (
        <div className="ai-card result">
            <div className="ai-plan-words">{describePlan(answer.action)}</div>
            <div className="ai-meta">
                {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                {result.truncated ? ' (more matched; showing the first ' + result.rowCount + ')' : ''}
                {entry.reruns ? ` · re-run ${entry.reruns}×` : ''}
            </div>
            <ResultTable result={result} />
            <div className="ai-actions">
                <button className="toolbar-btn" onClick={onRerun} title="Run the same plan again on the current data (no model call)">Re-run</button>
                <InsertButton engine={engine} result={result} activeCell={activeCell} />
                <PlanToggle entry={entry} onToggle={onToggle} inline />
            </div>
        </div>
    )
}

function ResultTable({ result }) {
    const fmt = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v)
    return (
        <div className="ai-table-wrap">
            <table className="ai-table">
                <thead><tr>{result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                    {result.rows.map((row, i) => (
                        <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : ''}>{fmt(v)}</td>)}</tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

// Writes the header and rows at a cell the user picks (the active cell by
// default). One transaction, so one Ctrl+Z takes it all back out.
function InsertButton({ engine, result, activeCell }) {
    const [target, setTarget] = useState(null) // null = not choosing
    const [error, setError] = useState(null)

    const insert = () => {
        const at = parseA1(target)
        if (!at) { setError('Not a cell'); return }
        const updates = []
        result.columns.forEach((c, j) => updates.push({ row: at.row, col: at.col + j, raw: String(c) }))
        result.rows.forEach((row, i) => row.forEach((v, j) => {
            updates.push({ row: at.row + 1 + i, col: at.col + j, raw: v === null || v === undefined ? '' : String(v) })
        }))
        engine.setCells(updates, 'Insert query result')
        setTarget(null)
        setError(null)
    }

    if (target === null) {
        return <button className="toolbar-btn" onClick={() => setTarget(toA1(activeCell.r, activeCell.c))} title="Write this table into the sheet">Insert into sheet</button>
    }
    return (
        <span className="ai-insert">
            at <input value={target} onChange={(e) => { setTarget(e.target.value); setError(null) }} onKeyDown={(e) => { if (e.key === 'Enter') insert() }} className={error ? 'bad' : ''} title={error || 'Top-left cell of the inserted table'} />
            <button className="toolbar-btn active" onClick={insert}>Insert</button>
            <button className="toolbar-btn" onClick={() => setTarget(null)}>Cancel</button>
        </span>
    )
}

function PlanToggle({ entry, onToggle, inline = false }) {
    const shown = entry.showPlan
    const content = entry.answer.action ? JSON.stringify(entry.answer.action, null, 2) : entry.answer.raw
    if (!content) return null
    return (
        <>
            <button className={'ai-link' + (inline ? ' inline' : '')} onClick={() => onToggle('showPlan')}>{shown ? 'Hide plan' : 'Show plan'}</button>
            {shown && <pre className="ai-plan">{content}</pre>}
        </>
    )
}
