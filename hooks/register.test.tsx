import { expect, test } from 'claude-code/testing'

import { big, booMood, cells, COLOR as BOO, FRAMES, frameAt } from './boo'
import { small, smallCells } from './boo-small'
import { change, cutWords, draw, mood, parse, plain, split, w } from './render'
import { byGoal, goalOf, headline, outcome, skillGoal, stepOf, waiting } from './register'

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
  `path Checkout requests die in the token refresh\nweb app\napi gateway\nx auth service | refresh token rejected: clock skew 4m\n. orders db`,
  `matrix Postgres wins on everything but setup\n@ cols=cost, scale, ops, setup time\npostgres: + + + ~ *\ndynamo: ~ + + + | vendor lock-in\nsqlite: + x + +`,
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

test('rows are read the way an agent writes them, and none are lost', async () => {
  const text = (src: string, cols = 80) => plain(draw(parse(src)!, cols))
  // Bar values keep their units, separators and magnitudes, and scale by value.
  const b = text('bars Latency by region\neu: 420ms\nus: 1,200ms *\nap: 0.9s')
  expect(b).toContain('420ms')
  expect(b).toContain('1,200ms')
  const row = (label: string) => b.split('\n').find(l => l.includes(label))!
  expect(row('us').split('█').length).toBeGreaterThan(row('eu').split('█').length)
  expect(text('bars Budget\n@ max=$2k; bar=$1.5k\nA: $900\nB: $1,800')).toContain('╰ $1.5k bar')
  // Durations compare across units, and a tiny value still shows.
  const d = text('bars Build time\nold: 2min\nnew: 45s *\ncached: 80ms')
  expect(d.split('\n').find(l => l.includes('old'))!.split('█').length).toBeGreaterThan(d.split('\n').find(l => l.includes('new'))!.split('█').length)
  expect(d.split('\n').find(l => l.includes('cached'))).toMatch(/cached  [▏▎▍▌▋▊▉█]/)
  // A row a chart can't plot is drawn as written, not as a zero bar, a blank delta or nothing.
  expect(text('bars Mixed\nA: 10\nB: unknown')).toContain('B: unknown')
  expect(text('tradeoff Mixed\nA: 0.5 0.7 *\nB: high effort, low risk')).toContain('B: high effort, low risk')
  expect(text('delta Mixed\nerrors: 10 -> 0 +\nlogs: now structured')).toContain('logs: now structured')
  // Common spellings: a unicode arrow, a comma between coordinates, a colon in the label.
  expect(text('delta Arrow\np50: 180ms → 420ms -')).toContain('▼')
  expect(text('tradeoff Comma\nA: 0.2, 0.9 *')).toContain('★ A')
  expect(text('bars Colon\nratio: p50: 420ms')).toContain('ratio: p50')
  // A chart with nothing to plot stays the code block it was written as.
  expect(parse('bars Nothing\nA: soon\nB: later')).toBe(null)
  expect(parse('delta Nothing\nlogs: now structured')).toBe(null)
})

test('path draws components as boxes, and falls back to the list when they need a second row', async () => {
  const src = 'path Checkout dies in the token refresh\nweb app\napi gateway\nx auth service | refresh token rejected\n. orders db'
  const wide = plain(draw(parse(src)!, 80))
  expect(wide).toContain('│ web app │──▶│ api gateway │')
  // The hop out of a blocked component is broken, and its mark sits in the box's border.
  expect(wide).toContain('│ auth service │┄┄▶│ orders db │')
  expect(wide).toMatch(/└─+✗─+┘/)
  expect(wide).toContain('↑ refresh token rejected')
  const narrow = plain(draw(parse(src)!, 44))
  expect(narrow).not.toContain('┌')
  expect(narrow).toMatch(/✗  auth service/)
  expect(narrow).toContain('refresh token rejected')
  // A list is one line per component (plus notes and rail), not three.
  expect(narrow.split('\n').length).toBeLessThan(plain(draw(parse(src)!, 80)).split('\n').length + 4)
  expect(mood(parse(src)!).glyph).toBe('✗')
  // Unmarked components draw without a mark; a lone component is still a path.
  expect(plain(draw(parse('path One\napi')!))).not.toMatch(/[✓✗○◉⊘•]/)
})

