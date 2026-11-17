# awaiting

A local-first desktop companion for Claude Code. While an agent run is in progress, awaiting:

- **Predicts how long the run will take**, always shown as a range (p50–p90).
- **Suggests a task from the user's own list** that fits the expected wait.
- **Shows an animated avatar** that reacts to what the agent is doing.
- **Calls the user back** when the agent needs input or finishes.
- **Shows a welcome-back recap** of what happened while they were away.
- **Tracks stats** on time reclaimed.

Everything runs on the user's machine. Nothing leaves it.

## Stack

TypeScript, Node 20+, pnpm workspaces.

```
apps/desktop/          Electron + React + Vite
                       main process: local HTTP server, SQLite (better-sqlite3), ETA engine
                       renderer: React UI (ETA range, task suggestion, avatar, recap, stats)
packages/core/         Pure logic (ETA model, task fitting, event → state mapping, stats). Vitest.
packages/cli/          `awaiting install | uninstall | doctor` — manages ~/.claude/settings.json
hooks/awaiting-hook.js  Dependency-free script that POSTs each hook event to the local server
docs/plans/            One plan per milestone, written before coding
```

Data flow: Claude Code fires a hook → `awaiting-hook.js` POSTs the event JSON to the local server → main process stores it in SQLite and updates the ETA engine → renderer gets the new state.

### Where code goes

- `packages/core` has no I/O: no `fs`, no network, no Electron, no SQLite. Pass time in (for example as a `now` argument) so tests are deterministic. If logic can live here, put it here.
- `apps/desktop` main process wires core logic to I/O (HTTP, DB, notifications). Keep it thin.
- `hooks/awaiting-hook.js` is plain Node JS with **zero dependencies** and no build step. It must run as-is with whatever `node` is on the user's PATH.

## Hard rules

These are non-negotiable. If a task seems to need breaking one, stop and ask.

1. **The hook must never slow down or break Claude Code.**
   - Always exit 0, including on error, a timeout, a missing server or bad input.
   - The whole request has a ~500 ms timeout. Abort and exit when it is hit.
   - Write **nothing** to stdout. For some hook events Claude Code reads stdout as control output. Don't log to stderr in normal operation either.
   - Wrap everything in try/catch. No unhandled rejections.
2. **Privacy.**
   - The server binds to `127.0.0.1` only. Never `0.0.0.0`, `localhost` or `::`.
   - No telemetry, analytics, crash reporting or other outbound network calls.
   - Don't store raw prompt text by default. Store derived features instead (length, counts, tool names, timings). Storing raw text is opt-in only and needs an explicit setting.
3. **The installer is safe and reversible.**
   - Back up `~/.claude/settings.json` with a timestamp before every write.
   - Merge our hook entries in. Never clobber or reorder the user's existing hooks or other settings.
   - Mark our entries so they can be identified reliably (for example by the hook script path).
   - `uninstall` removes **only** our entries and leaves everything else byte-for-byte equivalent in meaning.
   - Running `install` twice must be idempotent: no duplicate entries.
   - If settings.json is malformed, abort without writing.
   - `doctor` checks the install, the server's reachability and the Node version, and reports. It never mutates anything.
4. **Never guess Claude Code hook names or payloads.** Verify every hook event name, settings.json schema, payload field and exit-code/stdout behavior against https://code.claude.com/docs/en/hooks before using it. Cite the doc section in the milestone plan. If the docs don't cover something, say so rather than assume.
5. **Estimates are always ranges.** Never show a single-number ETA in the UI, notifications or recap. Show p50 and p90 (for example "4–9 min"). When there is little data, show a wide range and say the estimate is low-confidence. Don't fake precision.

## Workflow

- **One milestone at a time.** Don't start the next one until the current one is done and verified.
- **Plan before code.** Write `docs/plans/NN-<milestone-slug>.md` before implementing. Include the goal, scope and non-goals, the files touched, the hook docs referenced (rule 4), the test plan and open questions. Get agreement on the plan before coding.
- **Tests for everything in `packages/core`.** Use Vitest. New logic comes with tests, and bug fixes come with a regression test.
- **Test the risky edges too**, even outside core:
  - the hook: exits 0 with no stdout when the server is down, slow or returns an error
  - the installer: merge, idempotency, uninstall, malformed settings, run against fixture settings files and never the real `~/.claude`
- **Definition of done:** `pnpm test` and `pnpm lint` both pass. Run them and report the actual result before saying a task is done. If either fails, say so and show the output.

## Commands

```sh
pnpm install
pnpm test     # all workspace tests
pnpm lint     # all workspace lint/typecheck
pnpm --filter @awaiting/core test       # core only (adjust to actual package name)
pnpm --filter desktop dev               # run the desktop app (adjust to actual script)
```

Update this section once the scripts exist.

## Conventions

- TypeScript `strict` mode everywhere except the hook script, which is plain JS.
- Times are stored as epoch milliseconds (UTC) and formatted only in the UI.
- Durations in the UI are human-readable ranges, never raw milliseconds.
- Don't touch the real `~/.claude/settings.json` during development or tests. Use a configurable path or a temp directory.
