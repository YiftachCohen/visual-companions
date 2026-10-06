import type { Register } from 'claude-code'

import { booMood, cells, COLOR as BOO, COLUMNS, frameAt, ROWS } from './boo'
import { cut, cutWords, draw, mood, split, w } from './render'
import type { Line, Spec, Tone } from './render'

// Everything the model pays for is this section (cached with the system
// prompt) plus the few dozen tokens of each ```viz block it writes.
// Rendering, the headline band and /catchup are drawn here: no model tokens.
const GUIDE = `Visual companions: when a message reports a finding, result, decision, blocker or change of direction the user needs to re-orient, open it with one \`\`\`viz block; it is drawn as a visual. Skip it for routine or short replies. At most one per message, ≤8 lines.
First line: <form> <headline as a claim>. Forms: flow (progress through steps), tree (causes or plan; indent 2 spaces per level), delta (what changed), bars (comparison), tradeoff (a choice on two axes).
flow/tree item marks: + done, * active, x blocked, . todo, - dropped. Keep flow step labels ≤14 chars. "label | note" adds a note.
delta rows: "label: before -> after +" (+ better, - worse). bars rows: "label: 89 *" (* highlights), options "@ unit=%; max=100; bar=85". tradeoff: "@ x=<axis>; y=<axis>", rows "label: 0.5 0.7 *" (0..1, * chosen).
"> one line" ends it: why it matters or what's next.`

const PANE = 'catchup'
const KEEP = 20
const STALE = 30 * 86_400_000 // other sessions' history is dropped after 30 days

type Saved = { at: number; title: string; mood: string; spec: Spec; stuck?: number } // stuck: ms blocked before this went green

// ◆ (neutral) has no colour: it draws dim.
const MOOD: Record<string, string | undefined> = { '✗': 'error', '◉': 'warning', '▼': 'warning', '✓': 'success' }
const COLOR: Partial<Record<Tone, string>> = { ok: 'success', bad: 'error', warn: 'warning', data: 'suggestion', pick: 'claude' }

