# pi-statusline — Implementation Plan

A pi footer extension that reproduces [tak-cc-statusline](https://github.com/tak-bro/tak-cc-statusline)'s
look inside pi, working across every provider pi supports.

Target host: `@earendil-works/pi-coding-agent` (installed at
`~/.nvm/versions/node/v24.20.0/lib/node_modules/@earendil-works/pi-coding-agent`, referred to
below as `$PI`). Every API fact in this plan was read from that installation — do not re-derive.

## Goal

```
glm-5.3-flash · high | pi-statusline • main | █░░░░░░░░░ 7% | $0.042 • ↑12.4k ↓1.1k
```

Same palette, same separators, same narrow-terminal two-row split as tak-cc-statusline.

**The available credentials are cursor and z.ai only.** Everything in this plan must be
verifiable with those two providers. That is why the Anthropic 5h/7d rate-limit segment —
tak-cc-statusline's headline feature — is explicitly **deferred**, not built here (see
"Deferred"). Building an unverifiable network path into v1 would mean shipping a code path
nobody in this project can exercise.

## Why not reuse an existing extension

`@pi-vault/pi-status`, `pi-powerline-footer`, and `pi-mono-status-line` already cover this
functional ground. This package exists for the visual identity, not for missing features.
Do not add a segment-configuration system, presets, or a settings dashboard — those are what
the existing extensions are for, and adding them makes this a worse copy of them.

## Verified host API

| Need | API | Evidence |
|---|---|---|
| Replace the footer | `ctx.ui.setFooter(factory)`; factory returns a `Component` | `$PI/dist/core/extensions/types.d.ts:108` |
| Multi-row output | `Component.render(width: number): string[]` — one array entry per line | `$PI/node_modules/@earendil-works/pi-tui/dist/tui.d.ts:74` |
| Git branch | `footerData.getGitBranch(): string \| null` (`"detached"` on detached HEAD), `footerData.onBranchChange(cb)` returns an unsubscribe | `$PI/dist/core/footer-data-provider.d.ts:36` |
| Context window | `ctx.getContextUsage(): { tokens: number \| null; contextWindow: number; percent: number \| null } \| undefined` | `$PI/dist/core/extensions/types.d.ts:194-200` |
| Model | `ctx.model` → `{ id, name, provider, ... }` | `$PI/node_modules/@earendil-works/pi-ai/dist/types.d.ts:785-789` |
| Effort | `ctx.thinkingLevel?: ThinkingLevel` | `$PI/dist/core/extensions/types.d.ts:231` |
| Tokens + cost | iterate `ctx.sessionManager.getBranch()`; assistant entries carry `message.usage.{input,output,cost.total}` | `$PI/examples/extensions/custom-footer.ts` |
| Model change | `pi.on("model_select", (event, ctx) => ...)`, `event.model.provider` / `event.model.id` / `event.source` | `$PI/examples/extensions/model-status.ts` |
| Width helpers | `import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"` | `$PI/node_modules/@earendil-works/pi-tui/dist/index.d.ts:32` |

`ctx.getContextUsage()` returns `percent: null` right after compaction, before the next LLM
response — render the bar as empty in that case rather than hiding the segment (hiding it
would make the footer jump).

pi's `Theme` exposes only a fixed named palette (`accent`, `dim`, `success`, ...) with no
arbitrary hex — `$PI/dist/modes/interactive/theme/theme.d.ts:14`. The colors therefore come
from raw truecolor SGR in `render.ts`, not from `theme.fg()`.

## Layout

Two logical groups, matching tak-cc-statusline:

- **identity** — `model · effort` `|` `dir • branch`
- **metrics** — `bar pct%` `|` `$cost • ↑in ↓out`

One row when `visibleWidth(identity) + SEP_W + visibleWidth(metrics) <= width`, otherwise two
rows (identity first). Truncate each rendered row with `truncateToWidth(row, width)` so a very
narrow terminal degrades instead of wrapping.

Separators and palette are already defined in `extensions/lib/render.ts`: `SEP` (` | `),
`DOT` (` • `), `BAR_WIDTH = 10`, `SEP_W = 3`, and the 50/75/90 color ramp.

## Cost and token segment

Summed from `ctx.sessionManager.getBranch()`: assistant entries carry
`message.usage.{input, output, cost.total}`. pi ships per-model `cost` metadata
(per-million-token rates, with tiers) in its model catalog, so this is provider-agnostic —
no provider-specific endpoint is involved anywhere in v1.

**Verify per provider, do not assume.** A provider whose catalog entry has zero rates reports
`cost.total === 0`. If z.ai or cursor does that, render tokens only and drop the `$` segment
rather than showing a permanent `$0.000`. Decide this from what the two providers actually
report — it is the first thing to check once the footer renders.

## Re-render wiring

The factory signature is `(tui, theme, footerData)`, but event handlers receive only
`(event, ctx)` — **there is no `tui` on `ctx`**. So the factory must stash its `tui` in a
module-scoped variable, and the `turn_end` / `model_select` handlers call
`tui?.requestRender()` through it. Clear that variable in `dispose`, or a handler firing after
teardown renders into a dead TUI.

`onBranchChange` is the one signal that arrives on its own; subscribe in the factory and return
its unsubscribe as `dispose`.

## Performance

