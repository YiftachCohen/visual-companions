// A drawn visual as SVG, for the mobile app, whose fonts can't be trusted to keep columns: a glyph
// its code font lacks (✓ ✗ ★ ●) falls back to a font of another width and shifts the rest of the row.
// Here each run of characters is pinned to its column and fitted to its cells, and the box-drawing
// lines are strokes, so rails and tracks join up whatever the font. The image scales down to the slot.

import { w } from './render'
import type { Line } from './render'

const FONT = 13
const CW = FONT * 0.6 // one cell's advance
const LH = Math.round(FONT * 1.5) // one row
const PAD = 10 // the ground's margin around the drawing
const BASE = LH / 2 + FONT * 0.35 // a row's baseline, so its text sits on the middle the strokes run through

// Claude Code's light and dark theme colours for the tones; text and strokes both take `color`. The image has its
// own ground in each scheme, since the app's theme may not be the phone's: text always contrasts with what it sits on.
const STYLE = `text{font-family:ui-monospace,Menlo,"SF Mono","Roboto Mono",monospace;font-size:${FONT}px;fill:currentColor}
path{fill:none;stroke:currentColor;stroke-width:1.2}
.bg{fill:#f5f4ef}svg{color:#1f1f1f}.ok{color:#2c7a39}.bad{color:#ab2b3f}.warn{color:#966c1e}.data{color:#5769f7}.pick{color:#d77757}.dim{color:#8a8a8a}.title{font-weight:600}
@media (prefers-color-scheme:dark){.bg{fill:#262624}svg{color:#e6e6e6}.ok{color:#4eba65}.bad{color:#ff6b80}.warn{color:#ffc107}.data{color:#b1b9f9}.dim{color:#8f8f8f}}`

// Box drawing as arms from the cell's middle: up, down, left, right; `round` bends the two arms it has.
type Arms = { u?: 1; d?: 1; l?: 1; r?: 1; heavy?: 1; dash?: 1; round?: 1 }
const BOX: Record<string, Arms> = {
  '─': { l: 1, r: 1 }, '━': { l: 1, r: 1, heavy: 1 }, '┄': { l: 1, r: 1, dash: 1 },
  '│': { u: 1, d: 1 }, '┃': { u: 1, d: 1, heavy: 1 }, '┊': { u: 1, d: 1, dash: 1 }, '┆': { u: 1, d: 1, dash: 1 },
  '┌': { r: 1, d: 1 }, '┐': { l: 1, d: 1 }, '└': { u: 1, r: 1 }, '┘': { u: 1, l: 1 },
  '├': { u: 1, d: 1, r: 1 }, '┤': { u: 1, d: 1, l: 1 },
  '╭': { r: 1, d: 1, round: 1 }, '╮': { l: 1, d: 1, round: 1 }, '╰': { u: 1, r: 1, round: 1 }, '╯': { u: 1, l: 1, round: 1 },
}

const n = (x: number) => String(Math.round(x * 10) / 10)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The path commands for one box-drawing cell whose top-left is (x, y). */
function arms(a: Arms, x: number, y: number): string {
  const cx = x + CW / 2, cy = y + LH / 2
  if (a.round) {
    const [ex, ey] = [a.l ? x : x + CW, a.u ? y : y + LH]
    return `M${n(ex)} ${n(cy)}Q${n(cx)} ${n(cy)} ${n(cx)} ${n(ey)}`
  }
  let d = ''
  if (a.l || a.r) d += `M${n(a.l ? x : cx)} ${n(cy)}H${n(a.r ? x + CW : cx)}`
  if (a.u || a.d) d += `M${n(cx)} ${n(a.u ? y : cy)}V${n(a.d ? y + LH : cy)}`
  return d
}

/** The visual's lines as an SVG document, at least `cols` cells wide so visuals in a column share one width. */
export function svg(lines: Line[], cols = 0): string {
  const width = Math.max(cols, ...lines.map(l => l.reduce((k, s) => k + w(s.t), 0)))
  const texts: string[] = []
  const paths = new Map<string, string>() // by class: one path per tone and stroke
  lines.forEach((line, row) => {
    const y = row * LH
    let col = 0
    for (const seg of line) {
      const tone = seg.tone ? ` class="${seg.tone}"` : ''
      let run = '', at = 0
      const flush = () => {
        if (!run) return
        const cells = w(run)
        texts.push(`<text x="${n(at * CW)}" y="${n(y + BASE)}" textLength="${n(cells * CW)}" lengthAdjust="spacingAndGlyphs"${tone}>${esc(run)}</text>`)
        run = ''
      }
      for (const c of seg.t) {
        const box = BOX[c]
        if (box || c === ' ') {
          flush()
          if (box) {
            const key = [seg.tone ?? '', box.heavy ? 'heavy' : '', box.dash ? (box.u ? 'vdash' : 'hdash') : ''].filter(Boolean).join(' ')
            paths.set(key, (paths.get(key) ?? '') + arms(box, col * CW, y))
          }
        } else {
          if (!run) at = col
          run += c
        }
        col += w(c)
      }
      flush()
    }
  })
  const strokes = [...paths].map(([cls, d]) => {
    const style = (cls.includes('heavy') ? 'stroke-width:2.4;' : '') + (cls.includes('vdash') ? `stroke-dasharray:${n(LH / 8)} ${n(LH / 8)};` : cls.includes('hdash') ? `stroke-dasharray:${n(CW / 3)} ${n(CW / 6)};` : '')
    const tone = cls.split(' ').find(c => !['heavy', 'vdash', 'hdash'].includes(c))
    return `<path d="${d}"${tone ? ` class="${tone}"` : ''}${style ? ` style="${style}"` : ''}/>`
  })
  const W = n(width * CW + 2 * PAD), H = n(lines.length * LH + 2 * PAD)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${STYLE}</style><rect class="bg" width="${W}" height="${H}" rx="8"/><g transform="translate(${PAD} ${PAD})">${strokes.join('')}${texts.join('')}</g></svg>`
}