test('matrix lines cells up under their criteria and stars the choice', async () => {
  const m = plain(draw(parse('matrix Pick\n@ cols=cost, scale\npostgres: + ~ *\nsqlite: + x\nduck: 3 1.2k')!, 80)).split('\n')
  const at = (row: string, s: string) => m.find(l => l.includes(row))!.indexOf(s)
  expect(m.find(l => l.includes('postgres'))).toContain('★ postgres')
  expect(at('postgres', '~')).toBe(at('sqlite', '✗'))
  expect(at('postgres', '✓')).toBe(at('sqlite', '✓'))
  // Values that aren't marks draw as written.
  expect(m.find(l => l.includes('duck'))).toContain('1.2k')
  // A matrix with no row to draw stays a code block.
  expect(parse('matrix Nothing\n@ cols=a\njust prose')).toBe(null)
  // So does one with no criteria to read its marks against.
  expect(parse('matrix Unlabeled\npg: + ~ *\nlite: + x')).toBe(null)
  expect(parse('matrix Blank\n@ cols= , \npg: + ~')).toBe(null)
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

test('a slash command names its goal; a plain prompt names none by itself', async () => {
  expect(goalOf('/code-review since main')).toBe('Code review')
  expect(goalOf('<command-message>impeccable:impeccable</command-message>\n<command-name>/impeccable:impeccable</command-name>\n<command-args>polish</command-args>')).toBe('Impeccable polish')
  expect(goalOf('Fix the login redirect. It loops on Safari.')).toBe(undefined)
  expect(goalOf('Hmm but then it shows only the exact tool it is running on the moment? what about the big picture?')).toBe(undefined)
  expect(skillGoal('mattpocock-skills:code-review')).toBe('Code review')
  expect(goalOf('[Image #11]')).toBe(undefined)
  expect(goalOf('[Image #2] why is this red? [Pasted text #1 +12 lines]')).toBe(undefined)
})

for (const companion of ['big', 'small', 'off'] as const) {
  test(`while working, the band shows the goal and task; idle, the goal and where it landed (${companion})`, { options: { companion } }, async ($, on) => {
    const spec = parse(FLOW)!
    on('session.id', () => ({ value: 's1' }))
    on('clock.now', () => ({ value: 10_000 }))
    on('clock.after', () => ({ deny: 'no timers in this test' }))
    on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
    on('state.get', () => ({ value: { value: { goal: 'Code review', task: 'Checking the spec', done: 2, total: 5, step: 'Run plugin tests' }, version: 1 } }))
    const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } as any
    const working = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
    expect(await working.find({ type: 'Text', text: /Code review · Checking the spec 2\/5/ })).not.toBe(undefined)
    // The step gives way: one row has no room for it, two rows keep it dim under the goal.
    expect((await working.find({ type: 'Text', text: /› Run plugin tests/ })) !== undefined).toBe(companion === 'big')
    const idle = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props: { ...props, isWorking: false } })
    expect(await idle.find({ type: 'Text', text: /Code review/ })).not.toBe(undefined)
    expect(await idle.find({ type: 'Text', text: /Checking the spec|Run plugin tests/ })).toBe(undefined)
    expect(await idle.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
  })
}

test('an open blocker leads the band over newer headlines, with what came in since you typed', async ($, on) => {
  const red = parse(FLOW)!
  const later = parse('delta Cache warmed\nhits: 0.4 -> 0.5')!
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 3_000_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', (_, e: any) =>
    ({ value: e.key === 'p:s1' ? 100 : [{ at: 0, title: 'Shipped', mood: '✓', spec: red }, { at: 600_000, title: red.title, mood: '✗', spec: red }, { at: 900_000, title: later.title, mood: '◆', spec: later }] }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /✗/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Cache warmed/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /open 40m · 2 new · \/catchup/ })).not.toBe(undefined)
})

