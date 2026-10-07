# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A Claude Code plugin (a "mod" of function hooks, not shell hooks) that draws the agent's ` ```viz ` blocks as terminal visuals, keeps a headline band with Boo (a ghost companion) above the prompt, and adds a `/catchup` pane. User-facing behaviour is documented in detail in `README.md`; read it before changing behaviour.

## Commands

```
claude --plugin-dir .        # load the plugin from this checkout (hot-reloads in the session)
claude plugin validate .     # check plugin.json / hooks.json
claude plugin test .         # run every *.test.ts(x); no per-test filter, so to run one test temporarily narrow the file
tsc -p . --noEmit            # type-check; needs .claude-plugin/types/, generated the first time the plugin is loaded
bun docs/art/build.ts        # redraw README SVGs (--png for 2× stills, needs Chrome; --big for big Boo into docs/art/big-boo/)
```

There is no package.json or npm toolchain. Imports of `claude-code` and `claude-code/testing` resolve to the engine's types via `.claude-plugin/types/` (gitignored).

## Architecture

`hooks/hooks.json` loads one module, `hooks/register.tsx`, which exports `register(on, options)`. Everything else is pure helpers it imports.

- **`register.tsx`** — the only file that touches the engine (`$`). It handles:
  - `prompt.compose`: injects `GUIDE` into the system prompt. This string is the plugin's whole model-token cost (~250 cached tokens); keep it short and in sync with the parser in `render.ts`. `HEADLINE` is appended to subagent tasks when `activity` is on.
  - `ui.render` for `AssistantMessage` (draws viz fences), `AbovePrompt` (the band, Boo, flock, return card, thrash/collision warnings) and `Pane` (`/catchup`).
  - `prompt.submit`, `tool.call`, `agent.spawn`, `turn.complete`, `session.compact`, `session.start`: bookkeeping. These never block the user: handlers `.catch` to `next(e)`, and band writes go through the serialized `note()` queue off the tool path.
  - Goal naming: a slash command/skill names the goal directly (`goalOf`, `skillGoal`); otherwise a small Haiku call (`nameGoal`) does, and late answers are dropped or backfilled via `regoal`.
- **`render.ts`** — the viz DSL: `parse(src) → Spec`, `draw(spec, cols) → Line[]` (toned segments, no engine), plus living-visual diffing (`changes`) and width helpers (`w`, `cut`, `cutWords`). Adding a form means updating `FORMS`, the parser/drawer here, `GUIDE`, the README table, and the `EXAMPLES` in tests.
- **`land.ts`** — pure "session at a glance" logic: return card, compaction checkpoint (`keepInstructions`), agent lanes, thrash alarm (`spinning`), collision radar (`collisions`, `clashText`).
- **`boo.ts` / `boo-small.ts` / `boo-flock.ts`** — Boo's frames, moods and palettes (big = two pixel rows, small = one braille row) and the per-agent pups.
- **`contract.d.ts`** — types for the plugin's shared `PluginState` (`now`: goal/task/step; `agents`: per-agent notes), referenced as `"types"` in `plugin.json`.

Persistence uses `$.store` with per-session keys `<prefix>:<sessionId>`: `h` visual history, `p` when the user last typed, `d` session's directory, `t` turns, `c` compaction checkpoints, `e` file edit times (read by other sessions for the collision radar). `session.start` deletes other sessions' keys older than the `retention` option.

Options come from `userConfig` in `.claude-plugin/plugin.json` (each is a `/config` row); `register` reads them once and a change reloads the module. A new option needs a `userConfig` entry, handling in `register`, and a row in the README configuration table.

## Conventions

- Pure modules (`render.ts`, `land.ts`, `boo*.ts`) must stay engine-free so tests and `docs/art/build.ts` can share them.
- `register.test.tsx` covers both pure functions and engine behaviour via the `($, on)` test kit (`$.ui.mount`, `ui.find`). Exported helpers in `register.tsx` exist mainly for these tests.
- README images are real `draw()` output; rerun `bun docs/art/build.ts` after changing rendering or Boo.
- Releases: bump `version` in `.claude-plugin/plugin.json` and add a section to the README changelog (users only get updates when the version changes).
- Commit messages use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `perf:`).
