// Compact `viz` DSL → toned lines. Pure: no engine, so tests and the pane share it.
//
//   flow Release is blocked at the migrate step     ← <form> <headline>
//   + build                                         ← + done  * active  x blocked  . todo  - dropped
//   x migrate | lock timeout above 10k rows         ← `| note`
//   > Need a batching decision first.               ← so-what line
//
// tree: items indented 2 spaces per level.  delta: `label: before -> after +|-`
// bars: `label: 89 *` with `@ unit=%; max=100; bar=85`.
// tradeoff: `label: 0.5 0.7 *` (x y in 0..1, * chosen) with `@ x=effort; y=fidelity`.

export type Tone = 'ok' | 'bad' | 'warn' | 'data' | 'dim' | 'title' | 'pick' // pick: the highlighted or chosen option
export type Seg = { t: string; tone?: Tone }
export type Line = Seg[]
export type Status = 'done' | 'active' | 'blocked' | 'todo' | 'dropped' | null

type Item = { status: Status; label: string; note?: string; depth: number }
export type Spec = { form: string; title: string; soWhat?: string; opts: Record<string, string>; items: Item[] }

export const FORMS = ['flow', 'tree', 'delta', 'bars', 'tradeoff']
const STATUS: Record<string, Status> = { '+': 'done', '*': 'active', x: 'blocked', '.': 'todo', '-': 'dropped' }
const MARK: Record<string, string> = { done: '✓', active: '◉', blocked: '✗', todo: '○', dropped: '⊘', null: '•' }
const TONE: Record<string, Tone | undefined> = { done: 'ok', active: 'warn', blocked: 'bad', todo: 'dim', dropped: 'dim' }

// ── parsing ──────────────────────────────────────────────────────────────

export function parse(src: string): Spec | null {
  const lines = src.split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return null
  const head = lines[0].trim()
  const form = head.split(/\s+/)[0]
  if (!FORMS.includes(form)) return null
  const spec: Spec = { form, title: head.slice(form.length).trim(), opts: {}, items: [] }
  for (const raw of lines.slice(1)) {
    const depth = Math.floor((raw.length - raw.trimStart().length) / 2)
    const l = raw.trim()
    if (l.startsWith('>')) { spec.soWhat = l.slice(1).trim(); continue }
    if (l.startsWith('@')) {
      for (const kv of l.slice(1).split(';')) {
        const [k, ...v] = kv.split('=')
        if (k.trim()) spec.opts[k.trim()] = v.join('=').trim()
      }
      continue
    }
    let status: Status = null
    let body = l
    // Marks are a flow/tree thing: elsewhere `x axis: 3` is a label, not a blocked item.
    const m = form === 'flow' || form === 'tree' ? /^([+*x.\-])\s+(.*)$/.exec(l) : null
    if (m) { status = STATUS[m[1]]; body = m[2] }
    const [label, ...note] = body.split(' | ')
    spec.items.push({ status, label: label.trim(), note: note.join(' | ').trim() || undefined, depth })
  }
  // A chart with no row it can plot is left as the code block it was written as.
  const row = ROW[form]
  if (row && !spec.items.some(i => row(i.label))) return null
  return spec.items.length ? spec : null
}

// Magnitudes, durations and sizes, so `1.2k` beats `900` and `2s` beats `420ms`. A bare `m` stays a unit: minutes, metres or millions.
const SCALE: Record<string, number> = {
  k: 1e3, K: 1e3, M: 1e6, B: 1e9, bn: 1e9,
  ns: 1e-9, µs: 1e-6, us: 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600,
  KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
}

/** `89`, `420ms`, `$1,200`, `1.2k`, `0.4 s` → its value and how it was written; null when it isn't one number. */
export function amount(s: string): { v: number; text: string } | null {
  const m = /^([^\d\s.-]*)(-?[\d,]*\.?\d+)\s*([a-zA-Zµ%/]*)$/.exec(s.trim())
  if (!m || m[1].length > 3) return null
  const v = Number(m[2].replace(/,/g, '')) * (SCALE[m[3]] ?? 1)
  return isFinite(v) ? { v, text: s.trim() } : null
}

