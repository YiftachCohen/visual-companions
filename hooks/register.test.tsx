import { expect, test } from 'claude-code/testing'

import { booMood, cells, COLOR as BOO, FRAMES, frameAt } from './boo'
import { smallCells } from './boo-small'
import { change, cutWords, draw, mood, parse, plain, split, w } from './render'
import { goalOf, skillGoal, stepOf } from './register'

const FLOW = `flow Release is blocked at the migrate step
+ build
+ unit tests
x migrate | lock timeout above 10k rows
. deploy
> Need a batching decision first.`

const EXAMPLES = [
  FLOW,
  `tree Why cache misses spiked\nx hit rate 0.49 in production\n  + keys include a timestamp | confirmed in logs\n  - eviction too aggressive | ruled out, 2% evicted\n  . TTL too short\n    retry with a longer TTL`,
  `delta New ranking model trades latency for recall\nrecall: 0.91 -> 0.95 +\np50 latency: 180ms -> 420ms -\ncost / 1k: $0.40 -> $0.40`,
  `bars New model barely beats a length heuristic\n@ unit=%; max=100; bar=85\nnew model: 89 *\nlength heuristic: 82\nrandom: 50`,
  `tradeoff Self-hosting is the middle path\n@ x=effort saved; y=fidelity\nfork upstream: 0.85 0.35\nself-host: 0.5 0.7 *\nbuild in-house: 0.05 0.95`,
]

test('every form parses and fits its width', async () => {
  for (const src of EXAMPLES) {
    const spec = parse(src)
    expect(spec).not.toBe(null)
    for (const cols of [44, 80]) {
      const text = plain(draw(spec!, cols))
      for (const line of text.split('\n')) expect(w(line) <= Math.max(44, Math.min(72, cols))).toBe(true)
    }
  }
  expect(plain(draw(parse(FLOW)!))).toContain('✓ ━━━')
})

test('awkward input still draws every value', async () => {
  const fits = (src: string, cols: number) => {
    const text = plain(draw(parse(src)!, cols))
    for (const line of text.split('\n')) expect(w(line) <= Math.max(40, Math.min(72, cols))).toBe(true)
    return text
  }
  // Negative bars draw an empty track instead of throwing.
  expect(fits('bars Mixed signs\nA: -5\nB: 10', 80)).toContain('-5')
  // Notes don't swallow the numbers or markers before them.
  const b = fits('bars Noted\nA: 89 * | selected\nB: 50', 80)
  expect(b).toContain('89')
  expect(b).toContain('◀')
  expect(b).toContain('selected')
  expect(fits('tradeoff Noted\nA: 0.5 0.7 * | recommended', 80)).toContain('★')
  expect(fits('delta Noted\nerrors: 10 -> 0 + | after the fix', 80)).toContain('▲')
  // A drop to zero is a finite change.
  expect(change('10', '0')).toBe('-100%')
  // Long delta rows are shortened to fit, keeping the verdict.
  expect(fits('delta Long\nvery long metric name that matters: 180ms -> 420ms -', 44)).toContain('▼')
  // Options sharing a cell all stay visible.
  const t = fits('tradeoff Shared\nA: 0.5 0.5\nB: 0.5 0.5\nC: 0.5 0.5', 80)
  expect(t).toContain('A, B, C')
})

test('review fixes: labels, crowding, long flows, notes, titles, moods', async () => {
  // Status marks belong to flow and tree: elsewhere a leading `x ` is part of the label.
  expect(plain(draw(parse('bars Axes\nx axis: 3\ny axis: 5')!))).toContain('x axis')
  // A crowded plot labels the chosen option by name rather than a legend letter.
  const crowd = plain(draw(parse('tradeoff Crowded\n@ x=speed; y=quality\nalpha option: 0.5 0.5\nbeta option: 0.52 0.5 *')!, 44))
  expect(crowd).toContain('★ beta option')
  expect(crowd).toContain('alpha option')
  // A long flow drops the rail between steps so it stays short.
  const long = draw(parse('flow Long\n+ schema design\n+ API endpoints for accounts\n* frontend wizard\n. email templates\n. analytics events\n. rollout')!)
  expect(long.length).toBeLessThan(12)
  // A tree note on its own line keeps the sibling line running past it.
  const tree = plain(draw(parse('tree Why\nx root\n  + keys include a timestamp | confirmed in the production logs today\n  . TTL too short')!, 44))
  expect(tree).toMatch(/│  │ +confirmed|│  │\s+confirmed/)
  // Titles are cut between words.
  expect(cutWords('Release is blocked at the migrate step', 30)).toBe('Release is blocked at the…')
  // A regression has its own glyph, apart from neutral.
  expect(mood(parse('delta D\nlatency: 1 -> 2 -')!).glyph).toBe('▼')
  expect(mood(parse('delta D\nlatency: 1 -> 2')!).glyph).toBe('◆')
})

