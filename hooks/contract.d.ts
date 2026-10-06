/** What the agent is on right now, coarse to fine; null between turns. */
export type Now = {
  goal?: string // what the turn is for: the slash command or skill, else the prompt cut short
  task?: string // the agent's own in-progress task, when it keeps a list
  step?: string // the tool it is running
}

declare module 'claude-code' {
  interface PluginState {
    'visual-companions': { now: Now | null }
  }
}