// One row of each chart, or null when it can't be plotted. Labels may hold a colon: the last one splits off the value.
const deltaRow = (l: string) => {
  const m = /^(.*?):\s*(.*?)\s*(?:->|→)\s*(.*?)(?:\s+([+-]))?$/.exec(l)
  return m ? { label: m[1], b: m[2], a: m[3], v: m[4] } : null
}
const barRow = (l: string) => {
  const m = /^(.*):\s*(.+?)\s*(\*)?$/.exec(l)
  const a = m && amount(m[2])
  return a ? { label: m[1], v: a.v, text: a.text, hi: !!m[3] } : null
}
const pointRow = (l: string) => {
  const m = /^(.*):\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*(\*)?$/.exec(l)
  return m && isFinite(Number(m[2])) && isFinite(Number(m[3])) ? { label: m[1], x: Number(m[2]), y: Number(m[3]), chosen: !!m[4] } : null
}
const ROW: Record<string, ((l: string) => unknown) | undefined> = { delta: deltaRow, bars: barRow, tradeoff: pointRow }

/** Splits markdown into prose and parsed ```viz fences; unparseable fences stay prose.
 *  Fences are tracked line by line, so a ```viz example quoted inside a longer fence stays prose.
 *  As in CommonMark, an unclosed fence runs to the end: a visual still streaming draws as it grows. */
export function split(text: string): Array<{ md: string } | { viz: Spec }> {
  const out: Array<{ md: string } | { viz: Spec }> = []
  let at = 0
  let fence: { ch: string; n: number; viz: boolean; start: number; body: number } | null = null
  for (let pos = 0; pos < text.length; ) {
    const nl = text.indexOf('\n', pos)
    const end = nl === -1 ? text.length : nl + 1
    const line = text.slice(pos, end).replace(/\r?\n$/, '')
    if (!fence) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (m && !(m[1][0] === '`' && m[2].includes('`')))
        fence = { ch: m[1][0], n: m[1].length, viz: m[1][0] === '`' && m[2].trim().split(/\s+/)[0] === 'viz', start: pos, body: end }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) {
        const spec = fence.viz ? parse(text.slice(fence.body, pos)) : null
        if (spec) {
          if (fence.start > at) out.push({ md: text.slice(at, fence.start) })
          out.push({ viz: spec })
          at = end
        }
        fence = null
      }
    }
    pos = end
  }
  const tail = fence?.viz ? parse(text.slice(fence.body)) : null
  if (fence && tail) {
    if (fence.start > at) out.push({ md: text.slice(at, fence.start) })
    out.push({ viz: tail })
    at = text.length
  }
  if (at < text.length) out.push({ md: text.slice(at) })
  return out
}

/** Overall state of a visual: drives the rail colour and the status-line glyph. */
export function mood(spec: Spec): { glyph: string; tone: Tone } {
  const s = spec.items.map(i => i.status)
  const rest = spec.items.map(i => i.label)
  if (s.includes('blocked')) return { glyph: '✗', tone: 'bad' }
  if (s.includes('active')) return { glyph: '◉', tone: 'warn' }
  if (s.length && s.every(x => x === 'done' || x === 'dropped')) return { glyph: '✓', tone: 'ok' }
  if (spec.form === 'delta' && rest.some(r => /\s-$/.test(r))) return { glyph: '▼', tone: 'warn' }
  if (spec.form === 'delta' && rest.every(r => /\s\+$/.test(r))) return { glyph: '✓', tone: 'ok' }
  return { glyph: '◆', tone: 'dim' }
}

// ── drawing helpers ──────────────────────────────────────────────────────

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u
export const w = (s: string) => [...s].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0)
const sp = (n: number): Seg => ({ t: ' '.repeat(Math.max(0, n)) })
const lineW = (l: Line) => l.reduce((n, s) => n + w(s.t), 0)
const mark = (s: Status): Seg => ({ t: MARK[String(s)], tone: TONE[String(s)] })

/** Cuts `s` to `n` display cells, ending in … when cut. */
export function cut(s: string, n: number): string {
  if (w(s) <= n) return s
  let out = ''
  for (const c of s) { if (w(out + c) > n - 1) break; out += c }
  return out + '…'
}

/** Cuts `s` to `n` cells at a word boundary when one falls in the back half. */
export function cutWords(s: string, n: number): string {
  if (w(s) <= n) return s
  const c = cut(s, n).slice(0, -1)
  const k = c.lastIndexOf(' ')
  return (k > c.length / 2 ? c.slice(0, k).trimEnd() : c) + '…'
}

