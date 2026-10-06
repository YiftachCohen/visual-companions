// Small Boo: the same ghost as 6 × 4 braille dots, three characters on one
// row, in a lane of 8 so it can sway a dot (half a character) at a time.
// Each cell has one dot colour and one background: particles share Boo's
// colour where they share its cell, and the glow is the cells' background.

import type { BooMood, Companion } from './boo'
import { COLOR, DEFAULT, mix, pack } from './boo'

const PANEL = 0x1a1b26 // what trails fade into and the glow tints from
const GOLD = 0xffd479
const WHITE = 0xffffff
const RAIN = 0x7aa2f7
const GREY = 0x808080
const NEUTRAL = 0xa9b1d6 // brighter than big Boo's slate: braille dots are light, so they need the contrast

const W = 16
const H = 4
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] // [row][col] of a braille cell

// 6 × 4, # = dot on; eyes are the gaps
const F: Record<string, string[]> = {
  idle: ['.####.', '#.##.#', '######', '#.##.#'],
  blink: ['.####.', '######', '######', '#.##.#'],
  wiggle: ['.####.', '#.##.#', '######', '##..##'],
  cheer: ['######', '#.##.#', '##..##', '#.##.#'],
  smile: ['.####.', '#.##.#', '##..##', '#.##.#'],
  wink: ['.####.', '#.####', '######', '#.##.#'],
  winkBlink: ['.####.', '######', '######', '#.##.#'],
}

type Step = [frame: string, ms: number]
type Pose = { frame: string; x: number; color: number; dim: number }
type Dot = { x: number; y: number; color: number }

const SWAY = [4, 5, 6, 5, 4, 3, 2, 3]
const STUCK = 660 // relieved: how long Boo shows as it was while blocked

function loop(steps: Step[], t: number) {
  t %= steps.reduce((n, [, ms]) => n + ms, 0)
  for (const [frame, ms] of steps) {
    if (t < ms) return frame
    t -= ms
  }
  return steps[0][0]
}

function pose(m: BooMood, t: number): Pose {
  const still = (frame: string, color: number, dim = 0): Pose => ({ frame, x: 4, color, dim })
  switch (m) {
    case 'working': {
      const i = Math.floor(t / 260) % SWAY.length
      return { frame: i % 2 ? 'wiggle' : 'idle', x: SWAY[i], color: COLOR.working, dim: 0 }
    }
    case 'success':
      if (t < 900) return still(Math.floor(t / 150) % 2 ? 'smile' : 'cheer', COLOR.success)
      return still(loop([['smile', 2800], ['blink', 140]], t - 900), COLOR.success)
    case 'relieved':
      if (t < STUCK) return still(t > 520 ? 'blink' : 'idle', COLOR.blocked, 0.35)
      return pose('success', t - STUCK)
    case 'blocked':
      return still(loop([['idle', 3000], ['blink', 140]], t), COLOR.blocked, t < 400 ? 0.17 : 0.35)
    case 'mixed':
      return still(loop([['wink', 3000], ['winkBlink', 140]], t), COLOR.mixed)
    default:
      return still(loop([['idle', 3200], ['blink', 140]], t), m === 'neutral' ? NEUTRAL : COLOR[m])
  }
}

function particles(m: BooMood, t: number): Dot[] {
  const out: Dot[] = []
  if (m === 'relieved') return t < STUCK ? out : particles('success', t - STUCK)
  if (m === 'working') {
    // a dot shed every 220ms off Boo's trailing edge, drifting away and fading
    for (let k = Math.max(0, Math.floor((t - 1000) / 220)); k <= Math.floor(t / 220); k++) {
      const age = t - k * 220
      if (age < 0 || age > 1000) continue
      const born = pose('working', k * 220).x
      const left = pose('working', k * 220 + 260).x >= born
      const step = Math.floor(age / 160)
      out.push({ x: left ? born - 1 - step : born + 6 + step, y: [1, 3, 2, 0][k % 4], color: mix(COLOR.working, PANEL, (step * 160) / 1000) })
    }
  }
  if (m === 'success' && t < 1600) {
    const at: [number, number, number][] = [[1, 0, 0], [12, 1, 120], [13, 3, 260], [2, 3, 340], [11, 0, 480], [0, 2, 600], [14, 2, 720], [12, 3, 900]]
    for (const [x, y, from] of at) {
      const a = t - from
      if (a >= 0 && a < 520 && Math.floor(a / 130) % 2 === 0) out.push({ x, y, color: a < 260 ? WHITE : GOLD })
    }
  }
  if (m === 'blocked' && t < 2600) {
    for (const [x, from] of [[11, 0], [13, 260], [12, 520], [14, 780], [11, 1040], [13, 1300], [12, 1560], [14, 1820]]) {
      const a = t - from
      if (a >= 0 && a < 600) out.push({ x, y: Math.floor(a / 150), color: RAIN })
    }
  }
  if (m === 'mixed') {
    const a = t % 1800
    for (const [x, y, from] of [[11, 3, 0], [12, 2, 300], [13, 1, 600], [14, 0, 900]]) {
      if (a >= from && a < 1300) out.push({ x, y, color: mix(COLOR.mixed, WHITE, 0.35) })
    }
  }
  return out
}

/** How strongly Boo's cells glow, in fifths so it changes a few times a second at most. */
function glow(m: BooMood, t: number): number {
  if (m === 'relieved') return t < STUCK ? 0 : glow('success', t - STUCK)
  if (m === 'working') return Math.round((0.35 + 0.25 * Math.sin(t / 420)) * 5) / 5
  if (m === 'neutral' || m === 'active') return 0
  return Math.max(0, Math.round((1 - t / 1800) * 5) / 5)
}

/** The 8 cells, `t` ms into a mood, as [codePoint, fg, bg] triplets. */
export function smallCells(m: BooMood, t: number): number[][] {
  const boo = pose(m, t)
  const body = mix(boo.color, GREY, boo.dim)
  const dots: ({ color: number; boo: boolean } | null)[][] = Array.from({ length: H }, () => Array(W).fill(null))
  for (const p of particles(m, t)) if (p.x >= 0 && p.x < W && p.y >= 0 && p.y < H) dots[p.y][p.x] = { color: p.color, boo: false }
  F[boo.frame].forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') dots[y][boo.x + x] = { color: body, boo: true } }))
  const g = glow(m, t)
  const out: number[][] = []
  for (let c = 0; c < W / 2; c++) {
    let code = 0x2800
    let fg: number | null = null
    let mine = false
    for (let y = 0; y < H; y++) {
      for (let dx = 0; dx < 2; dx++) {
        const d = dots[y][c * 2 + dx]
        if (!d) continue
        code |= BIT[y][dx]
        if (fg === null || (d.boo && !mine)) [fg, mine] = [d.color, d.boo]
      }
    }
    const under = c * 2 + 1 >= boo.x && c * 2 <= boo.x + 5
    const bg = g > 0 && under ? mix(PANEL, boo.color, 0.28 * g) : DEFAULT
    out.push(code === 0x2800 ? [0x20, DEFAULT, bg] : [code, fg ?? DEFAULT, bg])
  }
  return out
}

export const small: Companion = { columns: W / 2, rows: 1, draw: (m, t) => pack(smallCells(m, t)) }
