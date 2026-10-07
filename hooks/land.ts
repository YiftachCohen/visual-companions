// The session at a glance, for someone coming back: the ribbon (one bar per turn), the
// return card (what happened since you last typed) and the compaction checkpoint.
// Pure, like render.ts: the band, /catchup and the tests share it. No model tokens.

import { cut, cutWords, w } from './render'
import type { Line, Seg, Spec, Tone } from './render'

/** One main-loop turn: when it ended, how many tool calls it took (its agents' included), how long, and the visual it drew. */
export type Turn = { at: number; tools: number; ms?: number; mood?: string; goal?: string; files?: string[] }
/** What the plugin asked a compaction's summary to keep, from the visuals it had seen. */
export type Kept = { decisions: string[]; blockers: string[]; asks: string[] }
export type Checkpoint = { at: number; trigger: string; before?: number; after?: number; kept: Kept; notice: string }
type Visual = { at: number; mood: string; title: string; goal?: string; spec: Spec }

export const MOOD_TONE: Record<string, Tone | undefined> = { '✓': 'ok', '✗': 'bad', '◉': 'warn', '▼': 'warn', '★': 'pick', '?': 'pick' }

/** Stored values as read back: anything that isn't a turn or a checkpoint is dropped. */
export const turnsOf = (v: unknown): Turn[] =>
  Array.isArray(v) ? v.filter(t => t && typeof t.at === 'number' && typeof t.tools === 'number') : []
export const cutsOf = (v: unknown): Checkpoint[] =>
  Array.isArray(v) ? v.filter(c => c && typeof c.at === 'number' && Array.isArray(c.kept?.decisions) && typeof c.notice === 'string') : []

/** `12m`, `3h`, `2d`. */
export function span(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/** `112k`, `950`. */
export const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// ── ribbon ───────────────────────────────────────────────────────────────

const LEVELS = '▁▂▃▄▅▆▇█'
const CUT = '╎' // a compaction, between the turns it fell between

/** Joins neighbouring segments of one tone, so a ribbon is a few segments, not one per cell. */
function joined(segs: Seg[]): Line {
  const out: Line = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.tone === s.tone) last.t += s.t
    else out.push({ ...s })
  }
  return out
}

/**
 * The session in `room` cells: one bar per turn, as tall as its tool calls (square-root
 * scaled, so one long turn doesn't flatten the rest), coloured by its visual's outcome;
 * turns from before you last typed are dim. A `╎` marks each compaction. Under it, each
 * stretch of one goal is named where the name fits. The oldest turns give way first.
 */
export function ribbon(turns: Turn[], room: number, now: number, seen = -Infinity, cuts: number[] = []): Line[] {
  if (turns.length === 0) return []
  const avail = room - 4 - 4 // `59m ` on the left, ` now` on the right
  if (avail < 4) return []
  const before = (i: number) => cuts.filter(c => (i === 0 ? -Infinity : turns[i - 1].at) < c && c <= turns[i].at).length
  const after = cuts.filter(c => c > turns[turns.length - 1].at).length
  const k = turns.length * 2 + cuts.length <= avail ? 2 : 1
  let first = Math.max(0, turns.length - Math.floor(avail / k))
  const width = (from: number) => (turns.length - from) * k + after + turns.slice(from).reduce((n, _, j) => n + (j === 0 ? 0 : before(from + j)), 0)
  while (first < turns.length - 1 && width(first) > avail) first++
  const shown = turns.slice(first)
  const top = Math.max(1, ...shown.map(t => t.tools))

  const bars: Seg[] = []
  const starts: number[] = [] // the cell each shown turn starts at, for the chapter names
  let col = 0
  shown.forEach((t, j) => {
    const marks = j === 0 ? 0 : before(first + j)
    if (marks) { bars.push({ t: CUT.repeat(marks), tone: 'data' }); col += marks }
    starts.push(col)
    const glyph = LEVELS[Math.round(Math.sqrt(Math.max(0, t.tools) / top) * (LEVELS.length - 1))]
    bars.push({ t: glyph.repeat(k), tone: MOOD_TONE[t.mood ?? ''] ?? (t.at <= seen ? 'dim' : undefined) })
    col += k
  })
  if (after) bars.push({ t: CUT.repeat(after), tone: 'data' })
  const label = span(now - shown[0].at).padStart(3) + ' '
  const out: Line[] = [joined([{ t: label, tone: 'dim' }, ...bars, { t: ' now', tone: 'dim' }])]

  // Chapters: runs of one goal, named where the name fits whole, or cut where at least five cells of it fit.
  const names: Seg[] = []
  let at = 0
  let odd = false
  for (let j = 0; j < shown.length; ) {
    let e = j
    while (e + 1 < shown.length && shown[e + 1].goal === shown[j].goal) e++
    const goal = shown[j].goal
    const end = e + 1 < shown.length ? starts[e + 1] : col
    const fit = end - starts[j] - 1
    if (goal && (w(goal) <= fit || fit >= 6)) {
      names.push({ t: ' '.repeat(starts[j] - at) })
      const name = cutWords(goal, fit)
      names.push({ t: name, tone: odd ? 'dim' : undefined })
      at = starts[j] + w(name)
      odd = !odd
    }
    j = e + 1
  }
  if (names.some(s => s.t.trim())) out.push(joined([{ t: ' '.repeat(w(label)) }, ...names]))
  return out
}

