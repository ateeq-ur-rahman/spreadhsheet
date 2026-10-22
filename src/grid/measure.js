// Text width in px for auto-fit, using an offscreen canvas with the same
// font the grid cells use.
let ctx = null

export function measureText(text, style) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px "Courier New", monospace`
    return ctx.measureText(String(text)).width
}
