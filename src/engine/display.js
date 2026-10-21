// What text a cell shows for its computed value.

export function formatGeneral(value) {
    if (typeof value === 'number') {
        if (Number.isInteger(value)) return String(value)
        return String(parseFloat(value.toPrecision(10)))
    }
    if (value === null || value === undefined) return ''
    return String(value)
}

export function displayText(cell) {
    if (cell.error) return cell.error
    return formatGeneral(cell.computed)
}
