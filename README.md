# visual-companions

A Claude Code plugin that adds a small visual to replies that report a result, a blocker or a decision.

The agent opens such a reply with a short ` ```viz ` block. The plugin draws that block as a framed terminal visual above the prose. The latest headline stays on a line above the prompt, and `/catchup` lists the visuals from this session.

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

The first line names the form and states the headline as a claim. A line starting with `>` ends the visual with what to do next or why it matters.

| Form | Use it for | Rows |
| --- | --- | --- |
| `flow` | progress through steps | `+ build`, `x migrate \| note` |
| `tree` | causes or a plan | items indented 2 spaces per level |
| `delta` | what changed | `recall: 0.91 -> 0.95 +` |
| `bars` | comparison | `new model: 89 *`, options `@ unit=%; max=100; bar=85` |
| `tradeoff` | a choice on two axes | `self-host: 0.5 0.7 *`, options `@ x=effort saved; y=fidelity` |

In `flow` and `tree`, item marks are `+` done, `*` active, `x` blocked, `.` todo, `-` dropped. Keep flow step labels to about 14 characters so the steps fit on one track. Add `| note` to any row to attach a note.

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

## Development

```
claude --plugin-dir .          # load it from a checkout
claude plugin validate .
claude plugin test .
```

Loading the plugin generates `.claude-plugin/types/`, which `tsconfig.json` extends. After that, `tsc -p . --noEmit` type-checks the plugin.

## License

MIT
