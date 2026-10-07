// Boo: the ghost drawn beside the headline above the prompt. 6 × 4 pixels,
// packed two to a terminal cell with half-blocks, so 6 columns × 2 rows.

import type { Spec } from './render'
import { mood } from './render'

export type BooMood = 'neutral' | 'active' | 'working' | 'success' | 'blocked' | 'mixed' | 'relieved'

export const COLUMNS = 6
export const ROWS = 2

// b body, s shade, e eye, . empty
const swap = (rows: string[], i: number, row: string) => rows.map((r, n) => (n === i ? row : r))
const idle = ['.bbbb.', 'bebbeb', 'bbbbbb', 'b.bb.b']
const smile = swap(idle, 2, 'bbeebb')
const low = ['.bbbb.', 'bebbeb', 'bbssbb', 'b.bb.b']
const wary = swap(idle, 1, 'bebbsb')

export const FRAMES: Record<string, string[]> = {
  idle,
  blink: swap(idle, 1, 'bbbbbb'),
  driftL: ['.bbbb.', 'ebbebb', 'bbbbbb', 'bb..bb'],
  driftR: ['.bbbb.', 'bbebbe', 'bbbbbb', 'bb..bb'],
  cheer: ['bbbbbb', 'bebbeb', 'bbeebb', 'b.bb.b'],
  smile,
  smileBlink: swap(smile, 1, 'bbbbbb'),
  fading: idle,
  low,
  lowBlink: swap(low, 1, 'bbbbbb'),
  wary,
  waryBlink: swap(wary, 1, 'bbbbbb'),
  // Relief: Boo starts as it was while blocked, then hops up a pixel.
  stuck: low,
  stuckBlink: swap(low, 1, 'bbbbbb'),
  hop: ['bebbeb', 'bbeebb', 'b.bb.b', '......'],
}

// How far each frame fades towards grey: Boo goes see-through when blocked.
const FADE: Record<string, number> = { fading: 0.15, low: 0.3, lowBlink: 0.3, stuck: 0.3, stuckBlink: 0.3 }

type Step = [frame: string, ms: number]
const IDLE: Step[] = [['idle', 3200], ['blink', 140]]

/** A reaction played once when the mood starts, then a loop held after it. */
const MOODS: Record<BooMood, { intro?: Step[]; loop: Step[] }> = {
  neutral: { loop: IDLE },
  active: { loop: IDLE },
  working: { loop: [['idle', 300], ['driftL', 420], ['idle', 300], ['driftR', 420]] },
  success: { intro: [['cheer', 180], ['smile', 160], ['cheer', 180], ['smile', 160], ['cheer', 220]], loop: [['smile', 2800], ['smileBlink', 140]] },
  blocked: { intro: [['fading', 260]], loop: [['low', 3000], ['lowBlink', 140]] },
  mixed: { loop: [['wary', 3000], ['waryBlink', 140]] },
  // Green after a block: the old low pose in the old colour, a blink, then two hops.
  relieved: {
    intro: [['stuck', 520], ['stuckBlink', 140], ['idle', 160], ['hop', 170], ['cheer', 190], ['hop', 170], ['cheer', 260]],
    loop: [['smile', 2800], ['smileBlink', 140]],
  },
}

export const COLOR: Record<BooMood, number> = {
  neutral: 0x737aa2,
  active: 0xe0af68,
  working: 0xe0af68,
  success: 0x9ece6a,
  blocked: 0xf7768e,
  mixed: 0xbb9af7,
  relieved: 0x9ece6a,
}

// Frames drawn in the blocked colour whatever mood plays them.
const TINT = new Set(['stuck', 'stuckBlink'])

/** How Boo is painted, from the plugin's options: its palette, and whether small Boo's particles and glow show. */
export type Look = { palette: 'mood' | 'mono' | 'claude'; effects: boolean }
export const LOOK: Look = { palette: 'mood', effects: true }
const CLAUDE = 0xd97757

/** A mood's colour under `look`: its own, one `neutral` for all, or Claude's orange. */
export const hue = (m: BooMood, look: Look, neutral = COLOR.neutral) =>
  look.palette === 'mood' ? COLOR[m] : look.palette === 'mono' ? neutral : CLAUDE

/** Boo's mood for a stored visual, read off the same state as its glyph. */
export function booMood(spec: Spec): BooMood {
  const { glyph, tone } = mood(spec)
  if (glyph === '✗') return 'blocked'
  if (glyph === '✓') return 'success'
  if (glyph === '◉') return 'active'
  return tone === 'warn' ? 'mixed' : 'neutral'
}

/** The frame shown `t` ms into a mood, and how long until the next one. */
export function frameAt(m: BooMood, t: number): { frame: string; wait: number } {
  const { intro = [], loop } = MOODS[m]
  for (const [frame, ms] of intro) {
    if (t < ms) return { frame, wait: ms - t }
    t -= ms
  }
  t %= loop.reduce((n, [, ms]) => n + ms, 0)
  for (const [frame, ms] of loop) {
    if (t < ms) return { frame, wait: ms - t }
    t -= ms
  }
  return { frame: loop[0][0], wait: loop[0][1] }
}

export const mix = (c: number, to: number, k: number) => {
  const ch = (s: number) => Math.round(((c >> s) & 255) * (1 - k) + ((to >> s) & 255) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export const DEFAULT = 0x01000000 // the terminal's own colour
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄

/** A frame as Raster cells: base64 of [codePoint, fg, bg] per cell, row-major. */
export function cells(frame: string, color: number, blocked = COLOR.blocked): string {
  const fade = FADE[frame] ?? 0
  const body = mix(TINT.has(frame) ? blocked : color, 0x808080, fade)
  const paint: Record<string, number> = {
    b: body,
    s: mix(body, 0x000000, 0.38),
    e: 0x16161e,
  }
  const rows = FRAMES[frame]
  const out = new Uint32Array(COLUMNS * ROWS * 3)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      const top = paint[rows[y * 2][x]]
      const bottom = paint[rows[y * 2 + 1][x]]
      const i = (y * COLUMNS + x) * 3
      if (top !== undefined) out.set([UPPER, top, bottom ?? DEFAULT], i)
      else if (bottom !== undefined) out.set([LOWER, bottom, DEFAULT], i)
      else out.set([0x20, DEFAULT, DEFAULT], i)
    }
  }
  return base64(new Uint8Array(out.buffer))
}

/** Cells given as [codePoint, fg, bg] triplets, encoded for a Raster. */
export function pack(triplets: number[][]): string {
  return base64(new Uint8Array(Uint32Array.from(triplets.flat()).buffer))
}

/** A companion the band can draw: its size, its cells `t` ms into a mood, and
 *  `settle(m)`, the ms its one-shot reaction to `m` lasts (0 for none). */
export type Companion = { columns: number; rows: number; settle: (m: BooMood) => number; draw: (m: BooMood, t: number, look?: Look) => string }

export const big: Companion = {
  columns: COLUMNS,
  rows: ROWS,
  settle: m => (MOODS[m].intro ?? []).reduce((n, [, ms]) => n + ms, 0),
  draw: (m, t, look = LOOK) => cells(frameAt(m, t).frame, hue(m, look), hue('blocked', look)),
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    s += B64[n >> 18] + B64[(n >> 12) & 63]
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    s += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return s
}
