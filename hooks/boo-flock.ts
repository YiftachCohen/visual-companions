// Boo's flock: one pup beside Boo for each agent, so how many are out and how they're
// doing reads without a word. A pup is a 4 × 4 braille ghost, two characters wide; a
// working one flutters its hem, a finished one fades out over a minute.

import type { Look } from './boo'
import { DEFAULT, hue, LOOK, mix, pack } from './boo'

export type PupMood = 'working' | 'success' | 'blocked' | 'neutral'
/** One agent as a pup: how it stands, and how far it has faded towards grey (0..1). */
export type Pup = { mood: PupMood; fade: number }

// # = dot; the eyes are the gap in the second row, the hem flutters between the two.
const FRAMES = [
  ['.##.', '#..#', '####', '#.#.'],
  ['.##.', '#..#', '####', '.#.#'],
]
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] // [row][col] of a braille cell
const GREY = 0x808080
const FLAP = 320 // ms per hem flutter

export const MAX_PUPS = 5
export const GONE = 60_000 // a finished or failed agent's pup fades out over this

const BLANK = [0x20, DEFAULT, DEFAULT]

/** How many cells the flock takes: a gap, then three per pup (two and a gap), then `+N`. */
export const flockWidth = (n: number) => (n ? 1 + Math.min(n, MAX_PUPS) * 3 + (n > MAX_PUPS ? `+${n - MAX_PUPS}`.length : 0) : 0)

/** The flock's cells `t` ms in, on the last of `rows` rows (the rows above blank, beside a two-row Boo). */
export function flockCells(pups: Pup[], t: number, rows = 1, look: Look = LOOK, animate = true): string {
  const row: number[][] = [BLANK]
  pups.slice(0, MAX_PUPS).forEach((p, k) => {
    // Neighbours flutter out of step.
    const frame = FRAMES[p.mood === 'working' && animate ? (Math.floor(t / FLAP) + k) % 2 : 0]
    const color = mix(hue(p.mood, look), GREY, p.fade)
    for (let c = 0; c < 2; c++) {
      let code = 0x2800
      for (let y = 0; y < 4; y++) for (let dx = 0; dx < 2; dx++) if (frame[y][c * 2 + dx] === '#') code |= BIT[y][dx]
      row.push([code, color, DEFAULT])
    }
    row.push(BLANK)
  })
  if (pups.length > MAX_PUPS) for (const ch of `+${pups.length - MAX_PUPS}`) row.push([ch.charCodeAt(0), GREY, DEFAULT])
  return pack([...Array.from({ length: (rows - 1) * row.length }, () => BLANK), ...row])
}

/** How long until a flock with a working pup next changes; Infinity when none flutters. */
export const flockWait = (pups: Pup[], t: number, animate = true) =>
  animate && pups.slice(0, MAX_PUPS).some(p => p.mood === 'working') ? FLAP - (t % FLAP) : Infinity

/** An agent as a pup, from its status and, once it is done, how long ago it answered; undefined once its pup has gone. */
export function pupOf(status: string, ended: number | undefined, now: number): Pup | undefined {
  if (status === 'running' || status === 'pending') return { mood: 'working', fade: 0 }
  if (status === 'waiting' || status === 'idle') return { mood: 'neutral', fade: 0.45 }
  if (ended === undefined) return undefined // no answer heard: nothing says when it finished
  const ago = now - ended
  if (ago >= GONE) return undefined
  const fade = Math.min(0.85, ago / GONE)
  if (status === 'completed') return { mood: 'success', fade }
  if (status === 'failed' || status === 'killed') return { mood: 'blocked', fade: Math.max(0.35, fade) }
  return undefined
}