// ── return card ──────────────────────────────────────────────────────────

const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p

/** Edited files as a few words: `render.ts, boo.ts`, or `4 files in hooks/auth/`. */
export function place(files: string[], root = ''): string {
  const rel = [...new Set(files)].map(f => (root && f.startsWith(root.replace(/\/$/, '') + '/') ? f.slice(root.replace(/\/$/, '').length + 1) : f))
  if (rel.length <= 2) return rel.map(base).join(', ')
  let common = rel[0].split('/').slice(0, -1)
  for (const f of rel) {
    const d = f.split('/').slice(0, -1)
    let n = 0
    while (n < common.length && n < d.length && common[n] === d[n]) n++
    common = common.slice(0, n)
  }
  const dir = common.join('/')
  return `${rel.length} files${dir.replace(/\//g, '') ? ` in ${dir}/` : ''}`
}

export type CardIn = {
  now: number
  seen: number // when you last typed
  saved: Visual[]
  turns: Turn[]
  cuts: number[] // compaction times, for the ribbon
  agentsDone: number // subagents that answered since you last typed
  next?: string // the lead visual's next step
  root?: string
}

/**
 * The lines the band grows by when you've been away: how long and how much work, each
 * visual since as its glyph, the next step, where the edits landed, and the ribbon.
 * At most `rows` lines; the ribbon gives way first, then the glyphs, then the files.
 */
export function card(i: CardIn, room: number, rows: number): Line[] {
  const turns = i.turns.filter(t => t.at > i.seen)
  const since = i.saved.filter(s => s.at > i.seen)
  const worked = turns.reduce((n, t) => n + (t.ms ?? 0), 0)
  const calls = turns.reduce((n, t) => n + t.tools, 0)
  const files = turns.flatMap(t => t.files ?? [])
  const facts = [
    `${span(i.now - i.seen)} since you typed`,
    worked >= 60_000 ? `worked ${span(worked)}` : '',
    calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : '',
    i.agentsDone ? `${i.agentsDone} agent${i.agentsDone === 1 ? '' : 's'} finished` : '',
  ].filter(Boolean)
  const out: Array<{ line: Line; rank: number }> = [{ line: [{ t: cutWords(facts.join(' · '), room), tone: 'dim' }], rank: 0 }]
  if (since.length > 1) {
    const max = Math.max(1, Math.floor((room - 13) / 2))
    const shown = since.slice(-max)
    const glyphs: Seg[] = shown.flatMap((s, k) => [...(k ? [{ t: ' ' }] : []), { t: s.mood, tone: MOOD_TONE[s.mood] ?? 'dim' }])
    const more = since.length - shown.length
    out.push({ line: [...(more ? [{ t: `+${more} `, tone: 'dim' as Tone }] : []), ...glyphs, { t: '  since then', tone: 'dim' }], rank: 3 })
  }
  if (i.next) out.push({ line: [{ t: '→ ', tone: 'dim' }, { t: cutWords(i.next, room - 2) }], rank: 1 })
  if (files.length) out.push({ line: [{ t: '✎ ', tone: 'data' }, { t: cut(place(files, i.root), room - 2) }], rank: 2 })
  if (i.turns.length >= 3) ribbon(i.turns, room, i.now, i.seen, i.cuts).forEach((line, k) => out.push({ line, rank: 4 + k }))
  const keep = out.map(o => o.rank).sort((a, b) => a - b).slice(0, Math.max(0, rows))
  const cutoff = keep.length ? keep[keep.length - 1] : -1
  return out.filter(o => o.rank <= cutoff).map(o => o.line)
}

