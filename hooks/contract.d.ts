/** What the agent is on, coarse to fine. The goal outlasts the turn; the rest is cleared when it ends. */
export type Now = {
  goal?: string // what the work is for: the slash command or skill, else Haiku's reading of the prompt
  task?: string // the agent's own in-progress task, when it keeps a list
  done?: number // of `total` tasks in that list, finished
  total?: number
  step?: string // the tool it is running
}

/** What each subagent or teammate was last seen doing, by its `$.agent.list()` id. */
export type AgentNote = {
  at: number // when it was last heard from
  step?: string // its latest tool call, as a few words
  result?: string // the first line of its answer, once it has answered
  start?: number // when it was spawned, or first heard from
  end?: number // when it last answered
}

declare module 'claude-code' {
  interface PluginState {
    'visual-companions': { now: Now | null; agents: Record<string, AgentNote> | null }
  }
}
