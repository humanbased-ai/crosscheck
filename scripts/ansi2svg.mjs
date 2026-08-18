// Minimal ANSI -> terminal-window SVG renderer.
// Handles the subset chalk emits here: bold(1), dim(2), reset(22/39/0), fg 30-37/90-97.
import { readFileSync, writeFileSync } from 'fs'

const FG = {
  30: '#3b4048', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef',
  35: '#c678dd', 36: '#56b6c2', 37: '#dcdfe4',
  90: '#7f848e', 91: '#e06c75', 92: '#98c379', 93: '#e5c07b', 94: '#61afef',
  95: '#c678dd', 96: '#56b6c2', 97: '#ffffff',
}
const DEFAULT_FG = '#c8ccd4'
const BG = '#21252b'
const CHAR_W = 8.6
const LINE_H = 20
const PAD_X = 18
const PAD_TOP = 52

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Split a line into styled runs.
function parseLine(line) {
  const runs = []
  let fg = null, bold = false, dim = false
  let i = 0
  const re = /\x1b\[([0-9;]*)m/g
  let m
  while ((m = re.exec(line)) !== null) {
    if (m.index > i) runs.push({ text: line.slice(i, m.index), fg, bold, dim })
    for (const codeStr of m[1].split(';')) {
      const code = Number(codeStr || '0')
      if (code === 0) { fg = null; bold = false; dim = false }
      else if (code === 1) bold = true
      else if (code === 2) dim = true
      else if (code === 22) { bold = false; dim = false }
      else if (code === 39) fg = null
      else if (FG[code]) fg = FG[code]
    }
    i = m.index + m[0].length
  }
  if (i < line.length) runs.push({ text: line.slice(i), fg, bold, dim })
  return runs
}

const WIDE_G = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const cellLen = t => [...t].reduce((n, ch) => n + (WIDE_G.test(ch) ? 2 : 1), 0)

export function render(ansi, { title = '', width } = {}) {
  const lines = ansi.replace(/\r/g, '').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()

  const plainLen = l => cellLen(l.replace(/\x1b\[[0-9;]*m/g, ''))
  const cols = Math.max(...lines.map(plainLen), title.length + 8)
  const w = width ?? Math.ceil((cols + 2) * CHAR_W + PAD_X * 2)
  const h = Math.ceil(lines.length * LINE_H + PAD_TOP + 18)

  const body = lines.map((line, row) => {
    const y = PAD_TOP + row * LINE_H
    let x = PAD_X
    const spans = []
    for (const run of parseLine(line)) {
      if (!run.text) continue
      // Advance past leading spaces rather than emitting them — renderers vary in
      // whether they honour xml:space on leading whitespace.
      const lead = run.text.match(/^ */)[0].length
      if (lead) x += lead * CHAR_W
      const text = run.text.slice(lead)
      if (!text) continue
      const fill = run.fg ?? DEFAULT_FG
      // textLength pins each run to its exact monospace width, so alignment does not
      // depend on which font the rasteriser happens to resolve.
      const runW = cellLen(text) * CHAR_W
      const attrs = [
        `x="${x.toFixed(1)}"`, `y="${y}"`, `fill="${fill}"`,
        `textLength="${runW.toFixed(1)}"`, 'lengthAdjust="spacing"',
        run.bold ? 'font-weight="600"' : '',
        run.dim ? 'opacity="0.55"' : '',
        'xml:space="preserve"',
      ].filter(Boolean).join(' ')
      spans.push(`<text ${attrs}>${esc(text)}</text>`)
      x += runW
    }
    return spans.join('')
  }).join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13.5">
  <rect width="${w}" height="${h}" rx="8" fill="${BG}"/>
  <rect width="${w}" height="34" rx="8" fill="#2c313a"/>
  <rect y="26" width="${w}" height="8" fill="#2c313a"/>
  <circle cx="20" cy="17" r="6" fill="#ff5f58"/>
  <circle cx="40" cy="17" r="6" fill="#ffbd2e"/>
  <circle cx="60" cy="17" r="6" fill="#18c132"/>
  ${title ? `<text x="${w / 2}" y="22" fill="#8b919b" font-size="12" text-anchor="middle">${esc(title)}</text>` : ''}
${body}
</svg>`
}

const [, , inFile, outFile, ...rest] = process.argv
if (inFile) {
  const title = rest.join(' ')
  writeFileSync(outFile, render(readFileSync(inFile, 'utf8'), { title }))
  console.log('wrote', outFile)
}