test('the band counts agents still running', async ($, on) => {
  const spec = parse(FLOW)!
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
  const agent = (id: string, status: string) => ({ id, description: id, type: 'Explore', status })
  on('agent.list', () => ({ value: [agent('a', 'running'), agent('b', 'running'), agent('c', 'completed')] }) as any)
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /2 agents running/ })).not.toBe(undefined)
})

test('the goal outlasts the turn; the task, progress and step do not', async ($, on) => {
  let now: any = { goal: 'Fix Safari login', task: 'Editing', done: 1, total: 3, step: 'Reading a.ts' }
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 0 }))
  on('store.get', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: now, version: 1 } }))
  on('state.set', (_, e: any) => { now = e.value; return { value: { version: 2 } } as any })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: '1', reason: 'answer' } as any)
  await new Promise(r => (globalThis as any).setTimeout(r, 10)) // band notes are written off the turn's path
  expect(now.goal).toBe('Fix Safari login')
  expect([now.task, now.done, now.total, now.step]).toEqual([undefined, undefined, undefined, undefined])
})

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

// Options: each is a /config row; `test(name, { options }, ...)` reads them as stored settings.

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }

test('visuals off leaves the guide out of the system prompt', { options: { visuals: false } }, async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base prompt', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({ ...COMPOSE, surfaces: ['terminal'] })
  expect(sections.some(s => s.id === 'visual-companions:guide')).toBe(false)
})

test('band off leaves the band to the engine', { options: { band: false } }, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const ui = await band($, on)
  expect(await ui.find({ type: 'Raster' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /engine band/ })).not.toBe(undefined)
})

test('activity off keeps the headline while working and notes no steps', { options: { activity: false } }, async ($, on) => {
  const spec = parse(FLOW)!
  const sets: unknown[] = []
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', () => ({ value: [{ at: 0, title: spec.title, mood: '✗', spec }] }))
  on('state.get', () => ({ value: { value: { goal: 'Code review', step: 'Run plugin tests' }, version: 1 } }))
  on('state.set', (_, e) => { sets.push(e); return { value: { version: 2 } } as any })
  on('tool.call', () => ({ result: { isError: false, text: 'ok' } }) as any)
  const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /Code review|Run plugin tests/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Release is blocked/ })).not.toBe(undefined)
  await $.tool.call({ tool: 'Read', input: { file_path: '/a/b.ts' } } as any).catch(() => {})
  expect(sets.length).toBe(0)
})

test('history keeps as many visuals as the option says', { options: { history: '10' } }, async ($, on) => {
  let stored: unknown[] = []
  const old = Array.from({ length: 12 }, (_, i) => ({ at: i, title: `v${i}`, mood: '◆', spec: parse('flow T\n+ a')! }))
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('store.get', () => ({ value: old }))
  on('store.set', (_, e: any) => { stored = e.value; return { value: undefined } as any })
  await $.turn.complete({ answer: '```viz\nflow Done\n+ a\n```', agentId: undefined } as any).catch(() => {})
  expect(stored.length).toBe(10)
})

test('reactions off skips straight to the resting loop', async () => {
  for (const c of [big, small]) {
    expect(c.settle('success')).toBeGreaterThan(0)
    expect(c.settle('neutral')).toBe(0)
  }
  // Big Boo's cheer is over by `settle`: the smile loop is what's left.
  expect(frameAt('success', big.settle('success')).frame).toBe('smile')
  expect(frameAt('relieved', big.settle('relieved')).frame).toBe('smile')
})

test('reactions off draws the band in its resting pose', { options: { companion: 'big', booReactions: false } }, async ($, on) => {
  const raster = (await band($, on)) as any
  const boo = await raster.find({ type: 'Raster' })
  // band() stores a red visual drawn at t = 10s: fully into the low loop either way, so compare with t = 0.
  expect(boo?.props.cells).toBe(big.draw('blocked', big.settle('blocked')))
})

