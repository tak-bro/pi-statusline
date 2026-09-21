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
- **tokens · cost** — session totals. Cost comes from the provider's catalog unit
  price as reported by pi — the number is only as accurate as that catalog.

## Layout rule

Everything fits on one row when it fits, else exactly two rows (identity above,
metrics below). It truncates on absurdly narrow terminals — it never wraps.

## Install

Requires the host (`@earendil-works/pi-coding-agent` and `pi-tui`) at runtime;
they are declared as `peerDependencies`.

```sh
pi pm add ./pi-statusline   # or: pi -e /path/to/pi-statusline
```
