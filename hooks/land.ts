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

// No bar lower than ▂: the one-eighth block reads as an underline in many fonts.
const LEVELS = '▂▃▄▅▆▇█'
const CUT = '╎' // a compaction, between the turns it fell between
const BAR_TONE: Record<string, Tone> = { '✓': 'ok', '✗': 'bad' } // only a turn that landed green or red is coloured
/** Below this many turns a ribbon says nothing a glance at the transcript doesn't. */
export const RIBBON_MIN = 8

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
 * The session in `room` cells: one cell per turn, as tall as its tool calls (square-root
 * scaled, so one long turn doesn't flatten the rest), green or red when its visual landed
 * that way; turns from before you last typed are dim. A `╎` marks each compaction. Under
 * it, when the work spans two goals or more, each stretch is named where the name fits.
 * The oldest turns give way first.
 */
export function ribbon(turns: Turn[], room: number, now: number, seen = -Infinity, cuts: number[] = []): Line[] {
  if (turns.length === 0) return []
  const avail = room - 4 - 4 // `59m ` on the left, ` now` on the right
  if (avail < 4) return []
  const before = (i: number) => cuts.filter(c => (i === 0 ? -Infinity : turns[i - 1].at) < c && c <= turns[i].at).length
  const after = cuts.filter(c => c > turns[turns.length - 1].at).length
  let first = Math.max(0, turns.length - avail)
  const width = (from: number) => turns.length - from + after + turns.slice(from).reduce((n, _, j) => n + (j === 0 ? 0 : before(from + j)), 0)
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
    bars.push({ t: LEVELS[Math.round(Math.sqrt(Math.max(0, t.tools) / top) * (LEVELS.length - 1))], tone: BAR_TONE[t.mood ?? ''] ?? (t.at <= seen ? 'dim' : undefined) })
    col += 1
  })
  if (after) bars.push({ t: CUT.repeat(after), tone: 'data' })
  const label = span(now - shown[0].at).padStart(3) + ' '
  const out: Line[] = [joined([{ t: label, tone: 'dim' }, ...bars, { t: ' now', tone: 'dim' }])]

  // Chapters: runs of one goal, each named with as many whole words as fit.
  const names: Seg[] = []
  let at = 0
  let odd = false
  for (let j = 0; j < shown.length; ) {
    let e = j
    while (e + 1 < shown.length && shown[e + 1].goal === shown[j].goal) e++
    const goal = shown[j].goal
    const end = e + 1 < shown.length ? starts[e + 1] : col
    const fit = end - starts[j] - 1
    const name = goal ? wholeWords(goal, fit) : ''
    if (name) {
      names.push({ t: ' '.repeat(starts[j] - at) })
      names.push({ t: name, tone: odd ? 'dim' : undefined })
      at = starts[j] + w(name)
      odd = !odd
    }
    j = e + 1
  }
  if (new Set(shown.map(t => t.goal).filter(Boolean)).size >= 2 && names.some(s => s.t.trim())) out.push(joined([{ t: ' '.repeat(w(label)) }, ...names]))
  return out
}

/** `s` in `n` cells, cut only between words (`Map auth flow` → `Map auth…`); '' when not even its first word fits. */
function wholeWords(s: string, n: number): string {
  if (w(s) <= n) return s
  let out = ''
  for (const word of s.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word
    if (w(next) + 1 > n) break
    out = next
  }
  return out ? out + '…' : ''
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
  if (i.turns.length >= RIBBON_MIN) ribbon(i.turns, room, i.now, i.seen, i.cuts).forEach((line, k) => out.push({ line, rank: 4 + k }))
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

const NOTICE = '⟲ Compacted'

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

// ── agent lanes ──────────────────────────────────────────────────────────

/** One subagent or teammate: when it was first and last heard from, and how it stands. */
export type Lane = { name: string; glyph: string; start?: number; end?: number; live: boolean; detail?: string }

const LANE_TONE: Record<string, Tone> = { '✓': 'ok', '✗': 'bad', '◉': 'warn', '◆': 'dim' }

/**
 * Agents as a timeline: one track each from when it started to when it answered (a live
 * one runs to now), its mark where it stands, and what it is on or found beside it. An
 * agent the plugin never heard from has no track, only its mark at the right.
 */
export function lanes(rows: Lane[], room: number, now: number): Line[] {
  if (rows.length === 0) return []
  const nw = Math.min(16, Math.max(...rows.map(r => w(r.name))))
  const track = Math.max(10, Math.min(32, room - nw - 2 - 2 - 24))
  const starts = rows.flatMap(r => (r.start !== undefined ? [r.start] : []))
  const t0 = starts.length ? Math.min(...starts) : now
  const total = Math.max(60_000, now - t0)
  const col = (t: number) => Math.max(0, Math.min(track - 1, Math.round(((t - t0) / total) * (track - 1))))
  const pad = ' '.repeat(nw + 2)
  const left = `${span(now - t0)} ago`
  const axis: Line = [{ t: pad + left + ' '.repeat(Math.max(1, track - w(left) - 3)) + 'now', tone: 'dim' }]
  const out: Line[] = [axis]
  for (const r of rows) {
    const name = cut(r.name, nw)
    const tone = LANE_TONE[r.glyph] ?? 'dim'
    const segs: Seg[] = [{ t: name + ' '.repeat(nw - w(name) + 2) }]
    if (r.start === undefined) segs.push({ t: ' '.repeat(track - 1) }, { t: r.glyph, tone })
    else {
      const s = col(r.start)
      const e = Math.max(s, r.live ? track - 1 : col(r.end ?? r.start))
      segs.push({ t: ' '.repeat(s) }, { t: '━'.repeat(e - s), tone: r.live ? 'warn' : tone }, { t: r.glyph, tone }, { t: ' '.repeat(track - 1 - e) })
    }
    if (r.detail) segs.push({ t: '  ' }, { t: cutWords(r.detail, Math.max(8, room - nw - 2 - track - 2)), tone: r.glyph === '✗' ? 'bad' : 'dim' })
    out.push(joined(segs.filter(s => s.t)))
  }
  return out
}

// ── thrash alarm ─────────────────────────────────────────────────────────

const WINDOW = 15 * 60_000 // repeats count within this
const REPEATS = 3 // failures in a row of one command before it reads as going in circles

/** A shell command as one key: spaces collapsed. */
export const commandKey = (cmd: string) => cmd.trim().replace(/\s+/g, ' ')

/**
 * The agent going in circles, as a line for the band, or undefined: one command that has
 * failed REPEATS times in a row (no success between) within WINDOW, and the file edited
 * most in that window when it was edited five times or more. Edits alone never raise it:
 * heavy editing is ordinary work.
 */
export function spinning(fails: Map<string, number[]>, edits: Map<string, number[]>, now: number): string | undefined {
  let worst: { cmd: string; times: number[] } | undefined
  for (const [cmd, times] of fails) {
    const recent = times.filter(t => now - t <= WINDOW)
    if (recent.length >= REPEATS && (!worst || recent.length > worst.times.length)) worst = { cmd, times: recent }
  }
  if (!worst) return undefined
  let file: { name: string; n: number } | undefined
  for (const [path, times] of edits) {
    const n = times.filter(t => now - t <= WINDOW).length
    if (n >= 5 && (!file || n > file.n)) file = { name: base(path), n }
  }
  const took = span(now - worst.times[0])
  return [`⟳ “${cut(worst.cmd, 32)}” failed ${worst.times.length}× in a row · ${took}`, file ? `${file.name} edited ${file.n}×` : ''].filter(Boolean).join(' · ')
}
