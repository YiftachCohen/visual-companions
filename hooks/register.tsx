import type { EngineInterface, Register } from 'claude-code'

import { big, booMood } from './boo'
import type { Companion, Look } from './boo'
import { small } from './boo-small'
import { cut, cutWords, draw, mood, split, w } from './render'
import type { Line, Spec, Tone } from './render'
import type { AgentNote, Now } from './contract'

// Everything the model pays for is this section (cached with the system
// prompt) plus the few dozen tokens of each ```viz block it writes.
// Rendering, the headline band and /catchup are drawn here: no model tokens.
const GUIDE = `Visual companions: when a message reports a finding, result, decision, blocker or change of direction the user needs to re-orient, open it with one \`\`\`viz block; it is drawn as a visual. Skip it for routine or short replies. At most one per message, ≤8 lines.
First line: <form> <headline as a claim>. Forms: flow (progress through steps), path (where in a system something happens: components in order), tree (causes or plan; indent 2 spaces per level), delta (what changed), bars (comparison), tradeoff (a choice on two axes), matrix (options against several criteria).
flow/path/tree item marks: + done, * active, x blocked, . todo, - dropped. Keep flow step labels ≤14 chars. "label | note" adds a note.
delta rows: "label: before -> after +" (+ better, - worse). bars rows: "label: 89 *" (* highlights), options "@ unit=%; max=100; bar=85". tradeoff: "@ x=<axis>; y=<axis>", rows "label: 0.5 0.7 *" (0..1, * chosen). matrix: "@ cols=<a>, <b>" (required), rows "label: + ~ x *" (+ good, ~ partial, x bad, * chosen).
"> one line" ends it: why it matters or what's next. "> ? question" instead when you need the user's decision or answer to go on.`

// Added to each subagent's task while `activity` is on: ~20 tokens per spawn.
const HEADLINE = 'Start your final answer with a one-line headline that states the outcome as a claim.'

const PANE = 'catchup'
const RECENT = 8 // history rows /catchup lists before "Show all"
const DAY = 86_400_000

const NOW = { plugin: 'visual-companions', key: 'now' } as const
const AGENTS = { plugin: 'visual-companions', key: 'agents' } as const

// stuck: ms blocked before this went green. goal: what the work was for when it was drawn.
type Saved = { at: number; title: string; mood: string; spec: Spec; stuck?: number; goal?: string }

// ◆ (neutral) has no colour: it draws dim. ★ a decision, ? a question for you.
const MOOD: Record<string, string | undefined> = { '✗': 'error', '◉': 'warning', '▼': 'warning', '✓': 'success', '★': 'claude', '?': 'claude' }
// Forms that report where work stands; the latest of them for a goal is that goal's state.
const STATUS_FORMS = new Set(['flow', 'path', 'tree'])
const COLOR: Partial<Record<Tone, string>> = { ok: 'success', bad: 'error', warn: 'warning', data: 'suggestion', pick: 'claude' }

const COMPANIONS: Record<string, Companion | undefined> = { small, big }

