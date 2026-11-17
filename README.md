# awaiting

A local-first desktop companion for Claude Code. While an agent run is in progress, awaiting predicts how long it will take (always as a range), suggests a task from your own list that fits the wait, shows an avatar that reacts to what the agent is doing, calls you back when it needs you, and recaps what happened while you were away.

Everything runs on your machine. Nothing leaves it.

> Status: in development. See `docs/SPEC.md` for milestones and `docs/PROGRESS.md` for progress.

## Features

- [x] M0: Monorepo scaffold, Electron app with main and avatar windows, CI on Windows/macOS/Linux
- [x] M1: Hook pipeline (`awaiting install | uninstall | doctor`, local event server, live debug view)
- [ ] M2: Wait estimate (p50–p90 range, live updates, calibration)
- [ ] M3: Avatar (state animations, helper characters, speech bubble)
- [ ] M4: Awaiting list (task picker, callbacks when the agent needs you)
- [ ] M5: Welcome-back recap and stats (shareable card)
- [ ] M6: Packaging and launch (installers, docs)

## Development

Requires Node 22 (>= 22.12) and pnpm (run `corepack enable` once).

```sh
pnpm install
pnpm dev     # run the desktop app
pnpm test
pnpm lint
```

See `CLAUDE.md` for the full command list and project rules.
