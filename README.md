# visual-companions

A Claude Code plugin that adds a small visual to replies that report a result, a blocker or a decision.

The agent opens such a reply with a short ` ```viz ` block. The plugin draws that block as a framed terminal visual above the prose. A line above the prompt shows what the work is for and where it landed, so you can see the state of a session at a glance when you switch back to it. It leads with any question the agent is waiting on you to answer, and says when another session is waiting on you.

`/catchup` gives the lay of the land in one pane:

- **Needs you**: questions the agent asked since you last typed.
- **Goals**: each piece of work in the session, where it stands, and its latest headline. An open blocker belongs to its goal and clears when a newer status visual for that goal isn't red.
- **Agents**: each subagent or teammate, with what it is doing now or what it found.
- **Other sessions**: other sessions with a visual in the last day, those waiting on you first.
- One visual in full, then the earlier ones. Press any headline to open it.

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

## Cost

The plugin adds a ~200-token guide to the system prompt. It is cached with the rest of the prompt. Each visual the agent writes costs about 50 output tokens. Drawing, the headline line and `/catchup` run locally and use no model tokens.

## Forms

The first line names the form and states the headline as a claim. A line starting with `>` ends the visual with what to do next or why it matters. Start it with `> ?` when the agent needs your decision or answer to go on: the band and `/catchup` list it under *Needs you* until you type.

A `tradeoff` or `matrix` with a chosen option (`*`) counts as a decision and is marked ★ in the history.

| Form | Use it for | Rows |
| --- | --- | --- |
| `flow` | progress through steps | `+ build`, `x migrate \| note` |
| `path` | where in a system something happens | components in order, same marks as `flow` |
| `tree` | causes or a plan | items indented 2 spaces per level |
| `delta` | what changed | `recall: 0.91 -> 0.95 +` |
| `bars` | comparison | `new model: 89 *`, options `@ unit=%; max=100; bar=85` |
| `tradeoff` | a choice on two axes | `self-host: 0.5 0.7 *`, options `@ x=effort saved; y=fidelity` |
| `matrix` | options against several criteria | `postgres: + + ~ *`, options `@ cols=cost, scale, setup` |

In `flow`, `path` and `tree`, item marks are `+` done, `*` active, `x` blocked, `.` todo, `-` dropped. Keep flow step labels to about 14 characters so the steps fit on one track. Add `| note` to any row to attach a note.

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

## Configuration

Every setting is a row in `/config`, and you can also set them when you install the plugin. A change takes effect right away. Values are stored in your settings under `pluginConfigs["visual-companions"]`.

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| `visuals` | on / off | on | Off removes the guide from the system prompt, so the agent stops writing visuals and the plugin uses no model tokens. |
| `band` | on / off | on | The line above the prompt, with Boo: the goal and the latest headline, or an earlier ✗ when no ✓ has followed it, plus its age, how many visuals came in since you last typed, and how many agents are still running. |
| `activity` | on / off | on | The band shows the goal; while the agent works, also its task and progress (`2/5`). The current tool step appears only when there's room (big Boo) or nothing else to show. Off also skips the small Haiku call that names a plain prompt's goal, and stops tagging visuals with goals and noting what subagents do. |
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

## License

MIT