export const register: Register = (on, options) => {
  // Every option is a row in /config (plugin.json's userConfig); a change there reloads this module.
  const companion = COMPANIONS[String(options.companion ?? 'small')] // undefined: off, the glyph line
  const look: Look = { palette: pick(options.booColor, ['mood', 'mono', 'claude'], 'mood'), effects: options.booEffects !== false }
  const animate = options.booAnimation !== 'still'
  const reactions = options.booReactions !== false
  const guide = options.visuals !== false
  const showBand = options.band !== false
  const activity = options.activity !== false
  const keep = Number(pick(String(options.history), ['10', '20', '50'], '20')) // visuals kept for /catchup
  const stale = Number(pick(String(options.retention), ['7', '30', '90'], '30')) * DAY // other sessions' history is dropped after this
  let open: number | null = null // the `at` of the entry /catchup has expanded; null: the band's lead
  let all = false // /catchup lists all of the history, not just the latest few

  const held: Held = { cache: null }

  // Band notes are written in order but off the tool's path: a tool never waits on them.
  let notes: Promise<unknown> = Promise.resolve()
  let prompts = 0 // bumped per prompt: a goal Haiku names late for an older prompt is dropped
  const note = (f: () => Promise<unknown>) => void (notes = notes.then(f).catch(() => {}))

  // When you last typed: visuals after it are what you missed. Notifications,
  // schedules and peers submit too, but don't mean you saw anything.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const id = await $.session.id()
      const at = await $.clock.now()
      await $.store.set(`p:${id}`, at)
      if (held.cache?.id === id) held.cache.seen = at
      if (!activity) return next(e) // no goal: nothing names it, and no Haiku call
      const goal = goalOf(e.text)
      const turn = ++prompts
      if (goal) note(() => $.state.set(NOW, { goal }))
      // Haiku can answer after the turn has ended: the visuals saved since this prompt take its goal then.
      else void nameGoal($, e.text).then(g => { if (g && turn === prompts) note(async () => { await merge($, { goal: g }); await regoal($, held, at, g) }) })
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // never let bookkeeping block a prompt

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'catchup', description: "Show this session's recent visual companions" })
    $.ui.status(undefined) // the headline is drawn above the prompt instead
    // Where this session runs, so another session's /catchup can name it.
    try { await $.store.set(`d:${await $.session.id()}`, base(await $.session.root())) } catch {}
    try {
      const id = await $.session.id()
      const cutoff = (await $.clock.now()) - stale
      for (const key of await $.store.keys()) {
        if (!key.startsWith('h:') || key === `h:${id}`) continue
        const saved = (await $.store.get(key)) as Saved[] | undefined
        if ((saved?.at(-1)?.at ?? 0) < cutoff) {
          for (const k of ['h', 'p', 'd']) await $.store.delete(`${k}:${key.slice(2)}`)
        }
      }
    } catch {} // housekeeping only
    return next(e)
  })

  // Above the prompt, for someone switching back in: a question waiting on them first,
  // else what the work is for and where it landed (the goal's open blocker before any
  // newer chart), what came in since they last typed, and any agents still running. While the model works: the goal and task,
  // with the step it is on given way to first. Boo sits beside it in the terminal.
  // The `companion` option picks small (braille, one row), big (two rows) or off;
  // the boo* options how it's painted and whether it moves.
  let workingSince: number | null = null
  let away = { at: -Infinity, n: 0 } // other sessions waiting on you, and when that was counted
  let timer: { cancel: () => void } | null = null
  let aging: { cancel: () => void } | null = null

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    timer?.cancel()
    timer = null
    aging?.cancel()
    aging = null
    if (!showBand || e.props.hasSurvey) return next(e)
    const hist = await history($, held)
    const last = hist.saved.at(-1)
    if (!last) return next(e)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const now = await $.clock.now()
    const working = !!e.props.isWorking
    workingSince = working ? (workingSince ?? now) : null
    // Read while drawing, so each tool call redraws the band.
    const live = activity ? ((await $.state.get(NOW)).value ?? null) : null
    const head = working ? [live?.goal, progress(live)].filter(Boolean).join(' · ') : ''
    const step = working ? live?.step : undefined
    const busy = !!(head || step)
    const n = await running($)
    const agents = n ? `${n} agent${n === 1 ? '' : 's'} running` : ''

    const ask = waiting(hist.saved, hist.seen)
    const lead = ask ?? outcome(hist.saved)
    const shown = ask ? { ...ask, mood: '?', title: `Needs you: ${ask.spec.soWhat}` } : lead
    const fresh = hist.saved.filter(s => s.at > hist.seen).length
    // Another session's question, looked up at most once a minute: the band redraws on every tool call.
    if (now - away.at > 60_000) away = { at: now, n: (await otherSessions($, hist.id, now)).filter(o => o.ask).length }
    const elsewhere = away.n ? `${away.n} other session${away.n === 1 ? ' needs' : 's need'} you` : ''
    const meta = [ask || lead === last ? ago(now - lead.at) : `open ${span(now - lead.at)}`, elsewhere, fresh > 1 ? `${fresh} new · /catchup` : '', agents]
      .filter(Boolean)
      .join(' · ')
    // Idle, nothing else redraws the band: redraw it when the age it shows goes stale.
    if (!working) aging = $.clock.after(now - lead.at < 3_600_000 ? 60_000 : 3_600_000, () => $.ui.invalidate('ui.render'))

    if (e.surface !== 'terminal' || !companion) {
      const { Text } = $.ui.resolve(e)
      if (busy) return <Text wrap="truncate-end">{segs(Text, doing(head, step, agents, cols))}</Text>
      return (
        <Text wrap="truncate-end">
          <Text color={MOOD[shown.mood]} dimColor={!MOOD[shown.mood]}>{shown.mood} </Text>
          {segs(Text, landed(live?.goal, shown.title, meta, cols - 2))}
        </Text>
      )
    }

    const { Box, Text, Raster } = $.ui.resolve(e)
    const m = working ? 'working' : shown.stuck !== undefined ? 'relieved' : booMood(shown.spec)
    const since = workingSince ?? last.at
    const { requestId } = e
    const { columns, rows } = companion
    // Without reactions the intro is skipped; held still, Boo rests in the pose it settles into.
    const skip = reactions ? 0 : companion.settle(m)
    const at = (t: number) => companion.draw(m, animate ? t + skip : companion.settle(m), look)
    // Sleep until the drawing next changes (looked ahead in 20ms steps), so a still Boo costs nothing.
    const until = (t: number, cells: string) => {
      for (let d = 20; d < 4000; d += 20) if (at(t + d) !== cells) return d
      return 4000
    }
    let drawn = at(now - since)

    // Repaint only when the cells change; stop once the band is gone.
    const tick = async () => {
      const t = (await $.clock.now()) - since
      const cells = at(t)
      if (cells !== drawn) {
        const r = await $.ui.blit({ requestId, key: 'boo', cells })
        if (r.deny) return void (timer = null)
        drawn = cells
      }
      timer = $.clock.after(until(t, cells), tick)
    }
    if (animate) timer = $.clock.after(until(now - since, drawn), tick)

    const room = cols - columns - 3
    // Two rows: the goal above and the step dim below; idle, the outcome above and the goal dim below.
    const body: Seg2[][] =
      rows === 1
        ? [busy ? doing(head, step, agents, room) : landed(live?.goal, shown.title, meta, room)]
        : busy && head
          ? [doing(head, undefined, agents, room), ...(step ? [[{ t: `› ${cut(step, room - 2)}`, dim: true }]] : [])]
          : busy
            ? [doing('', step, agents, room), [{ t: cutWords(shown.title, room), dim: true }]]
            : [[{ t: cutWords(shown.title, room) }], [{ t: cutWords([live?.goal, meta].filter(Boolean).join(' · '), room), dim: true }]]
    return (
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Raster key="boo" columns={columns} rows={rows} cells={drawn} />
        <Box flexDirection="column">
          {body.map((l, k) => (
            <Text key={String(k)} wrap="truncate-end">{segs(Text, l)}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  // Agents that finish or start change the band's count: nothing else redraws it then.
  // A subagent's answer reaches the main agent, not you: ask it to open with a headline,
  // which /catchup shows as what it found (and the main agent can scan too).
  on('agent.spawn', async ($, e, next) => {
    const r = await next(activity ? { ...e, prompt: `${e.prompt}\n\n${HEADLINE}` } : e)
    $.ui.invalidate('ui.render')
    return r
  }).catch(($, e, next) => next(e))

  // What the agent is on, from its own tool calls: no model tokens (only a plain prompt's goal costs a Haiku call). A skill names
  // the goal, its task list the task in progress, any other tool the step.
  const tasks = new Map<string, { wording: string; done: boolean }>() // task id → its in-progress wording, from TaskCreate
  const counts = () => ({ done: [...tasks.values()].filter(t => t.done).length, total: tasks.size })
  on('tool.call', async ($, e, next) => {
    if (!activity) return next(e)
    const a = e as unknown as Record<string, any>
    // A subagent's or teammate's call: only its step, kept per agent for /catchup.
    if (e.agentId !== undefined) {
      const id = e.agentId
      const step = stepOf(a)
      if (step) note(async () => noteAgent($, id, { step, at: await $.clock.now() }))
      return next(e)
    }
    if (e.tool === 'Skill') {
      const goal = skillGoal(String(a.skill ?? ''), String(a.args ?? ''))
      if (goal) note(() => merge($, { goal, task: undefined }))
    } else if (e.tool === 'TodoWrite') {
      const todos = (a.todos as Array<{ status: string; activeForm?: string; content: string }> | undefined) ?? []
      const t = todos.find(t => t.status === 'in_progress')
      const done = todos.filter(t => t.status === 'completed').length
      note(() => merge($, { task: t ? t.activeForm || t.content : undefined, done, total: todos.length }))
    } else if (e.tool === 'TaskCreate') {
      const r = (await next(e)) as any
      const id = r?.result?.task?.id
      if (id) {
        tasks.set(String(id), { wording: a.activeForm || a.subject, done: false })
        note(() => merge($, counts()))
      }
      return r
    } else if (e.tool === 'TaskUpdate') {
      const id = String(a.taskId)
      const wording = a.activeForm || a.subject || tasks.get(id)?.wording
      if (a.status === 'in_progress' && wording) note(() => merge($, { task: wording }))
      else if (a.status === 'completed' || a.status === 'deleted') {
        const was = tasks.get(id)?.wording
        if (a.status === 'deleted') tasks.delete(id)
        else if (tasks.has(id)) tasks.get(id)!.done = true
        const c = counts()
        note(async () => {
          const cur = (await $.state.get(NOW)).value
          await merge($, cur?.task && cur.task === was ? { ...c, task: undefined } : c)
        })
      }
    } else {
      const step = stepOf(a)
      if (step) note(() => merge($, { step }))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // never let the note hold up a tool

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!guide || e.surfaces.length === 0) return out // visuals off, or headless (-p, SDK) where none would be drawn: don't ask for one
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
    // The goal outlasts the turn: idle, the band shows it, and Haiku reads it to tell a follow-up from new work.
    if (e.agentId === undefined) note(() => merge($, { task: undefined, done: undefined, total: undefined, step: undefined }))
    else {
      // A subagent answered: what it found, for /catchup. Its status settles just after.
      const id = e.agentId
      const result = headline(e.answer)
      if (activity && result) note(async () => noteAgent($, id, { result, step: undefined, at: await $.clock.now() }))
      $.ui.invalidate('ui.render')
      $.clock.after(1000, () => $.ui.invalidate('ui.render'))
    }
    if (e.agentId === undefined && e.answer.includes('```viz')) {
      const spec = split(e.answer).flatMap(p => ('viz' in p ? [p.viz] : [])).at(-1)
      if (spec) {
        const h = await history($, held)
        await notes // the goal a prompt or skill named this turn is written by now (or regoal fills it in later)
        const saved = h.saved
        const goal = activity ? ((await $.state.get(NOW)).value?.goal ?? undefined) : undefined
        const entry: Saved = { at: await $.clock.now(), title: spec.title, mood: mood(spec).glyph, spec, ...(goal ? { goal } : {}) }
        const stuck = entry.mood === '✓' ? stuckSince(saved.filter(s => s.goal === goal)) : undefined
        if (stuck !== undefined) entry.stuck = entry.at - stuck
        h.saved = [...saved, entry].slice(-keep)
        await $.store.set(`h:${h.id}`, h.saved)
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('command.run', { command: 'catchup' }, async $ => {
    open = null
    all = false
    await $.ui.open({ id: PANE, title: 'Catch-up' })
    return {}
  })

  // The lay of the land for someone coming back: what waits on them, where each goal
  // stands, what the agents and other sessions are doing; then one visual in full and
  // the rest of the history, newest first.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { id, saved, seen } = await history($, held)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const crew = activity ? await agentRows($, now) : []
    const others = await otherSessions($, id, now)
    if (saved.length === 0 && crew.length === 0 && others.length === 0)
      return <Text dimColor>Nothing yet. Visuals the agent draws in this session collect here.</Text>
    const show = (at: number) => () => { open = at; $.ui.invalidate('ui.render') }
    const fresh = saved.filter(s => s.at > seen).length
    const asks = saved.filter(s => s.spec.ask && s.at > seen).reverse()
    const goals = byGoal(saved)
    const named = goals.some(g => g.goal !== undefined)
    const lead = saved.length ? (waiting(saved, seen) ?? outcome(saved)) : undefined
    const picked = saved.find(s => s.at === open) ?? lead
    const rest = saved.filter(s => s !== picked).reverse()
    const list = all ? rest : rest.slice(0, RECENT)
    const room = (used: number) => Math.max(10, cols - used)
    const glyph = (g: string) => <Text color={MOOD[g]} dimColor={!MOOD[g]}>{g} </Text>
    const head = (t: string) => <Text bold>{t}</Text>
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{fresh ? `${fresh} new` : 'Up to date'}</Text>
          <Text dimColor>{` · ${saved.length} visual${saved.length === 1 ? '' : 's'}${named ? ` · ${goals.length} goal${goals.length === 1 ? '' : 's'}` : ''}`}</Text>
        </Text>
        {asks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Needs you')}
            {asks.map(s => (
              <Box key={`ask:${s.at}`}>
                {glyph('?')}
                <Button key={`ask:${s.at}`} label={cutWords(s.spec.soWhat ?? s.title, room(24))} onPress={show(s.at)} />
                <Text dimColor wrap="truncate-end">{`  ${[s.goal, ago(now - s.at)].filter(Boolean).join(' · ')}`}</Text>
              </Box>
            ))}
          </Box>
        )}
        {named && (
          <Box flexDirection="column" marginTop={1}>
            {head('Goals')}
            {goals.slice(0, 6).map(g => {
              const o = outcome(g.saved)
              const n = g.saved.length
              return (
                <Box key={`goal:${g.goal ?? ''}`}>
                  {glyph(o.mood)}
                  <Button key={`goal:${g.goal ?? ''}`} label={cutWords(g.goal ?? 'Other', 32)} onPress={show(o.at)} />
                  <Text dimColor wrap="truncate-end">{`  ${cutWords(o.title, room(52))} · ${n} visual${n === 1 ? '' : 's'} · ${ago(now - g.saved.at(-1)!.at)}`}</Text>
                  {g.saved.some(s => s.at > seen) ? <Text color="claude"> ●</Text> : ''}
                </Box>
              )
            })}
          </Box>
        )}
        {crew.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Agents')}
            {crew.map(a => (
              <Box key={`agent:${a.id}`}>
                {glyph(a.glyph)}
                <Text>{cutWords(a.name, 24)}</Text>
                <Text dimColor wrap="truncate-end">{`  ${[a.detail && cutWords(a.detail, room(40)), a.at !== undefined ? ago(now - a.at) : ''].filter(Boolean).join(' · ')}`}</Text>
              </Box>
            ))}
          </Box>
        )}
        {others.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Other sessions')}
            {others.map(o => (
              <Box key={`session:${o.id}`}>
                {glyph(o.glyph)}
                <Text>{cutWords(o.dir, 24)}</Text>
                <Text dimColor wrap="truncate-end">{`  ${cutWords(o.text, room(40))} · ${ago(now - o.at)}`}</Text>
              </Box>
            ))}
          </Box>
        )}
        {picked && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              {[picked.goal, ago(now - picked.at)].filter(Boolean).join(' · ')}
              {picked.stuck !== undefined ? <Text color="success">{` · ${unblocked(picked.stuck)}`}</Text> : ''}
              {picked.at > seen ? <Text color="claude"> · new</Text> : ''}
            </Text>
            {visual({ Box, Text }, draw(picked.spec, cols))}
          </Box>
        )}
        {rest.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {head('Earlier')}
            {list.map(s => (
              <Box key={`v:${s.at}`}>
                {glyph(s.spec.ask ? '?' : s.mood)}
                <Button key={`v:${s.at}`} label={cutWords(s.title, room(16))} onPress={show(s.at)} />
                <Text dimColor>{`  ${ago(now - s.at)}`}</Text>
                {s.stuck !== undefined ? <Text color="success" dimColor> · unblocked</Text> : ''}
                {s.at > seen ? <Text color="claude"> ●</Text> : ''}
              </Box>
            ))}
            {rest.length > RECENT ? (
              <Button key="more" label={all ? 'Show fewer' : `Show all ${rest.length}`} onPress={() => { all = !all; $.ui.invalidate('ui.render') }} />
            ) : ''}
          </Box>
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

/** `v` when it is one of `allowed`, else `fallback`. */
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback
}

const base = (p: unknown) => String(p ?? '').split('/').filter(Boolean).at(-1) ?? ''
const quoted = (q: unknown) => `“${cut(String(q ?? ''), 32)}”`

type Held = { cache: { id: string; saved: Saved[]; seen: number } | null } // seen: when you last typed

/** This session's history, kept in `held` so the band, redrawn on every tool call, skips the store. */
async function history($: EngineInterface, held: Held) {
  const id = await $.session.id()
  if (held.cache?.id !== id) {
    const saved = ((await $.store.get(`h:${id}`)) as Saved[] | undefined) ?? []
    held.cache = { id, saved, seen: Number((await $.store.get(`p:${id}`)) ?? 0) }
  }
  return held.cache
}

/** Folds `patch` into what the agent is on. Swallows its own failures: a throw after
 *  `next` would make the tool.call hook's catch run the tool twice. */
async function merge($: EngineInterface, patch: Now) {
  try {
    const cur = (await $.state.get(NOW)).value ?? {}
    await $.state.set(NOW, { ...cur, ...patch })
  } catch {}
}

const GOAL_SYSTEM = `You label what a developer's coding session is working on, for a status line.
Reply with the goal only: 2 to 6 words, sentence case, no trailing period, no quotes.
Name the work, not the wording: "Fix Safari login redirect", not "User asks about redirect".
If the new message continues or adjusts the current goal (a yes, a correction, a detail), reply with the current goal unchanged.
If there is no current goal and the message has no clear task, reply NONE.`

/** A plain prompt's goal, named by Haiku with the current goal as context; undefined when it can't say. */
async function nameGoal($: EngineInterface, text: string): Promise<string | undefined> {
  const plain = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\[(Image|Pasted text) #\d+[^\]]*\]/g, '[attachment]').replace(/\s+/g, ' ').trim()
  if (!plain || plain === '[attachment]') return undefined
  try {
    const cur = (await $.state.get(NOW)).value?.goal
    const r = await $.model.complete({
      model: 'haiku',
      system: GOAL_SYSTEM,
      prompt: `Current goal: ${cur ?? '(none)'}\n\nNew message:\n${plain.slice(0, 2000)}`,
      maxTokens: 30,
      effort: 'low',
      timeoutMs: 8000,
    })
    if (!r.isAnswered) return undefined
    const g = r.text.trim().split('\n')[0].replace(/^["'`]+|["'`.]+$/g, '').trim()
    return g && g !== 'NONE' ? cutWords(g, 48) : undefined
  } catch {
    return undefined
  }
}

/** `code-review` → `Code review`. */
const human = (s: string) => s.replace(/[-_]+/g, ' ').trim().replace(/^./, c => c.toUpperCase())

/** A skill as a goal: its name, or for a plugin's lone skill (`impeccable:impeccable polish`) the plugin and the sub-command. */
export function skillGoal(skill: string, args = ''): string | undefined {
  const [plugin, name = plugin] = skill.split(':')
  if (!name) return undefined
  const sub = args.trim().split(/\s+/)[0]
  return skill.includes(':') && name === plugin && sub && /^[a-z][\w-]*$/.test(sub) ? `${human(name)} ${sub}` : human(name)
}

/** What a prompt is for, when it says so itself: the slash command it runs. A plain prompt goes to Haiku (nameGoal). */
export function goalOf(text: string): string | undefined {
  const tag = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)
  if (tag) return skillGoal(tag[1].trim(), /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? '')
  const slash = /^\s*\/([\w:-]+)(.*)$/s.exec(text)
  if (slash) return skillGoal(slash[1], slash[2])
  return undefined
}

type Seg2 = { t: string; dim?: boolean }

function segs(Text: any, l: Seg2[]) {
  return l.map((s, k) => (
    <Text key={String(k)} dimColor={s.dim}>
      {s.t}
    </Text>
  ))
}

/** The task, or with none the list, and how far through the list it is: `Checking the spec 2/5`. */
function progress(now: Now | null): string | undefined {
  const of = now?.total && now.total > 1 ? `${now.done ?? 0}/${now.total}` : ''
  return [now?.task, of].filter(Boolean).join(' ') || undefined
}

/** What the agent is on, in `n` cells: the goal and task, the step only when there is neither, and the agents dim. */
function doing(head: string, step: string | undefined, agents: string, n: number): Seg2[] {
  const tail = agents && w(agents) + 3 <= n - 16 ? [{ t: ` · ${agents}`, dim: true }] : []
  const room = n - (tail.length ? w(tail[0].t) : 0)
  return [{ t: head ? cutWords(head, room) : step ? `› ${cut(step, room - 2)}` : '' }, ...tail]
}

/** Where the work landed, in `n` cells: `goal → outcome  meta`. The goal gives way first, then the meta. */
function landed(goal: string | undefined, title: string, meta: string, n: number): Seg2[] {
  const m = meta && w(meta) + 2 <= n - 16 ? [{ t: `  ${meta}`, dim: true }] : []
  const room = n - (m.length ? w(m[0].t) : 0)
  const lead = goal && goal !== title && w(goal) + 3 + w(title) <= room ? [{ t: `${goal} → `, dim: true }] : []
  return [...lead, { t: cutWords(title, room) }, ...m]
}

/** Where the latest goal stands: its latest status visual (flow, path, tree) when that is red, else the latest
 *  visual. A blocker clears once a newer status visual of its goal is not red, or the work moves to another goal. */
export function outcome(saved: Saved[]): Saved {
  const last = saved.at(-1)!
  const status = saved.findLast(s => s.goal === last.goal && STATUS_FORMS.has(s.spec.form))
  return status?.mood === '✗' ? status : last
}

/** The latest question for you that came in after you last typed; answering it is typing. */
export function waiting(saved: Saved[], seen: number): Saved | undefined {
  return saved.findLast(s => s.spec.ask && s.at > seen)
}

/** History grouped by goal, the goal worked on most recently first. */
export function byGoal(saved: Saved[]): Array<{ goal?: string; saved: Saved[] }> {
  const groups = new Map<string | undefined, Saved[]>()
  for (const s of saved) groups.set(s.goal, [...(groups.get(s.goal) ?? []), s])
  return [...groups].map(([goal, saved]) => ({ goal, saved })).sort((a, b) => b.saved.at(-1)!.at - a.saved.at(-1)!.at)
}

/** Gives the visuals saved at or after `since` the goal named for that prompt, when it came in after they were saved. */
async function regoal($: EngineInterface, held: Held, since: number, goal: string) {
  try {
    const h = await history($, held)
    if (!h.saved.some(s => s.at >= since && s.goal !== goal)) return
    h.saved = h.saved.map(s => (s.at >= since ? { ...s, goal } : s))
    await $.store.set(`h:${h.id}`, h.saved)
    $.ui.invalidate('ui.render')
  } catch {}
}

/** Folds `patch` into one agent's note; keeps the 20 heard from last. Swallows its failures, as merge does. */
async function noteAgent($: EngineInterface, id: string, patch: Partial<AgentNote> & { at: number }) {
  try {
    const cur = (await $.state.get(AGENTS)).value ?? {}
    const all = Object.entries({ ...cur, [id]: { ...cur[id], ...patch } }).sort((a, b) => b[1].at - a[1].at)
    await $.state.set(AGENTS, Object.fromEntries(all.slice(0, 20)))
  } catch {}
}

/** An answer in a line: its visual's headline, else its first line of prose without markdown. */
export function headline(answer: string): string | undefined {
  const viz = split(answer).flatMap(p => ('viz' in p ? [p.viz] : [])).at(-1)
  if (viz) return viz.title
  const line = answer.split('\n').map(l => l.replace(/^[\s#>*\-]+|[*_`]+/g, '').trim()).find(Boolean)
  return line ? cutWords(line, 100) : undefined
}

const AGENT_MOOD: Record<string, string> = { running: '◉', pending: '◉', waiting: '◉', idle: '◆', completed: '✓', failed: '✗', killed: '✗' }

/** This session's agents for /catchup: still working first, each with what it is on or what it found. */
async function agentRows($: EngineInterface, now: number) {
  try {
    const list = await $.agent.list()
    const notes = (await $.state.get(AGENTS)).value ?? {}
    const live = (s: string) => AGENT_MOOD[s] === '◉'
    return list
      .map(a => {
        const n = notes[a.id] as AgentNote | undefined
        const detail = live(a.status) ? (n?.step ?? a.description) : (n?.result ?? n?.step ?? a.description)
        return { id: a.id, glyph: AGENT_MOOD[a.status] ?? '◆', name: a.name || a.description || a.type, detail, at: n?.at, live: live(a.status) }
      })
      .sort((a, b) => Number(b.live) - Number(a.live) || (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 6)
  } catch {
    return []
  }
}

/** Other sessions with a visual in the last day, from the history every session keeps in the store; those waiting on you first. */
async function otherSessions($: EngineInterface, id: string, now: number) {
  try {
    const out: Array<{ id: string; dir: string; glyph: string; text: string; at: number; ask: boolean }> = []
    for (const key of await $.store.keys()) {
      if (!key.startsWith('h:') || key === `h:${id}`) continue
      const sid = key.slice(2)
      const saved = ((await $.store.get(key)) as Saved[] | undefined) ?? []
      const last = saved.at(-1)
      if (!last || now - last.at > DAY) continue
      const ask = waiting(saved, Number((await $.store.get(`p:${sid}`)) ?? 0))
      const lead = ask ?? outcome(saved)
      const dir = String((await $.store.get(`d:${sid}`)) ?? sid.slice(0, 8))
      const text = ask ? `Needs you: ${ask.spec.soWhat}` : [lead.goal, lead.title].filter(Boolean).join(' → ')
      out.push({ id: sid, dir, glyph: ask ? '?' : lead.mood, text, at: last.at, ask: !!ask })
    }
    return out.sort((a, b) => Number(b.ask) - Number(a.ask) || b.at - a.at).slice(0, 5)
  } catch {
    return []
  }
}

/** Subagents and teammates still at work; 0 where the list can't be read. */
async function running($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting').length
  } catch {
    return 0
  }
}

/** A tool call as a few words: Bash's own description, else the tool and its target. */
export function stepOf(e: Record<string, unknown>): string | undefined {
  const str = (k: string) => (typeof e[k] === 'string' && e[k] ? (e[k] as string) : undefined)
  switch (e.tool) {
    case 'Bash': return str('description') ?? `Running ${str('command')?.trim().split(/\s+/)[0] ?? 'a command'}`
    case 'Read': return `Reading ${base(e.file_path)}`
    case 'Edit': case 'MultiEdit': return `Editing ${base(e.file_path)}`
    case 'Write': return `Writing ${base(e.file_path)}`
    case 'NotebookEdit': return `Editing ${base(e.notebook_path)}`
    case 'Grep': return `Searching for ${quoted(e.pattern)}`
    case 'Glob': return `Finding ${quoted(e.pattern)}`
    case 'Agent': case 'Task': return str('description') ? `Delegating: ${str('description')}` : 'Starting an agent'
    case 'WebSearch': return `Searching the web for ${quoted(e.query)}`
    case 'WebFetch': return `Fetching ${/^https?:\/\/([^/]+)/.exec(str('url') ?? '')?.[1] ?? 'a page'}`
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet': case 'ToolSearch': return undefined // bookkeeping, not work
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(e.tool))
  return mcp ? `${mcp[2].replace(/_/g, ' ')} (${mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')})` : `Using ${e.tool}`
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
