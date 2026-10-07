// README and social art, drawn by the plugin's own renderer: every visual here is
// `draw()` output, so the pictures can't drift from what the plugin prints.
//
//   bun docs/art/build.ts          → docs/art/*.svg (animated)
//   bun docs/art/build.ts --png    → also docs/art/png/*.png (stills at 2×, for posting)
//   bun docs/art/build.ts --big    → the same art with big Boo, in docs/art/big-boo/

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { draw, parse, w } from '../../hooks/render'
import type { Line, Living, Tone } from '../../hooks/render'
import { card, lanes } from '../../hooks/land'
import { COLOR, DEFAULT, FRAMES, frameAt, mix } from '../../hooks/boo'
import type { BooMood } from '../../hooks/boo'
import { smallCells } from '../../hooks/boo-small'
import { flockCells } from '../../hooks/boo-flock'
import type { Pup } from '../../hooks/boo-flock'

// Small Boo is the plugin's default companion: one row of braille beside a one-line band.
const BIG = process.argv.includes('--big')
const OUT = BIG ? join(import.meta.dir, 'big-boo') : import.meta.dir
const PNG = process.argv.includes('--png')

// ── palette and type ─────────────────────────────────────────────────────

const C = {
  page: '#0a0b11',
  win: '#1a1b26',
  bar: '#13141c',
  edge: '#2a2e42',
  fg: '#c0caf5',
  bright: '#eef0fb',
  soft: '#9aa5ce',
  dim: '#565f89',
  ok: '#9ece6a',
  bad: '#f7768e',
  warn: '#e0af68',
  data: '#7aa2f7',
  pick: '#d97757',
  mixed: '#bb9af7',
}
const TONE: Record<Tone, string> = { ok: C.ok, bad: C.bad, warn: C.warn, data: C.data, dim: C.dim, title: C.bright, pick: C.pick }
const MONO = `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'JetBrains Mono', Consolas, 'Liberation Mono', monospace`
const SANS = `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif`

const FS = 15 // terminal font size
const CW = 9 // one cell
const LH = 23 // one row

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Seg = { t: string; fill?: string; bold?: boolean; italic?: boolean }
const toned = (l: Line): Seg[] => l.map(s => ({ t: s.t, fill: s.tone ? TONE[s.tone] : undefined, bold: s.tone === 'title' }))

/** One terminal row at (x, baseline y). Each run is pinned to its cells, so box drawing lines up whatever font the viewer has. */
function row(segs: Seg[], x: number, y: number, size = FS, cw = CW): string {
  let col = 0
  let out = ''
  // Runs split at gaps of two spaces or more, so a stretched run never spreads across a gap.
  for (const s of segs.flatMap(s => s.t.split(/(?<=\S)(?= {2,}\S)/).map(t => ({ ...s, t })))) {
    const lead = s.t.length - s.t.trimStart().length
    const body = s.t.trim()
    if (body) {
      const attrs = [s.bold ? ' font-weight="650"' : '', s.italic ? ' font-style="italic"' : ''].join('')
      out += `<text x="${x + (col + lead) * cw}" y="${y}" font-size="${size}" textLength="${w(body) * cw}" lengthAdjust="spacingAndGlyphs" fill="${s.fill ?? C.fg}"${attrs}>${esc(body)}</text>`
    }
    col += w(s.t)
  }
  return out
}

const block = (lines: Seg[][], x: number, y: number, size = FS, cw = CW, lh = LH) => lines.map((l, i) => row(l, x, y + i * lh + size, size, cw)).join('')

// ── time ─────────────────────────────────────────────────────────────────
// Every animation is one loop of `T` seconds. `on(...)` names the windows a part is visible in;
// a still (for PNG, and for reduced motion) shows each part as it stands at `STILL`.

let css = ''
let uid = 0
let T = 10
let STILL = 0

function on(windows: [number, number][], fade = 0.35, steps = false): string {
  const id = `a${uid++}`
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / T) * 100)).toFixed(3)}%`
  const at = (t: number) => windows.some(([a, b]) => t >= a && t < b)
  const keys: string[] = [`0%{opacity:${at(0) ? 1 : 0}}`]
  for (const [a, b] of windows) {
    if (steps) keys.push(`${pct(a)}{opacity:1}`, `${pct(b)}{opacity:0}`)
    else keys.push(`${pct(Math.max(0, a - 0.001))}{opacity:0}`, `${pct(a + fade)}{opacity:1}`, `${pct(b - fade)}{opacity:1}`, `${pct(b)}{opacity:0}`)
  }
  keys.push(`100%{opacity:${at(T - 0.001) ? 1 : 0}}`)
  css += `.${id}{opacity:${at(STILL) ? 1 : 0};animation:${id} ${T}s ${steps ? 'step-end' : 'linear'} infinite}@keyframes ${id}{${keys.join('')}}\n`
  return id
}

const g = (cls: string, body: string) => `<g class="${cls}">${body}</g>`

function svg(width: number, height: number, body: string, defs = '') {
  const style = `text{font-family:${MONO}} .sans{font-family:${SANS}} @media (prefers-reduced-motion: reduce){*{animation:none!important}}\n${css}`
  css = ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xml:space="preserve"><style>${style}</style><defs>${defs}</defs>${body}</svg>\n`
}

