/** What the agent is on, coarse to fine. The goal outlasts the turn; the rest is cleared when it ends. */
export type Now = {
  goal?: string // what the work is for: the slash command or skill, else Haiku's reading of the prompt
  task?: string // the agent's own in-progress task, when it keeps a list
  done?: number // of `total` tasks in that list, finished
  total?: number
  step?: string // the tool it is running
}

declare module 'claude-code' {
  interface PluginState {
    'visual-companions': { now: Now | null }
  }
}