/** `left ···· note` aligned on `col`; a note that won't fit goes on its own line below, after `under`. */
function leader(left: Line, note: string, col: number, room: number, under: Line = [sp(Math.min(4, lineW(left)))]): Line[] {
  const lw = lineW(left)
  const dots = Math.max(2, col - lw - 1)
  if (lw + dots + 2 + w(note) <= room) return [[...left, { t: ' ' + '·'.repeat(dots) + ' ', tone: 'dim' }, { t: note }]]
  return [left, [...under, { t: cut(note, room - lineW(under)), tone: 'dim' }]]
}

/** `row  note` when it fits, else the note dim on its own line below. */
function noted(row: Line, note: string | undefined, room: number): Line[] {
  if (!note) return [row]
  if (lineW(row) + 2 + w(note) <= room) return [[...row, sp(2), { t: note, tone: 'dim' }]]
  return [row, [sp(4), { t: cut(note, room - 4), tone: 'dim' }]]
}

/** A row the chart couldn't plot, kept as written so nothing the agent said is lost. */
const loose = (label: string, note: string | undefined, room: number): Line[] =>
  noted([{ t: cut(label, room), tone: 'dim' }], note, room)

// ── forms ────────────────────────────────────────────────────────────────

const frontier = (s: Spec) => s.items.findIndex(i => i.status !== 'done' && i.status !== 'dropped')

function labelTone(s: Spec, n: number): Tone | undefined {
  const i = s.items[n]
  if (n === frontier(s)) return i.status === 'blocked' ? 'bad' : i.status === 'active' ? 'warn' : 'title'
  return i.status === 'todo' || i.status === 'dropped' ? 'dim' : undefined
}

function flow(s: Spec, room: number): Line[] {
  const it = s.items
  const cw = Math.max(...it.map(i => w(i.label))) + 3
  if (cw * (it.length - 1) + w(it[it.length - 1].label) <= room) {
    const track: Line = []
    const names: Line = []
    it.forEach((i, n) => {
      track.push(mark(i.status))
      names.push(sp(n * cw - lineW(names)), { t: i.label, tone: labelTone(s, n) })
      if (n < it.length - 1) {
        const done = i.status === 'done'
        track.push({ t: ' ' + (done ? '━' : '┄').repeat(cw - 3) + ' ', tone: done ? 'ok' : 'dim' })
      }
    })
    const out: Line[] = [track, names]
    const withNotes = it.filter(i => i.note)
    if (withNotes.length) {
      const col = Math.max(...withNotes.map(i => w(i.label))) + 4
      out.push([], ...withNotes.flatMap(i => leader([mark(i.status), { t: ' ' + i.label }], i.note!, col, room)))
    }
    return out
  }
  // Too wide for the track: one step per line, joined by a rail only while that stays short.
  const col = Math.max(...it.map(i => w(i.label))) + 6
  const rail = it.length <= 4
  const out: Line[] = []
  it.forEach((i, n) => {
    const left: Line = [mark(i.status), sp(2), { t: i.label, tone: labelTone(s, n) }]
    out.push(...(i.note ? leader(left, i.note, col, room, [sp(3)]) : [left]))
    if (rail && n < it.length - 1) out.push([i.status === 'done' ? { t: '┃', tone: 'ok' } : { t: '┊', tone: 'dim' }])
  })
  return out
}

function tree(s: Spec, room: number): Line[] {
  const it = s.items
  const rows: Array<{ left: Line; under: Line; note?: string }> = []
  const open: boolean[] = [] // per depth: does a later sibling follow?
  it.forEach((i, n) => {
    const later = it.slice(n + 1)
    const stop = later.findIndex(j => j.depth <= i.depth)
    const isLast = stop === -1 || later[stop].depth < i.depth
    let stem = ''
    for (let d = 1; d < i.depth; d++) stem += open[d] ? '│  ' : '   '
    open[i.depth] = !isLast
    // A note on its own line keeps the lines that pass it: siblings below, and this item's children.
    const under = (i.depth > 0 ? stem + (isLast ? '   ' : '│  ') : '') + ((it[n + 1]?.depth ?? 0) > i.depth ? '│ ' : '  ')
    if (i.depth > 0) stem += isLast ? '╰─ ' : '├─ '
    rows.push({ left: [{ t: stem, tone: 'dim' }, mark(i.status), sp(1), { t: i.label, tone: i.depth === 0 ? 'title' : i.status === 'blocked' ? 'bad' : undefined }], under: [{ t: under, tone: 'dim' }], note: i.note })
  })
  const col = Math.max(...rows.map(r => lineW(r.left))) + 2
  return rows.flatMap(r => (r.note ? leader(r.left, r.note, col, room, r.under) : [r.left]))
}