// ── Boo ──────────────────────────────────────────────────────────────────

/** One frame of big Boo as pixels, two to a terminal cell's height. */
function booFrame(frame: string, color: number, x: number, y: number, px = CW, py = LH / 2): string {
  const fade: Record<string, number> = { fading: 0.15, low: 0.3, lowBlink: 0.3, stuck: 0.3, stuckBlink: 0.3 }
  const body = mix(color, 0x808080, fade[frame] ?? 0)
  const paint: Record<string, string> = { b: hex(body), s: hex(mix(body, 0, 0.38)), e: '#16161e' }
  let out = ''
  FRAMES[frame].forEach((r, j) =>
    [...r].forEach((ch, i) => {
      if (paint[ch]) out += `<rect x="${(x + i * px).toFixed(1)}" y="${(y + j * py).toFixed(1)}" width="${px + 0.4}" height="${py + 0.4}" fill="${paint[ch]}"/>`
    }),
  )
  return out
}

/** Boo playing a mood's loop (from `from` seconds, for `dur`), sampled from the plugin's own timings. */
function boo(m: BooMood, x: number, y: number, from = 0, dur = T, px = CW, py = LH / 2, glow = true): string {
  const color = COLOR[m]
  const runs: { frame: string; a: number; b: number }[] = []
  for (let t = 0; t < dur * 1000; ) {
    const { frame, wait } = frameAt(m, t)
    const end = Math.min(dur * 1000, t + Math.max(20, wait))
    const last = runs[runs.length - 1]
    if (last && last.frame === frame) last.b = from + end / 1000
    else runs.push({ frame, a: from + t / 1000, b: from + end / 1000 })
    t = end
  }
  const frames = [...new Set(runs.map(r => r.frame))]
  const halo = glow
    ? `<ellipse cx="${x + 3 * px}" cy="${y + 2 * py}" rx="${5.5 * px}" ry="${4 * py}" fill="${hex(color)}" opacity="0.16" filter="url(#blur)"/>`
    : ''
  return halo + frames.map(f => g(on(runs.filter(r => r.frame === f).map(r => [r.a, r.b]), 0, true), booFrame(f, color, x, y, px, py))).join('')
}

const BLUR = `<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>`
const SHADOW = `<filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000" flood-opacity="0.55"/></filter>`

function pup(mood: 'working' | 'success' | 'blocked', x: number, y: number, k: number): string {
  const frames = [
    ['.##.', '#..#', '####', '#.#.'],
    ['.##.', '#..#', '####', '.#.#'],
  ]
  const color = hex(COLOR[mood])
  const paint = (f: string[]) => f.flatMap((r, j) => [...r].map((ch, i) => (ch === '#' ? `<rect x="${x + i * 4.5}" y="${y + j * 5.75}" width="3.4" height="4.4" rx="1.4" fill="${color}"/>` : ''))).join('')
  if (mood !== 'working') return paint(frames[0])
  const wins = (p: number): [number, number][] => Array.from({ length: Math.ceil(T / 0.32) }, (_, i) => [i * 0.32, i * 0.32 + 0.32] as [number, number]).filter((_, i) => (i + k) % 2 === p)
  return g(on(wins(0), 0, true), paint(frames[0])) + g(on(wins(1), 0, true), paint(frames[1]))
}

// ── small Boo: braille cells as dots ─────────────────────────────────────

let bare = false // draw dots only, without the cells' glow (for Boo shown outside a terminal)
const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] // [row][col] of a braille cell

/** Raster cells ([codePoint, fg, bg] each) as dots on their backgrounds, `cw` × `lh` a cell. */
function brailleSvg(cells: number[][], x: number, y: number, cw = CW, lh = LH): string {
  let out = ''
  cells.forEach(([code, fg, bg], i) => {
    const cx = x + i * cw
    if (bg !== DEFAULT && !bare) out += `<rect x="${cx}" y="${y}" width="${cw + 0.3}" height="${lh}" fill="${hex(bg)}"/>`
    if (code < 0x2800 || code > 0x28ff) return
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 2; c++)
        if ((code - 0x2800) & BRAILLE[r][c]) out += `<circle cx="${(cx + (c + 0.5) * (cw / 2)).toFixed(2)}" cy="${(y + lh * 0.1 + (r + 0.5) * (lh * 0.8 / 4)).toFixed(2)}" r="${(cw * 0.2).toFixed(2)}" fill="${hex(fg)}"/>`
  })
  return out
}

/** Cells that change over time, sampled every 20ms from `from` for `dur` seconds. Each cell animates on its own:
 *  every distinct drawing of a cell is drawn once and shown in its windows, which keeps the file small. */