test('still Boo draws one resting pose and sets no timer', { options: { booAnimation: 'still' } }, async ($, on) => {
  const spec = parse(FLOW)!
  let timers = 0
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', (_, e: any) => { if (e.ms < 60_000) timers++; return { deny: 'counted' } }) // the band's age tick is not Boo's
  on('store.get', () => ({ value: [{ at: 9_900, title: spec.title, mood: '✗', spec }] }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'AbovePrompt', props })
  const boo = (await ui.find({ type: 'Raster' })) as any
  expect(boo?.props.cells).toBe(small.draw('blocked', small.settle('blocked')))
  expect(timers).toBe(0)
})

test('effects off drops small Boo particles and glow', async () => {
  const plain = { palette: 'mood' as const, effects: false }
  const cheer = smallCells('success', 300, plain)
  expect(cheer.every(([, , bg]) => bg === smallCells('neutral', 0)[0][2])).toBe(true)
  // Only Boo's own dots: the three cells under it.
  const working = smallCells('working', 400, plain)
  expect(working.filter(([c]) => c !== 0x20).length).toBeLessThanOrEqual(4)
  expect(smallCells('success', 300)).not.toEqual(cheer)
})

test('colour picks mood, mono or claude', async () => {
  const mono = { palette: 'mono' as const, effects: true }
  const claude = { palette: 'claude' as const, effects: true }
  expect(cells('smile', BOO.neutral)).toBe(big.draw('success', 5000, mono))
  expect(big.draw('success', 5000, claude)).not.toBe(big.draw('success', 5000))
  expect(big.draw('success', 5000, claude)).toBe(cells('smile', 0xd97757))
  // Relief's stuck frames follow the palette too.
  expect(big.draw('relieved', 0, mono)).toBe(cells('low', BOO.neutral))
})

test('the colour option reaches the band', { options: { companion: 'big', booColor: 'claude' } }, async ($, on) => {
  const boo = (await (await band($, on)).find({ type: 'Raster' })) as any
  expect(boo?.props.cells).toBe(big.draw('blocked', 10_000, { palette: 'claude', effects: true }))
})

// ── catching up: questions, goals, agents, other sessions ────────────────

const at = (n: number, src: string, goal?: string) => {
  const spec = parse(src)!
  return { at: n, title: spec.title, mood: mood(spec).glyph, spec, ...(goal ? { goal } : {}) }
}
const PANE = { title: 'Catch-up', isFocused: true, bodyColumns: 100, placement: 'dock' } as any

test('"> ?" marks a question for the user, drawn apart from a next step', async () => {
  const q = parse('flow Migration needs a call\n+ build\nx migrate\n> ? Batch by 1k rows or lock the table?')!
  expect([q.ask, q.soWhat]).toEqual([true, 'Batch by 1k rows or lock the table?'])
  expect(plain(draw(q))).toContain('╰─ ? Batch by 1k rows')
  expect(parse('flow Plain\n+ a\n> Next: deploy')!.ask).toBe(false)
  expect(parse('flow Lone mark\n+ a\n> ?')!.ask).toBe(false)
})

test('a chosen option is a decision; a highlighted bar is not', async () => {
  expect(mood(parse('matrix Pick\n@ cols=a, b\npg: + ~ *\nlite: + x')!).glyph).toBe('★')
  expect(mood(parse('tradeoff Pick\nA: 0.5 0.7 *\nB: 0.2 0.9')!).glyph).toBe('★')
  expect(mood(parse('matrix Open\n@ cols=a\npg: +\nlite: x')!).glyph).toBe('◆')
  expect(mood(parse('bars Hi\nA: 3 *\nB: 2')!).glyph).toBe('◆')
})

test('path shows its progress in the title like flow', async () => {
  expect(plain(draw(parse('path P\n+ web\n+ api\nx auth\n. db')!))).toContain('P  2/4')
})

test("a blocker leads only for its own goal, until a newer status visual of that goal isn't red", async () => {
  const red = at(1, FLOW, 'Migrate users')
  // A chart after it doesn't clear it.
  expect(outcome([red, at(2, 'bars B\nA: 1\nB: 2', 'Migrate users')])).toBe(red)
  // A newer status visual of the goal does.
  const fixed = at(3, 'flow Batched\n+ build\n* migrate', 'Migrate users')
  expect(outcome([red, fixed, at(4, 'bars B\nA: 1', 'Migrate users')]).title).toBe('B')
  // Work on another goal leads with that goal.
  expect(outcome([red, at(5, 'bars Ranking eval\nA: 1', 'Ranking eval')]).title).toBe('Ranking eval')
})