test('a viz fence still streaming draws as it grows', async () => {
  const parts = split('Intro.\n```viz\nflow Streaming\n+ build\n* tes')
  expect(parts.some(p => 'viz' in p && p.viz.items.length === 2)).toBe(true)
  expect(parts.some(p => 'md' in p && p.md.includes('```'))).toBe(false)
})

test('a viz example quoted in a longer fence stays prose', async () => {
  const text = 'Example:\n````md\n```viz\nflow Quoted\n+ a\n```\n````\n'
  expect(split(text).every(p => 'md' in p)).toBe(true)
})

test('an unknown form stays prose', async () => {
  expect(split('hi\n```viz\nchart nope\n+ a\n```\n').every(p => 'md' in p)).toBe(true)
})

test('a viz fence is drawn as the visual above the prose', async ($, on) => {
  // Stands in for the engine's own drawing of the message's prose.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{(e.props as { text?: string }).text ?? ''}</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'visual-companions',
      surface,
      component: 'AssistantMessage',
      props: { text: '```viz\n' + FLOW + '\n```\nDetails follow here.', isFirstOfReply: true },
    })
    expect(await ui.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /Details follow here/ })).not.toBe(undefined)
    expect(await ui.find({ text: /```viz/ })).toBe(undefined)
  }
})

test('the guide is added to the system prompt', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base prompt', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections.some(s => s.id === 'visual-companions:guide')).toBe(true)
})

test('the guide is left out where nothing draws', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base prompt', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: [],
    tools: [],
    outputStyle: null,
    traits: ['print'],
  })
  expect(sections.some(s => s.id === 'visual-companions:guide')).toBe(false)
})

test('every Boo frame is 6 × 4 and packs into 6 × 2 cells', async () => {
  for (const [name, rows] of Object.entries(FRAMES)) {
    expect(rows.length).toBe(4)
    for (const r of rows) expect(r.length).toBe(6)
    expect(cells(name, BOO.neutral).length).toBe((6 * 2 * 3 * 4 * 4) / 3)
  }
})

test('Boo plays a reaction once, then loops', async () => {
  expect(frameAt('success', 0).frame).toBe('cheer')
  expect(frameAt('success', 190).frame).toBe('smile')
  expect(frameAt('success', 5000).frame).toBe('smile')
  expect(frameAt('working', 0).frame).toBe(frameAt('working', 1440).frame)
  expect(booMood(parse(FLOW)!)).toBe('blocked')
})

test('the band draws Boo in the terminal and the glyph elsewhere', async ($, on) => {
  const spec = parse(FLOW)!
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as any
  const term = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await term.find({ type: 'Raster' })).not.toBe(undefined)
  expect(await term.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
  const desk = await $.ui.mount({ plugin: 'visual-companions', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await desk.find({ type: 'Raster' })).toBe(undefined)
  expect(await desk.find({ type: 'Text', text: /✗/ })).not.toBe(undefined)
})

test('nothing is drawn before the first visual, even while the model works', async ($, on) => {
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80 } as any
  const working = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await working.find({ type: 'Raster' })).toBe(undefined)
  const idle = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props: { ...props, isWorking: false } })
  expect(await idle.find({ type: 'Raster' })).toBe(undefined)
})

test('a green visual after a blocked one plays relief, starting from the blocked pose', async () => {
  expect(frameAt('relieved', 0).frame).toBe('stuck')
  expect(cells('stuck', BOO.relieved)).toBe(cells('low', BOO.blocked))
  expect(frameAt('relieved', 5000).frame).toBe('smile')
})

test('the band plays relief when the work was stuck', { options: { companion: 'big' } }, async ($, on) => {
  const spec = parse('flow Release shipped\n+ build\n+ migrate\n+ deploy')!
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: [{ at: 10_000, title: spec.title, mood: '✓', spec, stuck: 720_000 }] }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as any
  const term = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  const boo = (await term.find({ type: 'Raster' })) as any
  expect(boo.props.cells).toBe(cells('stuck', BOO.relieved))
})

test('a green visual records how long the work was stuck since it first went red', async ($, on) => {
  const store = new Map<string, unknown>()
  let now = 0
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: now }))
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  const turn = (answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: String(now), reason: 'answer' } as any)
  const viz = (src: string) => '```viz\n' + src + '\n```\n'
  await turn(viz('flow Shipped earlier\n+ a\n+ b'))
  now = 60_000
  await turn(viz('flow Blocked\n+ a\nx b'))
  now = 300_000
  await turn(viz('flow Still on it\n+ a\n* b'))
  now = 780_000
  await turn(viz('flow Shipped\n+ a\n+ b'))
  const saved = store.get('h:s1') as Array<{ stuck?: number }>
  expect(saved.map(s => s.stuck)).toEqual([undefined, undefined, undefined, 720_000])
})

test('small Boo is three braille cells on one row, the eyes left as gaps', async () => {
  const row = smallCells('neutral', 0)
  expect(row.length).toBe(8)
  expect(row.map(([c]) => String.fromCharCode(c)).join('').trim()).toBe('⡮⣿⢵')
  for (const m of ['neutral', 'working', 'success', 'blocked', 'mixed', 'relieved'] as const) {
    for (let t = 0; t < 4000; t += 70) {
      for (const [c] of smallCells(m, t)) expect(c === 0x20 || (c >= 0x2800 && c <= 0x28ff)).toBe(true)
    }
  }
})

test('small Boo sways a dot at a time and leaves a trail while working', async () => {
  const at = (t: number) => smallCells('working', t).map(([c]) => c)
  expect(at(0)).not.toEqual(at(260))
  expect(at(400).filter(c => c !== 0x20).length).toBeGreaterThan(3)
})

async function band($: any, on: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const spec = parse(FLOW)!
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as any
  return $.ui.mount({ plugin: 'visual-companions', surface, component: 'AbovePrompt', props })
}

test('the companion option picks small Boo by default', async ($, on) => {
  const raster = await (await band($, on)).find({ type: 'Raster' })
  expect([raster?.props.columns, raster?.props.rows]).toEqual([8, 1])
})

test('the companion option can pick big Boo', { options: { companion: 'big' } }, async ($, on) => {
  const raster = await (await band($, on)).find({ type: 'Raster' })
  expect([raster?.props.columns, raster?.props.rows]).toEqual([6, 2])
})

test('the companion option can turn Boo off', { options: { companion: 'off' } }, async ($, on) => {
  const ui = await band($, on)
  expect(await ui.find({ type: 'Raster' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /✗/ })).not.toBe(undefined)
})

test('small Boo plays relief too, starting red and dim before it cheers', async () => {
  const [stuck, cheering] = [smallCells('relieved', 0), smallCells('relieved', 700)]
  expect(stuck.some(([, fg]) => fg === smallCells('blocked', 1000)[3][1])).toBe(true)
  expect(cheering.map(([c]) => c)).toEqual(smallCells('success', 40).map(([c]) => c))
})

test('a tool call reads as a few words', async () => {
  expect(stepOf({ tool: 'Bash', command: 'bun test', description: 'Run plugin tests' })).toBe('Run plugin tests')
  expect(stepOf({ tool: 'Bash', command: '  git status' })).toBe('Running git')
  expect(stepOf({ tool: 'Edit', file_path: '/repo/hooks/boo.ts' })).toBe('Editing boo.ts')
  expect(stepOf({ tool: 'Grep', pattern: 'stuckSince' })).toBe('Searching for “stuckSince”')
  expect(stepOf({ tool: 'WebFetch', url: 'https://code.claude.com/docs' })).toBe('Fetching code.claude.com')
  expect(stepOf({ tool: 'mcp__claude_ai_Gmail__search_threads' })).toBe('search threads (Gmail)')
  expect(stepOf({ tool: 'TodoWrite', todos: [] })).toBe(undefined)
})

test('a prompt names its goal: the slash command, else its opening words', async () => {
  expect(goalOf('/code-review since main')).toBe('Code review')
  expect(goalOf('<command-message>impeccable:impeccable</command-message>\n<command-name>/impeccable:impeccable</command-name>\n<command-args>polish</command-args>')).toBe('Impeccable polish')
  expect(goalOf('Fix the login redirect. It loops on Safari.')).toBe('Fix the login redirect')
  expect(goalOf('Hmm but then it shows only the exact tool it is running on the moment? what about the big picture?')).toBe('Hmm but then it shows only the exact tool it…')
  expect(skillGoal('mattpocock-skills:code-review')).toBe('Code review')
  expect(goalOf('[Image #11]')).toBe(undefined)
  expect(goalOf('[Image #2] why is this red? [Pasted text #1 +12 lines]')).toBe('why is this red')
})

for (const companion of ['big', 'small', 'off'] as const) {
  test(`while working, the band shows the goal and the step (${companion})`, { options: { companion } }, async ($, on) => {
    const spec = parse(FLOW)!
    on('session.id', () => ({ value: 's1' }))
    on('clock.now', () => ({ value: 10_000 }))
    on('clock.after', () => ({ deny: 'no timers in this test' }))
    on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
    on('state.get', () => ({ value: { value: { goal: 'Code review', task: 'Checking the spec', step: 'Run plugin tests' }, version: 1 } }))
    const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } as any
    const working = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
    expect(await working.find({ type: 'Text', text: /Code review · Checking the spec/ })).not.toBe(undefined)
    expect(await working.find({ type: 'Text', text: /› Run plugin tests/ })).not.toBe(undefined)
    const idle = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props: { ...props, isWorking: false } })
    expect(await idle.find({ type: 'Text', text: /Code review/ })).toBe(undefined)
    expect(await idle.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
  })
}

test('with only a step, the big band keeps the last headline under it', { options: { companion: 'big' } }, async ($, on) => {
  const spec = parse(FLOW)!
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
  on('state.get', () => ({ value: { value: { step: 'Run plugin tests' }, version: 1 } }))
  const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /› Run plugin tests/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
})