/** `+4.4%` or `×2.3` when both sides are numbers in the same unit; '' otherwise. */
export function change(b: string, a: string): string {
  const num = (x: string) => /^([^\d-]*)(-?[\d.,]+)(\D*)$/.exec(x.trim())
  const mb = num(b), ma = num(a)
  if (!mb || !ma || mb[1] !== ma[1] || mb[3] !== ma[3]) return ''
  const vb = Number(mb[2].replace(/,/g, '')), va = Number(ma[2].replace(/,/g, ''))
  if (!isFinite(vb) || !isFinite(va) || vb === 0 || vb === va) return ''
  if (va === 0) return '-100%'
  const r = va / vb
  if (r < 0) return ''
  if (r >= 2 || r <= 0.5) return r >= 2 ? `×${r.toFixed(1)}` : `÷${(1 / r).toFixed(1)}`
  const pct = (r - 1) * 100
  return `${pct > 0 ? '+' : ''}${Math.abs(pct) < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

function delta(s: Spec, room: number): Line[] {
  const all = s.items.map(i => ({ row: deltaRow(i.label), i }))
  const rows = all.flatMap(r => (r.row ? [{ ...r.row, note: r.i.note }] : []))
  let lw = Math.max(...rows.map(r => w(r.label)))
  let bw = Math.max(...rows.map(r => w(r.b)))
  let aw = Math.max(...rows.map(r => w(r.a)))
  const tw = Math.max(0, ...rows.map(r => (r.v ? 8 : r.b === r.a ? 6 : 0)))
  let cw = Math.max(0, ...rows.map(r => w(change(r.b, r.a))))
  let arrow = 9
  let words = true
  const total = () => lw + 3 + bw + arrow + aw + 2 + (cw ? cw + 2 : 1) + (words ? tw : 1)
  if (total() > room) cw = 0
  if (total() > room) arrow = 3
  if (total() > room) words = false
  // Still too wide: shorten labels first, then the values.
  if (total() > room) lw = Math.max(4, lw - (total() - room))
  while (total() > room && (bw > 4 || aw > 4)) bw >= aw ? bw-- : aw--
  return all.flatMap(({ row: parsed, i }) => {
    if (!parsed) return loose(i.label, i.note, room)
    const r = { ...parsed, note: i.note }
    const c = change(r.b, r.a)
    const same = r.b === r.a
    const label = cut(r.label, lw), b = cut(r.b, bw), a = cut(r.a, aw)
    const tag: Seg = r.v === '+' ? { t: words ? '▲ better' : '▲', tone: 'ok' } : r.v === '-' ? { t: words ? '▼ worse' : '▼', tone: 'bad' } : same ? { t: words ? '= same' : '=', tone: 'dim' } : { t: '' }
    const row: Line = [
      { t: label + ' '.repeat(lw - w(label) + 3) + ' '.repeat(bw - w(b)) },
      { t: b, tone: 'dim' as Tone },
      { t: arrow === 9 ? (same ? ' ─────── ' : ' ──────▶ ') : same ? ' = ' : ' → ', tone: 'dim' as Tone },
      { t: a + ' '.repeat(aw - w(a) + 2), tone: same ? undefined : ('title' as Tone) },
      ...(cw ? [{ t: c + ' '.repeat(cw - w(c) + 2), tone: 'dim' as Tone }] : [{ t: ' ' }]),
      tag,
    ]
    return noted(row, r.note, room)
  })
}

function bars(s: Spec, room: number): Line[] {
  const unit = s.opts.unit ?? ''
  // Values draw as written; a bare number takes the `unit` option.
  const all = s.items.map(i => {
    const r = barRow(i.label)
    return { i, r: r && { ...r, text: /\d$/.test(r.text) ? r.text + unit : r.text } }
  })
  const items = all.flatMap(({ r }) => (r ? [r] : []))
  // Bars grow from zero: a negative value draws an empty track beside its number.
  const top = [amount(s.opts.max ?? '')?.v, Math.max(...items.map(i => i.v))].find(x => x !== undefined && x > 0) ?? 1
  const th = s.opts.bar !== undefined ? amount(s.opts.bar)?.v : undefined
  const lw = Math.max(...items.map(i => w(i.label)))
  const vw = Math.max(...items.map(i => w(i.text)))
  const span = Math.max(10, room - lw - vw - 7)
  const at = th !== undefined && isFinite(th) ? Math.round((th / top) * span) : undefined
  const tcol = at !== undefined && at >= 0 && at < span ? at : undefined
  const out: Line[] = all.flatMap(({ i: src, r: i }) => {
    if (!i) return loose(src.label, src.note, room)
    // A positive value always shows at least a sliver, so it never reads as zero.
    const eighths = Math.max(i.v > 0 ? 1 : 0, Math.round((Math.max(0, Math.min(i.v, top)) / top) * span * 8))
    const full = Math.floor(eighths / 8)
    const part = eighths % 8
    const bar = '█'.repeat(full) + (part ? ' ▏▎▍▌▋▊▉'[part] : '')
    let track = '·'.repeat(Math.max(0, span - w(bar)))
    const segs: Line = [sp(lw - w(i.label)), { t: i.label, tone: i.hi ? 'title' : undefined }, sp(2), { t: bar, tone: i.hi ? 'pick' : 'data' }]
    if (tcol !== undefined && tcol >= w(bar) && tcol < span) {
      const k = tcol - w(bar)
      segs.push({ t: track.slice(0, k), tone: 'dim' }, { t: '┆', tone: 'warn' }, { t: track.slice(k + 1), tone: 'dim' })
    } else segs.push({ t: track, tone: 'dim' })
    const val = i.text
    segs.push({ t: '  ' + ' '.repeat(vw - w(val)) + val, tone: i.hi ? 'title' : undefined })
    if (i.hi) segs.push({ t: '  ◀', tone: 'pick' })
    return noted(segs, src.note, room)
  })
  if (tcol !== undefined) out.push([sp(lw + 2 + tcol), { t: `╰ ${/\d$/.test(s.opts.bar!) ? s.opts.bar + unit : s.opts.bar} bar`, tone: 'warn' }])
  return out
}

function tradeoff(s: Spec, room: number): Line[] {
  const W = Math.min(46, room - 4), H = 9
  const ch: string[][] = [], tn: (Tone | undefined)[][] = []
  for (let r = 0; r < H; r++) {
    ch.push([...Array(W)].map((_, c) => (c % 5 === 0 && r % 2 === 0 ? '·' : ' ')))
    tn.push(Array(W).fill('dim'))
  }
  const put = (r: number, c0: number, text: string, tone?: Tone) => {
    ;[...text].forEach((x, k) => { ch[r][c0 + k] = x; tn[r][c0 + k] = tone })
    for (const c of [c0 - 1, c0 + text.length]) if (c >= 0 && c < W && ch[r][c] === '·') ch[r][c] = ' '
  }
  const free = (r: number, c0: number, c1: number) => c0 >= 0 && c1 <= W && ch[r].slice(c0, c1).every(x => x === ' ' || x === '·')
  // Group options by plotted cell so a shared cell never hides one of them.
  type Pt = { x: number; y: number; names: string[]; chosen: boolean; notes: string[] }
  const pts: Pt[] = []
  const unplotted: Line[] = []
  for (const i of s.items) {
    const m = pointRow(i.label)
    if (!m) { unplotted.push(...loose(i.label, i.note, room)); continue }
    const x = Math.min(W - 1, Math.max(0, Math.round(m.x * (W - 1))))
    const y = Math.min(H - 1, Math.max(0, Math.round((1 - m.y) * (H - 1))))
    const p = pts.find(q => q.x === x && q.y === y) ?? (pts.push({ x, y, names: [], chosen: false, notes: [] }), pts[pts.length - 1])
    p.names.push(m.label)
    p.chosen ||= m.chosen
    if (i.note) p.notes.push(`${m.label}: ${i.note}`)
  }
  // Every point first, then labels into the space left, so no label covers a point.
  for (const p of pts) put(p.y, p.x, p.chosen ? '★' : '●', p.chosen ? 'pick' : 'data')
  if (free(0, W - 8, W)) put(0, W - 8, 'better ↗', 'dim')
  const legend: Line[] = []
  // The chosen option labels first, so a crowded plot never reduces it to a letter.
  for (const p of [...pts].sort((a, b) => Number(b.chosen) - Number(a.chosen))) {
    const tone: Tone = p.chosen ? 'pick' : 'data'
    const lt: Tone | undefined = p.chosen ? 'title' : undefined
    const name = p.names[0]
    if (p.names.length === 1 && free(p.y, p.x + 1, p.x + name.length + 2)) { put(p.y, p.x + 2, name, lt); ch[p.y][p.x + 1] = ' ' }
    else if (p.names.length === 1 && free(p.y, p.x - name.length - 1, p.x)) { put(p.y, p.x - name.length - 1, name, lt); ch[p.y][p.x - 1] = ' ' }
    else {
      const tag = String.fromCharCode(65 + legend.length)
      put(p.y, p.x, tag, tone)
      legend.push([{ t: `${tag}  ${p.names.join(', ')}` }, ...(p.chosen ? [{ t: ' ★', tone: 'pick' as Tone }] : [])])
    }
  }
  const notes = pts.flatMap(p => p.notes).map(n => [{ t: cut(n, room), tone: 'dim' as Tone }])
  const rows: Line[] = ch.map((row, r) => {
    const segs: Line = [{ t: '│ ', tone: 'dim' }]
    row.forEach((x, c) => {
      const last = segs[segs.length - 1]
      const tone = x === ' ' && tn[r][c] === 'dim' ? 'dim' : tn[r][c]
      if (last.tone === tone) last.t += x
      else segs.push({ t: x, tone })
    })
    return segs
  })
  return [
    [{ t: '↑ ' + (s.opts.y ?? ''), tone: 'dim' }],
    ...rows,
    ...(W + 4 + w(s.opts.x ?? '') <= room
      ? [[{ t: '╰' + '─'.repeat(W + 1) + '▶ ' + (s.opts.x ?? ''), tone: 'dim' as Tone }]]
      : [[{ t: '╰' + '─'.repeat(W + 1) + '▶', tone: 'dim' as Tone }], [sp(W + 3 - w(cut(s.opts.x ?? '', W + 3))), { t: cut(s.opts.x ?? '', W + 3), tone: 'dim' as Tone }]]),
    ...(legend.length ? [[], ...legend] : []),
    ...(notes.length ? [[], ...notes] : []),
    ...(unplotted.length ? [[], ...unplotted] : []),
  ]
}

// ── frame ────────────────────────────────────────────────────────────────

/** The framed visual, fitted to `columns` (capped at 72). */
export function draw(spec: Spec, columns = 80): Line[] {
  const width = Math.max(40, Math.min(72, columns))
  const room = width - 3
  const body =
    spec.form === 'flow' ? flow(spec, room)
    : spec.form === 'tree' ? tree(spec, room)
    : spec.form === 'delta' ? delta(spec, room)
    : spec.form === 'bars' ? bars(spec, room)
    : tradeoff(spec, room)
  const rail = mood(spec).tone
  const done = spec.items.filter(i => i.status === 'done').length
  const meta = spec.form === 'flow' ? `  ${done}/${spec.items.filter(i => i.status !== 'dropped').length}` : ''
  const out: Line[] = [[{ t: '╭─ ', tone: rail }, { t: cutWords(spec.title, width - 3 - w(meta)), tone: 'title' }, ...(meta ? [{ t: meta, tone: 'dim' as Tone }] : [])], [{ t: '│', tone: rail }]]
  for (const l of body) out.push([{ t: '│', tone: rail }, ...(l.length ? [sp(2), ...l] : [])])
  out.push([{ t: '│', tone: rail }])
  if (spec.soWhat) {
    const [first, ...more] = wrap(spec.soWhat, width - 4)
    out.push([{ t: '╰─→ ', tone: rail }, { t: first }], ...more.map(l => [sp(4), { t: l }]))
  }
  else out.push([{ t: '╰─', tone: rail }])
  return out
}

function wrap(text: string, n: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/)) {
    if (cur && w(cur + ' ' + word) > n) { lines.push(cur); cur = '' }
    cur = cur ? cur + ' ' + word : cut(word, n)
  }
  return cur ? [...lines, cur] : lines
}

export const plain = (lines: Line[]) => lines.map(l => l.map(s => s.t).join('').trimEnd()).join('\n')