test('a question waits until you type; history groups by goal, latest first', async () => {
  const q = at(10, 'flow Q\n+ a\n> ? Which one?', 'G1')
  expect(waiting([q], 5)).toBe(q)
  expect(waiting([q], 20)).toBe(undefined)
  const groups = byGoal([at(1, FLOW, 'G1'), at(2, FLOW, 'G2'), at(3, FLOW, 'G1')])
  expect(groups.map(g => [g.goal, g.saved.length])).toEqual([['G1', 2], ['G2', 1]])
})

test("an answer in a line: its visual's headline, else its first line of prose", async () => {
  expect(headline('```viz\n' + FLOW + '\n```\nmore')).toBe('Release is blocked at the migrate step')
  expect(headline('\n## **Found 3 stale pages** in docs/\nrest')).toBe('Found 3 stale pages in docs/')
  expect(headline('')).toBe(undefined)
})

test('the band leads with a question you have not answered', async ($, on) => {
  const q = at(5_000, 'flow Migration needs a call\n+ build\nx migrate\n> ? Batch or lock?')
  let seen = 0
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', (_, e: any) => ({ value: e.key === 'p:s1' ? seen : e.key === 'h:s1' ? [q] : undefined }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /Needs you: Batch or lock\?/ })).not.toBe(undefined)
})

test('the band says when another session is waiting on you', async ($, on) => {
  const q = at(5_000, 'flow Q\n+ a\n> ? Approve the schema?')
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.keys', () => ({ value: ['h:s1', 'h:s2', 'd:s2'] }))
  on('store.get', (_, e: any) => ({ value: ({ 'h:s1': [at(0, FLOW)], 'h:s2': [q], 'p:s2': 1_000, 'd:s2': 'api-server' } as any)[e.key] }))
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140 } as any
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /1 other session needs you/ })).not.toBe(undefined)
})

test('a visual is saved with the goal it was drawn for', async ($, on) => {
  const store = new Map<string, unknown>()
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 100 }))
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('state.get', () => ({ value: { value: { goal: 'Migrate users' }, version: 1 } }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '```viz\n' + FLOW + '\n```', durationMs: 1, isAborted: false, turnId: '1', reason: 'answer' } as any)
  expect((store.get('h:s1') as Array<{ goal?: string }>)[0].goal).toBe('Migrate users')
})

test("each subagent's latest step and its answer are kept for /catchup", async ($, on) => {
  let agents: any = null
  on('clock.now', () => ({ value: 50 }))
  on('state.get', (_, e: any) => ({ value: { value: e.key === 'agents' ? agents : null, version: 1 } }))
  on('state.set', (_, e: any) => { if (e.key === 'agents') agents = e.value; return { value: { version: 2 } } as any })
  on('tool.call', () => ({ result: { isError: false, text: 'ok' } }) as any)
  on('turn.complete', () => ({ text: '' }))
  on('store.get', () => ({ value: undefined }))
  const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 10))
  await $.tool.call({ tool: 'Read', file_path: '/a/token.ts', agentId: 'ag1' } as any).catch(() => {})
  await settle()
  expect(agents?.ag1?.step).toBe('Reading token.ts')
  await $.turn.complete({ answer: 'Found the expired key in vault.\nDetails…', agentId: 'ag1', durationMs: 1, isAborted: false, turnId: '2', reason: 'answer' } as any)
  await settle()
  expect([agents?.ag1?.result, agents?.ag1?.step]).toEqual(['Found the expired key in vault.', undefined])
})

