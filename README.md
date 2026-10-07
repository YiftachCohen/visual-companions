# visual-companions

A Claude Code plugin that adds a small visual to replies that report a result, a blocker or a decision.

The agent opens such a reply with a short ` ```viz ` block. The plugin draws that block as a framed terminal visual above the prose. A line above the prompt shows what the work is for and where it landed, so you can see the state of a session at a glance when you switch back to it. It leads with any question the agent is waiting on you to answer, and says when another session is waiting on you.

When 10 minutes or more have passed since you last typed and work happened since, the line grows into a return card. The card says how long it has been, how long the agent worked, how many tool calls it made and how many agents finished. It also shows each visual since then as its glyph, the next step, and which files were edited:

```
Fix token refresh → Refresh race fixed, tests green  12m ago
40m since you typed · worked 18m · 45 tool calls · 2 agents finished
✓ ✗ ✓ ✓  since then
→ Need a batching decision first.
✎ 3 files in hooks/auth/
```

While the agent works, the band watches for it going in circles. When one shell command fails three times in a row within 15 minutes, with no success in between, the band leads with `⟳ “npm test” failed 4× in a row · 9m`. It also names the file edited most in that time when it was edited five times or more. Boo turns amber and stops moving. The next success of that command clears it. Heavy editing alone never raises it. A command piped into another (`npm test | tail`) reports the last command's exit code, so its failures may not count.

In the terminal, Boo has a flock: a small ghost beside Boo for each subagent or teammate. A working one flutters its hem, a waiting one is dim, and one that finished turns green (red if it failed) and fades out over the minute after it answered. Past five, the rest show as `+N`.

The band also warns when two sessions edit the same file. If another session edited a file this session edited, both within 30 minutes, the band shows `⚠ register.tsx is also being edited in “Fix login redirect” · 3m ago`, naming the other session by its goal. It warns the same way when two of this session's own agents edit one file within 10 minutes. While the agent works, the warning takes the step's place; when idle, it sits under the band line in amber. Each session shares when it last edited each file in the plugin's store, so files are compared by full path and separate worktrees never clash.

Before a compaction, the plugin asks the summary to keep what the visuals recorded: decisions (★), each goal's open blocker, and questions you haven't answered. Afterwards it leaves a dim line in the transcript (`⟲ Compacted · 112k → 18k tokens · asked to keep 2 decisions, 1 blocker · /catchup`) and a row in `/catchup` that opens as a card.

`/catchup` gives the lay of the land in one pane:

- **Needs you**: questions the agent asked since you last typed.
- **Goals**: each piece of work in the session, where it stands, and its latest headline. An open blocker belongs to its goal and clears when a newer status visual for that goal isn't red.
- **Agents**: each subagent or teammate as a lane on one time scale, from when it started to when it answered (a running one to now), with what it is doing now or what it found:

  ```
                20m ago                      now
  explore-auth  ━━━━━━━━━━━━✓                     Found 3 entry points
  planner            ━━━━━━━━━━━━━━━━━━━━━━━━━━◉  Editing plan.md
  codex-review             ━━━━━━━━━━━✗           auth.spec fails on CI
  ```
- **Other sessions**: other sessions with a visual in the last day, those waiting on you first.
- One visual in full, then the earlier ones, with compactions among them. Press any headline to open it.

```
╭─ Release is blocked at the migrate step  2/4
│
│  ✓ ━━━━━━━━━━ ✓ ━━━━━━━━━━ ✗ ┄┄┄┄┄┄┄┄┄┄ ○
│  build        unit tests   migrate      deploy
│
│  ✗ migrate ·· lock timeout above 10k rows
│
╰─→ Need a batching decision first.
```

## Install

```
/plugin install visual-companions --marketplace YiftachCohen/visual-companions
```

Updates arrive when the version changes. Claude Code doesn't auto-update third-party marketplaces unless you turn it on: open `/plugin`, go to Marketplaces, and enable auto-update for `visual-companions`. Or update by hand with `/plugin marketplace update visual-companions`.

## Cost

The plugin adds a ~250-token guide to the system prompt. It is cached with the rest of the prompt. Each visual the agent writes costs about 50 output tokens. With `activity` on, each subagent's task gets one extra line (~20 tokens) asking it to open its answer with a headline, which `/catchup` shows as what it found. Drawing, the headline line, the return card and `/catchup` run locally and use no model tokens. A compaction's summarizer reads a few more lines: the decisions, blockers and questions it is asked to keep.

## Forms

The first line names the form and states the headline as a claim. A line starting with `>` ends the visual with what to do next or why it matters. Start it with `> ?` when the agent needs your decision or answer to go on: the band and `/catchup` list it under *Needs you* until you type.

A `tradeoff` or `matrix` with a chosen option (`*`) counts as a decision and is marked ★ in the history.

| Form | Use it for | Rows |
| --- | --- | --- |
| `flow` | progress through steps | `+ build`, `x migrate \| note` |
| `path` | where in a system something happens | components in order, same marks as `flow`; drawn as boxes when they fit on one row, else as a list |
| `tree` | causes or a plan | items indented 2 spaces per level |
| `delta` | what changed | `recall: 0.91 -> 0.95 +` |
| `bars` | comparison | `new model: 89 *`, options `@ unit=%; max=100; bar=85` |
| `tradeoff` | a choice on two axes | `self-host: 0.5 0.7 *`, options `@ x=effort saved; y=fidelity` |
| `matrix` | options against several criteria | `postgres: + + ~ *`, options `@ cols=cost, scale, setup` (required) |
| `claims` | what the evidence says, as it changes | `ColBERT fits 50ms p95: 0.5 v !` (confidence 0..1 or %, `^` rising, `v` falling, `!` contested) |

In `flow`, `path` and `tree`, item marks are `+` done, `*` active, `x` blocked, `.` todo, `-` dropped. Keep flow step labels to about 14 characters so the steps fit on one track. Add `| note` to any row to attach a note. A `tree` whose leaves carry marks says how much of it has been explored (✓, ⊘ or ✗) in its title, `3/7 explored`, and each branch with two leaves or more says it beside its label.

```
╭─ New ranking model trades latency for recall
│
│  recall         0.91 ──────▶ 0.95   +4.4%  ▲ better
│  p50 latency   180ms ──────▶ 420ms  ×2.3   ▼ worse
│  cost / 1k     $0.40 ─────── $0.40         = same
│
╰─
```

A fence whose first word is not a known form is left as a normal code block.

```
╭─ ColBERT latency is now contested, and Cohere's case is weaker  v2
│
│  Cross-encoder beats bi-encoder on BEIR  ●●●●○ 0.75
│  ColBERT fits 50ms p95                   ●●●○○  0.5    ⚡ contested
│  Cohere fits cost budget                 ●●○○○  0.3 ▼
│
│  ↻ since v1: 1 new · 1 changed
│  ~ ColBERT fits 50ms p95  0.6 → 0.5 !
│  + Cohere fits cost budget
│
╰─→ Check the hardware behind the 120ms vs 35ms numbers
```

### Living visuals

A visual with `@ id=<name>` is one the agent keeps updating as the work moves: a plan, a hypothesis tree, a board. Each redraw with the same id is a new version. The title shows the version, and a list under the body says what changed since the previous one. Rows are matched by label, or by most of their words when the agent rewords one, so rewording doesn't show as a row removed and another added.

```
╭─ Safari login failure  v4
│
│  ✓ Cookie dropped
│  ╰─ ✓ ITP blocks cross-site API domain
│  ⊘ CORS preflight fails ·········· no preflight sent
│  ⊘ Storage write fails
│
│  ↻ since v3: 3 changed
│  ○ → ✓  Cookie dropped
│  ◉ → ✓  ITP blocks cross-site API domain · confirmed
│  ○ → ⊘  Storage write fails · not needed once toggle fixed it
│
╰─→ Next: find out whether it blocks the auth domain
```

`/catchup` lists a living visual once, by its latest version, and opens it against the version you last saw before you typed, so the list is what you missed.

## Configuration

Every setting is a row in `/config`, and you can also set them when you install the plugin. A change takes effect right away. Values are stored in your settings under `pluginConfigs["visual-companions"]`.

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| `visuals` | on / off | on | Off removes the guide from the system prompt, so the agent stops writing visuals and the plugin uses no model tokens. |
| `band` | on / off | on | The line above the prompt, with Boo: the goal and the latest headline, or an earlier ✗ when no ✓ has followed it, plus its age, how many visuals came in since you last typed, and how many agents are still running. |
| `activity` | on / off | on | The band shows the goal; while the agent works, also its task and progress (`2/5`). The current tool step appears only when there's room (big Boo) or nothing else to show. Off also skips the small Haiku call that names a plain prompt's goal, and stops tagging visuals with goals, noting what subagents do, and asking them for a headline. |
| `history` | 10 / 20 / 50 | 20 | How many visuals `/catchup` keeps per session. It lists the latest 8; *Show all* lists the rest. |
| `retention` | 7 / 30 / 90 | 30 | Days before other sessions' visual history is deleted. |
| `companion` | small / big / off | small | Boo's size: one row of braille, two rows of pixels, or a glyph only. |
| `booAnimation` | animated / still | animated | Still shows one resting pose per mood and runs no timer. |
| `booReactions` | on / off | on | The one-shot reactions: a cheer on green, a fade on red, a hop when a blocked task turns green. Off goes straight to the resting loop. |
| `booEffects` | on / off | on | Small Boo's particles and glow. |
| `booColor` | mood / mono / claude | mood | A colour per outcome, one neutral colour, or Claude orange. |

Example `~/.claude/settings.json` entry:

```json
{
  "pluginConfigs": {
    "visual-companions": { "companion": "big", "booAnimation": "still", "history": "50" }
  }
}
```

## Development

```
claude --plugin-dir .          # load it from a checkout
claude plugin validate .
claude plugin test .
```

Loading the plugin generates `.claude-plugin/types/`, which `tsconfig.json` extends. After that, `tsc -p . --noEmit` type-checks the plugin.

## Changelog

### 0.3.0

- Return card: after 10 minutes away, the band grows into a summary of what happened since you typed.
- Compaction checkpoint: the summary is asked to keep decisions, open blockers and unanswered questions, and the compaction is marked in the transcript and `/catchup`.
- Agent lanes in `/catchup`, and Boo's flock in the band: a pup for each agent.
- Thrash alarm: the band warns when one command keeps failing.
- Collision radar: the band warns when another session or agent edits a file this session edited.
- Living visuals (`@ id=`): a redrawn visual shows its version and what changed.
- The `claims` form, for an evidence board.
- Trees show how much of them has been explored.
- `/catchup` overview: questions waiting on you, goals, agents, other sessions; `> ?` questions; `path` and `matrix` forms.
- Goal naming no longer takes a skill the model loads as the goal, and reads the agent's last reply.

## License

MIT
