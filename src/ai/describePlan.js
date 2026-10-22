// A query plan in plain words, for the result card. Built from the plan
// itself (not from anything the model wrote), so it always matches what ran.

const OP_WORDS = {
    eq: 'is', neq: 'is not', gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
    contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', isEmpty: 'is empty', notEmpty: 'is not empty',
}
const FN_WORDS = { sum: 'total', avg: 'average', count: 'count', countDistinct: 'number of different', min: 'lowest', max: 'highest' }
const q = (v) => (typeof v === 'number' ? String(v) : `"${v}"`)

export function describePlan(plan) {
    const parts = []
    const filters = plan.filters || []
    if (filters.length) {
        parts.push('Rows where ' + filters.map(f => {
            const op = OP_WORDS[f.op] || f.op
            return f.op === 'isEmpty' || f.op === 'notEmpty' ? `${f.column} ${op}` : `${f.column} ${op} ${q(f.value)}`
        }).join(' and '))
    } else {
        parts.push('All rows')
    }
    const aggs = (plan.aggregates || []).map(a => {
        const label = a.as ? ` (as "${a.as}")` : ''
        return `${FN_WORDS[a.fn] || a.fn} of ${a.column}${label}`
    })
    if (plan.groupBy?.length) parts.push(`grouped by ${plan.groupBy.join(' and ')}` + (aggs.length ? `, showing ${aggs.join(', ')}` : ''))
    else if (aggs.length) parts.push(`showing ${aggs.join(', ')}`)
    else if (plan.columns?.length) parts.push(`showing ${plan.columns.join(', ')}`)
    if (plan.sort?.length) parts.push('sorted by ' + plan.sort.map(s => `${s.column} ${s.dir === 'desc' ? 'high to low' : 'low to high'}`).join(', then '))
    const limit = Math.min(plan.limit ?? 500, 500)
    if (plan.limit !== undefined) parts.push(plan.limit > 500 ? `first ${limit} rows (asked for ${plan.limit}, capped at 500)` : `first ${limit} row${limit === 1 ? '' : 's'}`)
    parts.push(plan.excludeTotalsRow === false ? 'totals row included' : 'totals row left out')
    return parts.join('; ') + '.'
}