test('/catchup lays out questions, goals, agents and other sessions, then the history', async ($, on) => {
  const hist = [
    ...Array.from({ length: 9 }, (_, i) => at(1_000 + i, `bars Eval run ${i}\nA: ${i + 1}`, 'Ranking eval')),
    at(2_000, FLOW, 'Migrate users'),
    at(3_000, 'flow Migration needs a call\n+ build\nx migrate\n> ? Batch or lock?', 'Migrate users'),
  ]
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 600_000 }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.keys', () => ({ value: ['h:s1', 'h:s2', 'p:s2', 'd:s2'] }))
  on('store.get', (_, e: any) => ({ value: ({ 'h:s1': hist, 'p:s1': 0, 'h:s2': [at(500_000, FLOW, 'Ship web')], 'p:s2': 0, 'd:s2': 'web' } as any)[e.key] }))
  on('agent.list', () => ({ value: [{ id: 'ag1', name: 'explore-auth', description: 'Explore auth', type: 'Explore', status: 'running' }] }) as any)
  on('state.get', (_, e: any) => ({ value: { value: e.key === 'agents' ? { ag1: { at: 590_000, step: 'Reading token.ts' } } : null, version: 1 } }))
  const ui = await $.ui.mount({ plugin: 'visual-companions', surface: 'terminal', component: 'Pane', requestId: 'catchup', props: PANE })
  // Every visual since you typed counts as new, not just the ones listed.
  expect(await ui.find({ type: 'Text', text: /^11 new$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Button', text: /^Batch or lock\?$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Button', text: /^Migrate users$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Button', text: /^Ranking eval$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /explore-auth/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Reading token\.ts/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^web$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Ship web → Release is blocked/ })).not.toBe(undefined)
  // The history lists 8 and offers the rest.
  expect(await ui.find({ type: 'Button', text: /^Show all 10$/ })).not.toBe(undefined)
  expect(await ui.find({ type: 'Button', text: /^Eval run 0$/ })).toBe(undefined)
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Button', text: /^Eval run 0$/ })).not.toBe(undefined)
})

test('a goal Haiku names after the turn ended is given to the visuals since that prompt', async ($, on) => {
  const store = new Map<string, unknown>()
  let now = 100
  let state: any = { goal: 'Older work' }
  let answer!: (r: unknown) => void
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: now }))
  on('clock.after', () => ({ deny: 'no timers in this test' }))
  on('store.get', (_, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('state.get', () => ({ value: { value: state, version: 1 } }))
  on('state.set', (_, e: any) => { state = e.value; return { value: { version: 2 } } as any })
  on('model.complete', () => new Promise(r => (answer = r)) as any)
  on('prompt.submit', (_, e: any) => ({ text: e.text }) as any)
  on('turn.complete', () => ({ text: '' }))
  const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 10))
  store.set('h:s1', [{ ...at(50, FLOW, 'Older work') }])
  await $.prompt.submit({ text: 'Migrate the users table to the new schema', wait: false, origin: { kind: 'composer' } } as any)
  now = 200
  await $.turn.complete({ answer: '```viz\n' + FLOW + '\n```', durationMs: 1, isAborted: false, turnId: '1', reason: 'answer' } as any)
  const goals = () => (store.get('h:s1') as Array<{ goal?: string }>).map(s => s.goal)
  expect(goals()).toEqual(['Older work', 'Older work'])
  answer({ value: { isAnswered: true, text: 'Migrate users table' } })
  await settle()
  expect(goals()).toEqual(['Older work', 'Migrate users table'])
})

test('a subagent is asked to open its answer with a headline', async ($, on) => {
  let prompt = ''
  on('agent.spawn', (_, e: any) => { prompt = e.prompt; return { model: 'claude-haiku-4-5-20251001', agentId: 'ag1' } as any })
  await $.agent.spawn({ prompt: 'Find stale docs', description: 'Docs audit' } as any).catch(() => {})
  expect(prompt).toMatch(/^Find stale docs\n\nStart your final answer with a one-line headline/)
})

test('activity off leaves a subagent task as written', { options: { activity: false } }, async ($, on) => {
  let prompt = ''
  on('agent.spawn', (_, e: any) => { prompt = e.prompt; return { model: 'claude-haiku-4-5-20251001', agentId: 'ag1' } as any })
  await $.agent.spawn({ prompt: 'Find stale docs', description: 'Docs audit' } as any).catch(() => {})
  expect(prompt).toBe('Find stale docs')
})