// ── compaction checkpoint ────────────────────────────────────────────────

const total = (k: Kept) => k.decisions.length + k.blockers.length + k.asks.length

/** What the summarizer is asked to keep, or undefined when the visuals hold nothing to keep. */
export function keepInstructions(k: Kept): string | undefined {
  if (!total(k)) return undefined
  const part = (name: string, items: string[]) => (items.length ? `${name}: ${items.join('; ')}` : '')
  return [
    'The user follows this session through its visuals. Keep each of these in the summary, in these words:',
    part('Decisions made', k.decisions),
    part('Open blockers', k.blockers),
    part('Waiting on the user', k.asks),
  ].filter(Boolean).join('\n')
}

export const NOTICE = '⟲ Compacted'

/** The transcript's one-line marker: `⟲ Compacted · 112k → 18k tokens · asked to keep 2 decisions, 1 blocker · /catchup`. */
export function noticeText(c: Omit<Checkpoint, 'notice'>): string {
  const n = (x: number, one: string, many: string) => (x ? `${x} ${x === 1 ? one : many}` : '')
  const kept = [n(c.kept.decisions.length, 'decision', 'decisions'), n(c.kept.blockers.length, 'blocker', 'blockers'), n(c.kept.asks.length, 'question', 'questions')].filter(Boolean)
  return [
    NOTICE,
    c.before !== undefined && c.after !== undefined ? `${tokens(c.before)} → ${tokens(c.after)} tokens` : '',
    kept.length ? `asked to keep ${kept.join(', ')}` : '',
    '/catchup',
  ].filter(Boolean).join(' · ')
}

/** The checkpoint as a framed card, like a visual: what the summary was asked to keep, and the size before and after. */
export function checkpointCard(c: Checkpoint, columns = 80): Line[] {
  const width = Math.max(40, Math.min(72, columns))
  const room = width - 3
  const rail: Tone = 'data'
  const n = total(c.kept)
  const title = n ? `Compacted · asked the summary to keep ${n}` : 'Compacted · nothing flagged to keep'
  const row = (glyph: string, tone: Tone, text: string): Line => [{ t: '│', tone: rail }, { t: '  ' }, { t: glyph, tone }, { t: ' ' + cutWords(text, room - 4) }]
  const size = c.before !== undefined && c.after !== undefined ? `${tokens(c.before)} → ${tokens(c.after)} tokens · ${c.trigger}` : c.trigger
  return [
    [{ t: '╭─ ', tone: rail }, { t: cutWords(title, width - 3), tone: 'title' }],
    [{ t: '│', tone: rail }],
    ...c.kept.decisions.map(d => row('★', 'pick', d)),
    ...c.kept.blockers.map(b => row('✗', 'bad', b)),
    ...c.kept.asks.map(a => row('?', 'pick', a)),
    ...(n ? [[{ t: '│', tone: rail }] as Line] : []),
    [{ t: '│', tone: rail }, { t: '  ' + size, tone: 'dim' }],
    [{ t: '╰─→ ', tone: rail }, { t: cutWords('Visuals from before stay in /catchup.', width - 4) }],
  ]
}