function cellsOverTime(at: (ms: number) => number[][], x: number, y: number, from: number, dur: number, cw = CW, lh = LH): string {
  const runs = new Map<string, { i: number; cell: number[]; wins: [number, number][] }>()
  const prev: string[] = []
  for (let t = 0; t < dur * 1000; t += 20) {
    const s = from + t / 1000
    at(t).forEach((cell, i) => {
      if (cell[0] === 0x20 && cell[2] === DEFAULT) return void (prev[i] = '')
      const key = `${i}:${cell.join(',')}`
      const run = runs.get(key) ?? runs.set(key, { i, cell, wins: [] }).get(key)!
      if (prev[i] === key) run.wins[run.wins.length - 1][1] = s + 0.02
      else run.wins.push([s, s + 0.02])
      prev[i] = key
    })
  }
  return [...runs.values()].map(r => g(on(r.wins, 0, true), brailleSvg([r.cell], x + r.i * cw, y, cw, lh))).join('')
}

const smallBoo = (m: BooMood, x: number, y: number, from = 0, dur = T, cw = CW, lh = LH) => cellsOverTime(t => smallCells(m, t), x, y, from, dur, cw, lh)

const unglowed = (draw: () => string) => {
  bare = true
  try { return draw() } finally { bare = false }
}

const unpack = (b64: string) => {
  const u = new Uint32Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer)
  return Array.from({ length: u.length / 3 }, (_, i) => [u[i * 3], u[i * 3 + 1], u[i * 3 + 2]])
}
/** Boo's flock, one pup per agent: its cells (a blank, then two and a gap per pup). */
const flock = (pups: Pup[], x: number, y: number, from = 0, dur = T) => cellsOverTime(t => unpack(flockCells(pups, t)), x, y, from, dur)

// ── chrome ───────────────────────────────────────────────────────────────

function window(x: number, y: number, width: number, height: number, title: string): string {
  return (
    `<g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${C.win}"/></g>` +
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${width - 1}" height="${height - 1}" rx="14" fill="none" stroke="${C.edge}"/>` +
    `<path d="M${x} ${y + 40}V${y + 14}a14 14 0 0 1 14 -14H${x + width - 14}a14 14 0 0 1 14 14V${y + 40}Z" fill="${C.bar}"/>` +
    `<line x1="${x}" x2="${x + width}" y1="${y + 40.5}" y2="${y + 40.5}" stroke="${C.edge}"/>` +
    ['#f7768e', '#e0af68', '#9ece6a'].map((c, i) => `<circle cx="${x + 22 + i * 20}" cy="${y + 20}" r="6" fill="${c}" opacity="0.85"/>`).join('') +
    `<text class="sans" x="${x + width / 2}" y="${y + 25}" font-size="13" fill="${C.dim}" text-anchor="middle" font-family="${SANS}">${esc(title)}</text>`
  )
}