`ctx.sessionManager.getBranch()` returns the whole branch, and `render()` runs on every TUI
repaint. Summing thousands of entries per repaint is the one real cost in this extension —
`$PI/examples/extensions/custom-footer.ts` does exactly that, but it is an example, not a
budget. Keep a module-scoped `{ input, output, cost, entriesSeen }` accumulator, recompute only
at `turn_end`, and have `render()` read the cached numbers. `render()` must stay pure string
assembly.

## Files

```
pi-statusline/
  package.json          { "pi": { "extensions": ["./extensions"] } }
  README.md
  extensions/
    statusline.ts       setFooter registration, re-render wiring, segment assembly
    lib/
      render.ts         palette, bar, formatters, row helpers   [WRITTEN]
      render.test.ts    bun test for the pure helpers
      layout.ts         pure: segment strings -> rows (one-row / two-row decision)
      layout.test.ts
```

`render.ts` is already written. Everything else is to do.

**No build step.** pi loads extensions through [jiti](https://github.com/unjs/jiti), so the
`.ts` files ship and run as-is (`$PI/docs/extensions.md:179`). Do not add a bundler, a `dist/`,
or a `prepublish` compile.

**Dependencies.** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are bundled by
the host and MUST go in `peerDependencies` with a `"*"` range — never in `dependencies` or
`devDependencies` (`$PI/docs/packages.md`, "Dependencies"). pi installs packages with
`npm install --omit=dev`, so anything in `devDependencies` is absent at runtime. v1 needs no
runtime dependency beyond those two.

## Steps

1. `package.json`: the `pi` key, the two `peerDependencies` above, `name: "pi-statusline"`,
   a `files` allowlist (`extensions/`, `README.md`) so the tarball carries no tests, and
   `license`/`repository`/`author` mirroring `tak-cc-statusline/package.json`.
2. `layout.ts`: takes the already-colored segment strings and a width, returns `string[]`.
   All the packing logic lives here so it is testable without a TUI.
3. `statusline.ts`: `setFooter` factory, the re-render wiring above, segment assembly from
   `ctx.model`, `ctx.thinkingLevel`, `ctx.getContextUsage()`, `footerData.getGitBranch()`, and
   the cached token/cost accumulator.
4. `render.test.ts`: `buildBar` clamping and the one-cell-minimum rule, `pickColor` at the
   49/50/74/75/89/90 boundaries, `fmtTokens`, `fmtUntil` (past timestamp → `""`).
5. `layout.test.ts`: one row at exactly the threshold width, two rows one cell below it,
   truncation at an absurdly narrow width, and every segment-absent combination (no branch,
   no effort, `percent: null`) producing no doubled or trailing separator.
6. README: what it shows, that cost figures depend on the provider's catalog rates, and the
   "pick one footer extension" warning (pi's docs note two footer extensions must not both be
   enabled).

## Verification

Run against **z.ai first, then cursor** — those are the two providers with credentials.

- `bun test extensions/lib/` green.
- `pi -e /Users/tak/workspace/tak-bro/pi-statusline` in a git repo renders the footer:
  model, cwd, branch, context bar.
- Send one prompt, wait for the turn to end → the bar and the cost/token figures have moved.
  (They update at `turn_end`, not during streaming — do not expect mid-turn motion.)
- Confirm `cost.total` is non-zero on z.ai and on cursor. If either reports `0`, apply the
  tokens-only fallback from "Cost and token segment" and note which provider in the README.
- `git switch -c tmp` in another shell → the branch segment updates with no keystroke.
- `/compact` → the bar renders empty (`percent: null`) and the footer neither jumps nor drops
  the segment.
- Resize below the one-row threshold → two rows, no wrap, no lost segments.
- `/model` between a z.ai and a cursor model → the model segment updates immediately.
- Run in a non-git directory → branch segment absent, everything else renders.

## Deferred

**Anthropic 5h/7d and per-model weekly limits.** This is tak-cc-statusline's differentiator and
the reason the port was interesting, but it cannot be verified here: there is no Anthropic
credential in this setup, and whether a pi session even stores a usable subscription token —
and under what key in `~/.pi/agent/auth.json` — is **UNVERIFIED** (this session was blocked
from reading that file). Shipping it would mean shipping an untested network path, an untested
token lookup, and an untested cache.

When an Anthropic credential exists, the port is: `tak-cc-statusline/scripts/fetch-usage.sh`
(164 lines) → TypeScript, gated on `ctx.model?.provider === "anthropic"`, falling back to the
cost segment when no token is found. Keep endpoint `https://api.anthropic.com/oauth/usage`,
headers `anthropic-beta: oauth-2025-04-20` + `authorization: Bearer <token>`, fields
`.five_hour.utilization` / `.seven_day.utilization` / `.*.resets_at` / `.limits[]` where
`kind == "weekly_scoped"`, a 60s TTL and a 3s `AbortSignal.timeout`. **Drop** the script's
cache file, `mkdir` lock, and stale-lock recovery — those exist because Claude Code re-executes
the script every render; a resident extension needs only a module variable and one in-flight
`Promise`. Never log the token: `console.log` in an extension goes to pi's debug output.

## Out of scope

Segment configuration, presets, sidebar, a `/statusline` command, notifications, currency
conversion. If one of those is wanted later it is a separate decision, not part of this build.

## Release

Manual, mirroring `tak-cc-statusline`: no CI workflow exists there, `npm publish` is run by
hand. Publish only after the verification list passes on both z.ai and cursor.