export const register: Register = on => {
  let open: number | null = null // the `at` of the entry /catchup has expanded; null: the newest

  // When you last typed: visuals after it are what you missed. Notifications,
  // schedules and peers submit too, but don't mean you saw anything.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
      await $.store.set(`p:${await $.session.id()}`, await $.clock.now())
    return next(e)
  }).catch(($, e, next) => next(e)) // never let bookkeeping block a prompt

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'catchup', description: "Show this session's recent visual companions" })
    $.ui.status(undefined) // the headline is drawn above the prompt instead
    try {
      const id = await $.session.id()
      const cutoff = (await $.clock.now()) - STALE
      for (const key of await $.store.keys()) {
        if (!key.startsWith('h:') || key === `h:${id}`) continue
        const saved = (await $.store.get(key)) as Saved[] | undefined
        if ((saved?.at(-1)?.at ?? 0) < cutoff) {
          await $.store.delete(key)
          await $.store.delete(`p:${key.slice(2)}`)
        }
      }
    } catch {} // housekeeping only
    return next(e)
  })

  // The latest visual's headline above the prompt, with Boo beside it in the
  // terminal: floating while the model works, reacting to how the visual went.
  let workingSince: number | null = null
  let timer: { cancel: () => void } | null = null

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    timer?.cancel()
    timer = null
    if (e.props.hasSurvey) return next(e)
    const saved = ((await $.store.get(`h:${await $.session.id()}`)) as Saved[] | undefined) ?? []
    const last = saved.at(-1)
    if (!last) return next(e)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const now = await $.clock.now()
    workingSince = e.props.isWorking ? (workingSince ?? now) : null

    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return (
        <Text wrap="truncate-end">
          <Text color={MOOD[last.mood]} dimColor={!MOOD[last.mood]}>{last.mood} </Text>
          <Text dimColor>{cutWords(last.title, cols - 14)}  /catchup</Text>
        </Text>
      )
    }

    const { Box, Text, Raster } = $.ui.resolve(e)
    const m = workingSince !== null ? 'working' : last.stuck !== undefined ? 'relieved' : booMood(last.spec)
    const since = workingSince ?? last.at
    const { requestId } = e
    let shown = frameAt(m, now - since)

    // Repaint only when the frame changes, sleeping until then; stop once the band is gone.
    const step = async () => {
      const at = frameAt(m, (await $.clock.now()) - since)
      if (at.frame !== shown.frame) {
        const r = await $.ui.blit({ requestId, key: 'boo', cells: cells(at.frame, BOO[m]) })
        if (r.deny) return void (timer = null)
      }
      shown = at
      timer = $.clock.after(at.wait, step)
    }
    timer = $.clock.after(shown.wait, step)

    return (
      <Box flexDirection="row" gap={2}>
        <Raster key="boo" columns={COLUMNS} rows={ROWS} cells={cells(shown.frame, BOO[m])} />
        <Box flexDirection="column">
          {lines(`${last.title}  /catchup`, cols - COLUMNS - 4).map((l, k) => (
            <Text key={String(k)} wrap="truncate-end" dimColor>{l}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return { sections: [...out.sections, { id: 'visual-companions:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // Draw ```viz fences as the visual, on top of the message; the stored text is untouched.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.text.includes('```viz')) return next(e)
    const parts = split(e.props.text)
    const specs = parts.flatMap(p => ('viz' in p ? [p.viz] : []))
    if (specs.length === 0) return next(e)
    const prose = parts.flatMap(p => ('md' in p ? [p.md] : [])).join('').trim()
    const cols = (e.viewport?.columns ?? 80) - 2
    const { Box } = $.ui.resolve(e)
    const rest = prose ? await next({ ...e, props: { ...e.props, text: prose } }) : null
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          {specs.map((s, k) => visual($.ui.resolve(e), draw(s, cols), k))}
        </Box>
        {rest}
      </Box>
    )
  })

  // Remember the turn's visual: the headline above the prompt + history for /catchup.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer.includes('```viz')) {
      const spec = split(e.answer).flatMap(p => ('viz' in p ? [p.viz] : [])).at(-1)
      if (spec) {
        const key = `h:${await $.session.id()}`
        const saved = ((await $.store.get(key)) as Saved[] | undefined) ?? []
        const entry: Saved = { at: await $.clock.now(), title: spec.title, mood: mood(spec).glyph, spec }
        const stuck = entry.mood === '✓' ? stuckSince(saved) : undefined
        if (stuck !== undefined) entry.stuck = entry.at - stuck
        await $.store.set(key, [...saved, entry].slice(-KEEP))
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('command.run', { command: 'catchup' }, async $ => {
    open = null
    await $.ui.open({ id: PANE, title: 'Catch-up' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const id = await $.session.id()
    const saved = ((await $.store.get(`h:${id}`)) as Saved[] | undefined) ?? []
    const seen = Number((await $.store.get(`p:${id}`)) ?? 0)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    if (saved.length === 0) return <Text dimColor>Nothing yet. Visuals the agent draws in this session collect here.</Text>
    const recent = saved.slice(-6).reverse()
    const fresh = recent.filter(s => s.at > seen).length
    const shown = recent.some(s => s.at === open) ? open : recent[0].at
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{fresh ? `${fresh} new` : 'Up to date'}</Text>
          <Text dimColor>{` · ${saved.length} visual${saved.length === 1 ? '' : 's'} this session`}</Text>
        </Text>
        <Text> </Text>
        {recent.map(s =>
          s.at === shown ? (
            <Box key={String(s.at)} flexDirection="column" marginBottom={1}>
              <Text dimColor>
                {ago(now - s.at)}
                {s.stuck !== undefined ? <Text color="success">{` · ${unblocked(s.stuck)}`}</Text> : ''}
                {s.at > seen ? <Text color="claude"> · new</Text> : ''}
              </Text>
              {visual({ Box, Text }, draw(s.spec, cols))}
            </Box>
          ) : (
            <Box key={String(s.at)}>
              <Text color={MOOD[s.mood]} dimColor={!MOOD[s.mood]}>{s.mood} </Text>
              <Button label={s.title} onPress={() => { open = s.at; $.ui.invalidate('ui.render') }} />
              <Text dimColor>{`  ${ago(now - s.at)}`}</Text>
              {s.stuck !== undefined ? <Text color="success" dimColor> · unblocked</Text> : ''}
              {s.at > seen ? <Text color="claude"> ●</Text> : ''}
            </Box>
          ),
        )}
      </Box>
    )
  })
}

function visual({ Box, Text }: { Box: any; Text: any }, lines: Line[], key?: number) {
  return (
    <Box key={key === undefined ? undefined : String(key)} flexDirection="column">
      {lines.map((l, n) => (
        <Text key={String(n)} wrap="truncate-end">
          {l.length === 0 ? ' ' : l.map((s, k) => (
            <Text key={String(k)} color={s.tone ? COLOR[s.tone] : undefined} dimColor={s.tone === 'dim'} bold={s.tone === 'title'}>
              {s.t}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

/** `s` word-wrapped into at most two lines of `n` cells, the second cut if it overflows. */
function lines(s: string, n: number): string[] {
  if (w(s) <= n) return [s]
  const words = s.split(' ')
  let first = ''
  while (words.length && w(first ? `${first} ${words[0]}` : words[0]) <= n) first = first ? `${first} ${words.shift()}` : words.shift()!
  if (!first) return [cut(s, n)]
  const rest = words.join(' ').replace(/^ +/, '')
  return [first, w(rest) <= n ? rest : `${cutWords(rest.replace(/ +\/catchup$/, ''), n - 10)}  /catchup`]
}

/** When the work first went red since the last green visual; undefined if it never did. */
function stuckSince(saved: Saved[]): number | undefined {
  const k = saved.findLastIndex(s => s.mood === '✓')
  return saved.slice(k + 1).find(s => s.mood === '✗')?.at
}

const unblocked = (ms: number) => (ms < 30_000 ? 'unblocked' : `unblocked after ${span(ms)}`)
const ago = (ms: number) => (ms < 30_000 ? 'just now' : `${span(ms)} ago`)

/** `12m`, `3h`, `2d`. */
function span(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}