function backdrop(width: number, height: number, glows: [number, number, string, number][]): { defs: string; body: string } {
  const defs =
    glows.map(([, , c], i) => `<radialGradient id="glow${i}"><stop offset="0" stop-color="${c}" stop-opacity="1"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('') +
    `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#ffffff" opacity="0.045"/></pattern>`
  const body =
    `<rect width="${width}" height="${height}" fill="${C.page}"/>` +
    glows.map(([cx, cy, , r], i) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#glow${i})" opacity="0.13"/>`).join('') +
    `<rect width="${width}" height="${height}" fill="url(#dots)"/>`
  return { defs, body }
}

const viz = (src: string, cols: number, living?: Living) => draw(parse(src)!, cols, living).map(toned)

/** Rows that slide in one after another from `t`, and stay until `until`. */
function reveal(lines: Seg[][], x: number, y: number, t: number, until: number, gap = 0.07, lh = LH): string {
  return lines.map((l, i) => g(on([[t + i * gap, until]], 0.25), row(l, x, y + i * lh + FS))).join('')
}

// ── hero ─────────────────────────────────────────────────────────────────

function hero(): string {
  T = 16
  STILL = 12
  const W = 1600
  const H = 900
  const bg = backdrop(W, H, [[1250, 120, C.mixed, 620], [300, 860, C.pick, 520], [1150, 760, C.bad, 380]])

  // left: the pitch
  const lx = 104
  const pitch =
    `<text class="sans" x="${lx}" y="232" font-size="15" letter-spacing="3" fill="${C.pick}" font-weight="600">CLAUDE CODE PLUGIN</text>` +
    [`See where your`, `agent landed.`].map((s, i) => `<text class="sans" x="${lx - 4}" y="${318 + i * 76}" font-size="70" font-weight="700" letter-spacing="-2.2" fill="${C.bright}">${s}</text>`).join('') +
    [`Replies that report a result, a blocker or`, `a decision open with a small visual. Boo,`, `above the prompt, shows where work stands.`]
      .map((s, i) => `<text class="sans" x="${lx}" y="${462 + i * 34}" font-size="22" fill="${C.soft}">${s}</text>`)
      .join('') +
    `<rect x="${lx}" y="590" width="430" height="52" rx="10" fill="#ffffff" fill-opacity="0.04" stroke="${C.edge}"/>` +
    row([{ t: '$ ', fill: C.dim }, { t: '/plugin install ', fill: C.soft }, { t: 'visual-companions', fill: C.bright, bold: true }], lx + 20, 622, 16, 9.6)
  // the moods, in a row
  const moods: [BooMood, string][] = [['working', 'working'], ['success', 'green'], ['blocked', 'blocked'], ['mixed', 'mixed']]
  const strip = moods
    .map(([m, label], i) =>
      (BIG ? boo(m, lx + 6 + i * 92, 712, 0, T, 7, 7, false) : unglowed(() => smallBoo(m, lx - 28 + i * 120, 700, 0, T, 14, 36))) +
      `<text class="sans" x="${lx + (BIG ? 27 : 21) + i * (BIG ? 92 : 120)}" y="762" font-size="13" fill="${C.dim}" text-anchor="middle">${label}</text>`,
    )
    .join('')

  // right: the terminal
  const wx = 760
  const wy = 180
  const ww = 742
  const wh = 530
  const tx = wx + 26
  let ty = wy + 64
  const body: string[] = []
  // the prompt, typed
  const ask = 'Ship the 0.4 release'
  body.push(row([{ t: '> ', fill: C.dim }], tx, ty + FS))
  ask.split('').forEach((ch, i) => body.push(g(on([[0.3 + i * 0.045, T - 0.4]], 0.02), row([{ t: ch, fill: C.fg }], tx + (2 + i) * CW, ty + FS))))
  ty += LH * 2

  // the reply: the visual, then the prose
  const reply = viz(
    `flow Release is blocked at the migrate step
+ build
+ unit tests
x migrate | lock timeout above 10k rows
. deploy
> ? Batch the migration, or take downtime?`,
    76,
  )
  const R = 6.8
  body.push(g(on([[R, T - 0.4]], 0.2), row([{ t: '⏺', fill: C.bright }], tx, ty + FS)))
  body.push(reveal(reply, tx + 2 * CW, ty, R, T - 0.4))
  ty += reply.length * LH + 10
  const prose: Seg[][] = [
    [{ t: 'Build and unit tests pass. ' }, { t: 'migrate', fill: C.mixed }, { t: ' holds a table lock past 10k' }],
    [{ t: 'rows and timed out on ' }, { t: 'orders', fill: C.mixed }, { t: ' (2.4M rows). I stopped before deploy.' }],
  ]
  body.push(reveal(prose, tx + 2 * CW, ty, R + 0.8, T - 0.4, 0.12))

  // the band, above the prompt box
  const by = wy + wh - (BIG ? 132 : 108)
  const bx = tx
  const text = bx + (BIG ? 9 : 9) * CW
  // working: Boo drifts amber, the task counts up, the step underneath
  const steps: [string, string, number, number][] = [
    ['Release checklist 1/4', 'pnpm build', 1.4, 3.2],
    ['Release checklist 2/4', 'pnpm test --run', 3.2, 5.0],
    ['Release checklist 3/4', 'pnpm db:migrate --env=staging', 5.0, R],
  ]
  if (!BIG) {
    // One row: Boo, then the goal and task while working; where it landed when idle.
    body.push(g(on([[0, 1.4]], 0.15), smallBoo('neutral', bx, by, 0, 1.4) + row([{ t: 'Add order export → ', fill: C.dim }, { t: 'Order export ships behind a flag' }, { t: '  2h ago', fill: C.dim }], text, by + FS)))
    body.push(g(on([[1.4, R]], 0.15), smallBoo('working', bx, by, 1.4, R - 1.4)))
    for (const [task, , a, b] of steps) body.push(g(on([[a, b]], 0.12), row([{ t: `Ship the 0.4 release · ${task}` }], text, by + FS)))
    body.push(g(on([[R + 0.3, T - 0.4]], 0.2), smallBoo('blocked', bx, by, R + 0.3, T - R - 0.7)))
    body.push(g(on([[R + 0.3, T - 0.4]], 0.2), row([{ t: 'Needs you: Batch the migration, or take downtime?', fill: C.bright }, { t: '  just now', fill: C.dim }], text, by + FS)))
  }
  if (BIG) body.push(g(on([[1.4, R]], 0.15), boo('working', bx, by + 2, 1.4, R - 1.4)))
  if (BIG) for (const [task, cmd, a, b] of steps) {
    body.push(g(on([[a, b]], 0.12), row([{ t: 'Ship the 0.4 release · ' }, { t: task, fill: C.warn }], text, by + FS)))
    body.push(g(on([[a, b]], 0.12), row([{ t: `› ${cmd}`, fill: C.dim }], text, by + LH + FS)))
  }
  // idle, before the prompt: last session's outcome
  if (BIG) body.push(g(on([[0, 1.4]], 0.15), boo('neutral', bx, by + 2, 0, 1.4) + row([{ t: 'Order export ships behind a flag' }], text, by + FS) + row([{ t: 'Add order export · 2h ago', fill: C.dim }], text, by + LH + FS)))
  // blocked, waiting on you
  if (BIG) body.push(g(on([[R + 0.3, T - 0.4]], 0.2), boo('blocked', bx, by + 2, R + 0.3, T - R - 0.7)))
  if (BIG) body.push(
    g(
      on([[R + 0.3, T - 0.4]], 0.2),
      row([{ t: 'Needs you: ', fill: C.pick, bold: true }, { t: 'Batch the migration, or take downtime?', fill: C.bright }], text, by + FS) +
        row([{ t: 'Ship the 0.4 release · just now', fill: C.dim }], text, by + LH + FS),
    ),
  )
  // the prompt box
  const py = wy + wh - 66
  body.push(`<line x1="${wx + 18}" x2="${wx + ww - 18}" y1="${py}" y2="${py}" stroke="${C.edge}"/><line x1="${wx + 18}" x2="${wx + ww - 18}" y1="${py + 40}" y2="${py + 40}" stroke="${C.edge}"/>`)
  body.push(row([{ t: '>', fill: C.dim }], tx, py + 26))
  body.push(g(on(Array.from({ length: 16 }, (_, i) => [i, i + 0.5] as [number, number]), 0, true), `<rect x="${tx + 2 * CW}" y="${py + 11}" width="${CW}" height="19" fill="${C.soft}"/>`))

  return svg(W, H, bg.body + pitch + strip + window(wx, wy, ww, wh, 'claude — ~/shop') + body.join(''), bg.defs + BLUR + SHADOW)
}

// ── forms gallery ────────────────────────────────────────────────────────

const FORMS: [string, string][] = [
  ['flow', `flow Onboarding emails go out today
+ templates
+ queue worker
* staging send
. prod rollout
> Watching the bounce rate on staging.`],
  ['delta', `delta New ranking model trades latency for recall
recall: 0.91 -> 0.95 +
p50 latency: 180ms -> 420ms -
cost / 1k: $0.40 -> $0.40
> Worth it for search, not for autocomplete.`],
  ['path', `path Token is dropped between the gateway and auth
+ browser
+ edge
x gateway | strips Authorization on retry
. auth
> Fix goes in gateway/retry.ts`],
  ['bars', `bars Bun starts 3× faster than Node
@ unit=ms
bun: 38 *
deno: 74
node: 112
> Ship the CLI on Bun.`],
  ['tree', `tree Checkout p95 doubled after Tuesday's deploy
+ Database
  + Index on orders.user_id | present
  - Pool exhaustion | 40% used
* Network
  x Tax API slow | 1.8s p95
  . DNS
. Frontend bundle
> Next: cache tax rates per region`],
  ['matrix', `matrix Postgres wins on all but setup
@ cols=cost, scale, setup, ops
postgres: + + ~ + *
dynamo: ~ + + +
mongo: ~ ~ + x
> Going with Postgres.`],
  ['claims', `claims ColBERT latency is contested
Cross-encoder beats bi-encoder: 0.75 ^
ColBERT fits 50ms p95: 0.5 v !
Cohere fits cost budget: 0.3 v
> Check the hardware behind 120ms vs 35ms`],
  ['tradeoff', `tradeoff Self-host the vector DB
@ x=effort saved; y=fidelity
managed: 0.9 0.55
self-host: 0.45 0.85 *
sqlite-vss: 0.75 0.35
> Fidelity matters more than setup time.`],
]

function forms(): string {
  T = 6
  STILL = 5
  const W = 1600
  const cols = 2
  const cw = 728
  const gap = 32
  const x0 = (W - cols * cw - gap) / 2
  const top = 220
  const heights = [0, 0]
  const cards: string[] = []
  FORMS.forEach(([name, src], i) => {
    const col = heights[0] <= heights[1] ? 0 : 1
    const lines = viz(src, 64)
    const source = src.split('\n')
    const h = 64 + lines.length * LH + 30 + source.length * 18 + 30
    const x = x0 + col * (cw + gap)
    const y = top + heights[col]
    const delay = 0.15 + i * 0.12
    cards.push(
      g(
        on([[delay, T + 1]], 0.4),
        `<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="16" fill="${C.win}" stroke="${C.edge}"/>` +
          `<rect x="${x + 24}" y="${y + 20}" width="${w(name) * 8.4 + 22}" height="24" rx="12" fill="#ffffff" fill-opacity="0.05" stroke="${C.edge}"/>` +
          row([{ t: name, fill: C.soft }], x + 35, y + 37, 13, 8.4) +
          block(lines, x + 26, y + 60) +
          `<line x1="${x + 24}" x2="${x + cw - 24}" y1="${y + 64 + lines.length * LH + 12}" y2="${y + 64 + lines.length * LH + 12}" stroke="${C.edge}" stroke-dasharray="2 5"/>` +
          block(source.map(s => [{ t: s, fill: '#454b6b' }]), x + 26, y + 64 + lines.length * LH + 28, 12.5, 7.6, 18),
      ),
    )
    heights[col] += h + gap
  })
  const H = top + Math.max(...heights) + 40
  const bg = backdrop(W, H, [[1300, 80, C.mixed, 620], [200, H - 200, C.data, 600]])
  const head =
    `<text class="sans" x="${W / 2}" y="104" font-size="15" letter-spacing="3" fill="${C.pick}" font-weight="600" text-anchor="middle">EIGHT FORMS</text>` +
    `<text class="sans" x="${W / 2}" y="160" font-size="46" font-weight="700" letter-spacing="-1.2" fill="${C.bright}" text-anchor="middle">A few lines in. A picture out.</text>`
  return svg(W, H, bg.body + head + cards.join(''), bg.defs)
}

// ── living visual ────────────────────────────────────────────────────────

function living(): string {
  T = 14
  STILL = 13
  const versions = [
    `tree Safari login failure
@ id=safari-login
* Cookie dropped
  . ITP blocks cross-site API domain
. CORS preflight fails
. Storage write fails
> Check the cookie first`,
    `tree Safari login failure
@ id=safari-login
* Cookie dropped
  * ITP blocks cross-site API domain
- CORS preflight fails | no preflight sent
. Storage write fails
> ITP looks likely: test with the toggle off`,
    `tree Safari login failure
@ id=safari-login
+ Cookie dropped
  + ITP blocks cross-site API domain | confirmed
- CORS preflight fails | no preflight sent
- Storage write fails | not needed once toggle fixed it
> Next: find out whether it blocks the auth domain`,
  ]
  const specs = versions.map(v => parse(v)!)
  const W = 1600
  const H = 900
  const bg = backdrop(W, H, [[1300, 140, C.ok, 560], [260, 820, C.mixed, 560]])
  const wx = 700
  const wy = 190
  const ww = 800
  const wh = 520
  const per = T / 3
  const parts = specs.map((s, i) => {
    const lines = draw(s, 80, { version: i + 1, base: i ? { version: i, spec: specs[i - 1] } : undefined }).map(toned)
    return g(on([[i * per + 0.1, (i + 1) * per - 0.1]], 0.35), reveal(lines, wx + 30, wy + 70, i * per + 0.1, (i + 1) * per - 0.1, 0.045))
  })
  const dots = specs.map((_, i) => g(on([[i * per, (i + 1) * per]], 0.2), `<rect x="${wx + ww - 120 + i * 30}" y="${wy + 16}" width="22" height="8" rx="4" fill="${C.ok}"/>`) + `<rect x="${wx + ww - 120 + i * 30}" y="${wy + 16}" width="22" height="8" rx="4" fill="#ffffff" opacity="0.08"/>`)
  const lx = 104
  const pitch =
    `<text class="sans" x="${lx}" y="300" font-size="15" letter-spacing="3" fill="${C.ok}" font-weight="600">LIVING VISUALS</text>` +
    [`One picture,`, `kept current.`].map((s, i) => `<text class="sans" x="${lx - 3}" y="${376 + i * 68}" font-size="62" font-weight="700" letter-spacing="-2" fill="${C.bright}">${s}</text>`).join('') +
    [`Give a visual an id and the agent`, `redraws it as the work moves. Each`, `version says what changed since the last.`]
      .map((s, i) => `<text class="sans" x="${lx}" y="${502 + i * 32}" font-size="21" fill="${C.soft}">${s}</text>`)
      .join('') +
    `<rect x="${lx}" y="${606}" width="250" height="44" rx="10" fill="#ffffff" fill-opacity="0.04" stroke="${C.edge}"/>` +
    row([{ t: '@ ', fill: C.dim }, { t: 'id=', fill: C.soft }, { t: 'safari-login', fill: C.ok }], lx + 18, 634, 16, 9.6)
  return svg(W, H, bg.body + pitch + window(wx, wy, ww, wh, 'claude — ~/web') + dots.join('') + parts.join(''), bg.defs + SHADOW)
}

// ── the band: Boo and the flock ──────────────────────────────────────────

function band(): string {
  T = 12
  STILL = 4
  const W = 1600
  if (!BIG) return bandSmall()
  const rows: { mood: BooMood; pups?: ('working' | 'success' | 'blocked')[]; l1: Seg[]; l2: Seg[]; label: string }[] = [
    {
      mood: 'working', label: 'working', pups: ['working', 'working', 'success'],
      l1: [{ t: 'Fix token refresh · ' }, { t: 'Reproducing the race 2/5', fill: C.warn }, { t: ' · 2 agents running', fill: C.dim }],
      l2: [{ t: '› pnpm vitest auth/refresh.spec.ts', fill: C.dim }],
    },
    {
      mood: 'success', label: 'landed',
      l1: [{ t: 'Refresh race fixed, tests green' }],
      l2: [{ t: 'Fix token refresh · 3m ago · 4 new · /catchup', fill: C.dim }],
    },
    {
      mood: 'mixed', label: 'going in circles',
      l1: [{ t: '⟳ “npm test” failed 4× in a row · 9m', fill: C.warn }, { t: ' · Fix token refresh', fill: C.dim }],
      l2: [{ t: '› most edited: hooks/auth/refresh.ts (6×)', fill: C.dim }],
    },
    {
      mood: 'blocked', label: 'needs you',
      l1: [{ t: 'Needs you: ', fill: C.pick, bold: true }, { t: 'Keep the old cookie a week, or cut over now?', fill: C.bright }],
      l2: [{ t: 'Fix token refresh · just now · 1 other session needs you', fill: C.dim }],
    },
    {
      mood: 'neutral', label: 'collision',
      l1: [{ t: 'Session store moved to Redis' }],
      l2: [{ t: '⚠ register.tsx is also being edited in “Fix login redirect” · 3m ago', fill: C.warn }],
    },
  ]
  const top = 210
  const rh = 112
  const x = 300
  const parts = rows.map((r, i) => {
    const y = top + i * rh
    const pups = r.pups ? r.pups.map((p, k) => pup(p, x + 84 + k * 27, y + 24, k)).join('') : ''
    const tx = x + (r.pups ? 84 + r.pups.length * 27 + 12 : 84)
    return (
      `<rect x="${x - 40}" y="${y - 18}" width="${W - 2 * x + 80}" height="${rh - 20}" rx="14" fill="${C.win}" stroke="${C.edge}"/>` +
      `<text class="sans" x="${x - 64}" y="${y + 33}" font-size="14" fill="${hex(COLOR[r.mood])}" text-anchor="end" font-weight="600">${r.label}</text>` +
      boo(r.mood, x, y + 6, 0, T, 10, 12) +
      pups +
      row(r.l1, tx, y + 26, 17, 10.2) +
      row(r.l2, tx, y + 54, 17, 10.2)
    )
  })
  const H = top + rows.length * rh + 40
  const bg = backdrop(W, H, [[1350, 80, C.warn, 560], [250, H - 100, C.bad, 520]])
  const head =
    `<text class="sans" x="${W / 2}" y="96" font-size="15" letter-spacing="3" fill="${C.pick}" font-weight="600" text-anchor="middle">THE BAND</text>` +
    `<text class="sans" x="${W / 2}" y="150" font-size="46" font-weight="700" letter-spacing="-1.2" fill="${C.bright}" text-anchor="middle">One line above the prompt. Boo reads the room.</text>`
  return svg(W, H, bg.body + head + parts.join(''), bg.defs + BLUR)
}

/** The band as it is by default: small Boo, its flock, one line (and a warning under it when idle). */
function bandSmall(): string {
  T = 12
  STILL = 1.5
  const W = 1600
  const rows: { mood: BooMood; pups?: Pup[]; lines: Seg[][]; label: string }[] = [
    {
      mood: 'working', label: 'working',
      pups: [{ mood: 'working', fade: 0 }, { mood: 'working', fade: 0 }, { mood: 'success', fade: 0.2 }],
      lines: [[{ t: 'Fix token refresh · Reproducing the race 2/5' }, { t: ' · 2 agents running', fill: C.dim }]],
    },
    { mood: 'success', label: 'landed', lines: [[{ t: 'Fix token refresh → ', fill: C.dim }, { t: 'Refresh race fixed, tests green' }, { t: '  3m ago · 4 new · /catchup', fill: C.dim }]] },
    { mood: 'mixed', label: 'going in circles', lines: [[{ t: '⟳ “npm test” failed 4× in a row · 9m', fill: C.warn }, { t: ' · Fix token refresh', fill: C.dim }]] },
    { mood: 'blocked', label: 'needs you', lines: [[{ t: 'Needs you: Keep the old cookie a week, or cut over now?' }, { t: '  just now · 1 other session needs you', fill: C.dim }]] },
    {
      mood: 'neutral', label: 'collision',
      lines: [[{ t: 'Session store moved to Redis' }, { t: '  open 4m', fill: C.dim }], [{ t: '⚠ register.tsx is also being edited in “Fix login redirect” · 3m ago', fill: C.warn }]],
    },
  ]
  const cw = 10.2
  const lh = 26
  const x = 300
  let y = 206
  const parts = rows.map(r => {
    const h = 44 + r.lines.length * lh
    const top = y
    y += h + 20
    const fw = r.pups ? 1 + r.pups.length * 3 : 0
    const tx = x + (8 + 1 + fw) * cw
    const ly = top + 22
    return (
      `<rect x="${x - 40}" y="${top}" width="${W - 2 * x + 80}" height="${h}" rx="14" fill="${C.win}" stroke="${C.edge}"/>` +
      `<text class="sans" x="${x - 64}" y="${ly + 18}" font-size="14" fill="${hex(r.mood === 'neutral' ? 0xa9b1d6 : COLOR[r.mood])}" text-anchor="end" font-weight="600">${r.label}</text>` +
      smallBoo(r.mood, x, ly, 0, T, cw, lh) +
      (r.pups ? flock(r.pups, x + 8 * cw, ly, 0, T) : '') +
      r.lines.map((l, k) => row(l, k ? x + 9 * cw : tx, ly + k * lh + 18, 17, cw)).join('')
    )
  })
  const H = y + 30
  const bg = backdrop(W, H, [[1350, 80, C.warn, 560], [250, H - 100, C.bad, 520]])
  const head =
    `<text class="sans" x="${W / 2}" y="96" font-size="15" letter-spacing="3" fill="${C.pick}" font-weight="600" text-anchor="middle">THE BAND</text>` +
    `<text class="sans" x="${W / 2}" y="150" font-size="46" font-weight="700" letter-spacing="-1.2" fill="${C.bright}" text-anchor="middle">One line above the prompt. Boo reads the room.</text>`
  return svg(W, H, bg.body + head + parts.join(''), bg.defs)
}

// ── catchup: the return card and the agent lanes ─────────────────────────

function catchup(): string {
  T = 10
  STILL = 9
  const W = 1600
  const H = 900
  const bg = backdrop(W, H, [[1200, 120, C.data, 600], [300, 820, C.ok, 520]])
  const min = 60_000
  const now = 40 * min
  const laneRows = lanes(
    [
      { name: 'explore-auth', glyph: '✓', start: now - 20 * min, end: now - 12 * min, live: false, detail: 'Found 3 entry points' },
      { name: 'planner', glyph: '◉', start: now - 16 * min, live: true, detail: 'Editing plan.md' },
      { name: 'codex-review', glyph: '✗', start: now - 11 * min, end: now - 5 * min, live: false, detail: 'auth.spec fails on CI' },
      { name: 'docs-writer', glyph: '✓', start: now - 8 * min, end: now - 1 * min, live: false, detail: 'README section drafted' },
    ],
    76,
    now,
  ).map(toned)
  const back = card(
    {
      now,
      seen: 0,
      turns: [{ at: 1, tools: 45, ms: 18 * min, files: ['hooks/auth/refresh.ts', 'hooks/auth/session.ts', 'hooks/auth/token.ts'] }],
      saved: ['✓', '✗', '✓', '✓'].map((mood, k) => ({ at: k + 1, mood })),
      next: 'Need a batching decision first.',
      agentsDone: 2,
      root: '',
    } as never,
    76,
    6,
  ).map(toned)
  const wx = 330
  const wy = 210
  const ww = 940
  const wh = 500
  const tx = wx + 34
  const head: Seg[] = [{ t: 'Fix token refresh → ', fill: C.dim }, { t: 'Refresh race fixed, tests green', fill: C.bright }, { t: '  12m ago', fill: C.dim }]
  const sec = (t: string, y: number) => `<text class="sans" x="${tx}" y="${y}" font-size="13" letter-spacing="2.4" fill="${C.dim}" font-weight="600">${t}</text>`
  let y = wy + 74
  const body: string[] = [sec('BACK AFTER 40 MINUTES', y)]
  y += 18
  body.push(BIG ? boo('success', tx, y + 3, 0, T, 9, 11.5) : smallBoo('success', tx, y, 0, T))
  body.push(g(on([[0.2, T]], 0.3), row(head, tx + 9 * CW, y + FS) + block(back, tx + 9 * CW, y + LH)))
  y += (back.length + 1) * LH + 46
  body.push(sec('AGENTS', y))
  y += 18
  // lanes grow left to right
  const clip = `<clipPath id="grow"><rect x="${tx}" y="${y}" width="${76 * CW}" height="${laneRows.length * LH + 8}" class="grow"/></clipPath>`
  css += `.grow{transform-box:fill-box;transform-origin:left;animation:grow ${T}s cubic-bezier(.2,.7,.2,1) infinite}@keyframes grow{0%{transform:scaleX(0)}22%{transform:scaleX(1)}100%{transform:scaleX(1)}}`
  body.push(`<g clip-path="url(#grow)">${block(laneRows, tx, y)}</g>`)
  y += laneRows.length * LH + 40
  body.push(sec('NEEDS YOU', y))
  body.push(row([{ t: '? ', fill: C.pick, bold: true }, { t: 'Keep the old cookie a week, or cut over now?', fill: C.bright }], tx, y + 20 + FS))
  const title =
    `<text class="sans" x="${W / 2}" y="104" font-size="15" letter-spacing="3" fill="${C.pick}" font-weight="600" text-anchor="middle">/CATCHUP</text>` +
    `<text class="sans" x="${W / 2}" y="160" font-size="46" font-weight="700" letter-spacing="-1.2" fill="${C.bright}" text-anchor="middle">Step away. Come back to the story.</text>`
  return svg(W, H, bg.body + title + window(wx, wy, ww, wh, 'claude — ~/api') + body.join(''), bg.defs + BLUR + SHADOW + clip)
}

// ── write ────────────────────────────────────────────────────────────────

const art: Record<string, () => string> = { hero, forms, living, band, catchup }
mkdirSync(join(OUT, 'png'), { recursive: true })
for (const [name, make] of Object.entries(art)) {
  const file = join(OUT, `${name}.svg`)
  writeFileSync(file, make())
  console.log('wrote', file)
}

if (PNG) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  for (const name of Object.keys(art)) {
    // Stills: the reduced-motion style shows every part as it stands at STILL.
    const src = join(OUT, `${name}.svg`)
    const text = readFileSync(src, 'utf8')
    const size = /width="(\d+)" height="(\d+)"/.exec(text)!
    const page = join(OUT, 'png', `.${name}.html`)
    writeFileSync(page, `<style>html,body{margin:0;background:${C.page}}*{animation:none!important}svg{display:block}</style>${text}`)
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${size[1]},${size[2]}`, `--screenshot=${join(OUT, 'png', `${name}.png`)}`, `file://${page}`], { stdio: 'ignore' })
    rmSync(page)
    console.log('wrote', join(OUT, 'png', `${name}.png`))
  }
}
