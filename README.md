# pi-statusline

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that replaces
the built-in footer with the [tak-cc-statusline](https://github.com/tak-bro/tak-cc-statusline)
look. One footer extension can be active at a time — remove others (or run `pi -ne`)
if the footer doesn't change.

## What you see

```
GLM-5.3 · high | proj • feat/x
█████░░░░░ 50% | 1.2k · $0.50
```

- **model · effort** — current model and thinking level (`off`/absent is omitted)
- **dir • branch** — working directory basename and git branch (matches statusline.sh)
- **context bar** — 10 cells of context-window usage; empty right after compaction
  until the next reply reports usage
- **ZAI quota** — Z.ai coding-plan remaining quota (5h / weekly windows) with reset
  countdown, shown when `ZAI_API_KEY` is set. Uses an unofficial endpoint; hidden
  when the key is missing or the request fails.
- **tokens · cost** — session totals. Tokens are every billed token — input, output,
  and cache reads and writes — so the count and the dollar figure cover the same thing;
  on a cache-heavy provider an input-only count would read an order of magnitude low.
  Cost comes from the provider's catalog unit price as reported by pi, so the number is
  only as accurate as that catalog. A provider whose catalog carries no rates reports
  zero, and the segment then shows tokens alone rather than a permanent `$0.00`.

## Layout rule

Everything fits on one row when it fits, else exactly two rows (identity above,
metrics below). It truncates on absurdly narrow terminals — it never wraps.

## Install

Requires the host (`@earendil-works/pi-coding-agent` and `pi-tui`) at runtime;
they are declared as `peerDependencies`.

```sh
pi install ./pi-statusline   # or, to try it for one run: pi -e /path/to/pi-statusline
```
