# awaiting: progress

Resume rule: after a restart or compaction, re-read `CLAUDE.md`, `docs/SPEC.md` and this file, then continue from the first unchecked item.

Run mode (from Levin, 2026-11-16): M1–M6 run back to back with pre-approved plans. Open questions get the safest reversible default, logged below. Each milestone follows: plan → delegate → integrate → lint+test → reviewer (max 3 rounds) → terminal verification → commit + push → update this file and the README.

Environment notes:
- Windows 11 x64, Node 22.16. `pnpm` is not on PATH: use `corepack pnpm`, or temporary corepack shims (`corepack enable --install-directory <tmp> pnpm`) when scripts call `pnpm` directly.
- `gh` is not logged in. CI status is read from the public API: `curl -s https://api.github.com/repos/Levvvinnn/awaiting/actions/runs?per_page=3`.
- Never touch the real `~/.claude/settings.json`. Use a temp HOME or fixtures only.
- Ignore errors from the unrelated "impeccable" hook.

## Milestones

- [x] **M0 Scaffold**: plan `docs/plans/00-scaffold.md`. Commit `3246ac4`. CI run 44028985977 green on windows/macos/ubuntu.
- [ ] **M1 Hook pipeline**
  - [x] plan: `docs/plans/01-hook-pipeline.md`
  - [x] T0: lint rules, guard cases, CI hook-compat job, root `awaiting` script
  - [x] T1: core contracts (128 tests)
  - [x] T4: hook script, 38 node:test cases; deadline lowered to 300 ms
  - [x] T6+T7: SQLite store and debug view (desktop 116 tests, smoke:app ok)
  - [x] T2+T3: core parse, sanitize, turn machine, reorder (core 693 tests)
  - [x] T5: CLI install/uninstall/doctor (cli 119 tests, round trip through the real hook)
  - [x] T9: ingestor (22 tests: replay, reorder, restart, sweep)
  - [x] T8: loopback server (79 tests; real-hook contract test)
  - [x] T10: app wiring, batched debug IPC, smoke:app sends real hook events (done/stop)
  - [x] T11: H3 privacy e2e (sentinel absent in all files, all encodings) + pipeline e2e
  - [x] core: `effort` read as an object with `level` (per the docs); hook strips a leading BOM
  - [x] T12: integrate, CLAUDE.md Commands, SPEC fixes (plan §10)
  - [x] lint+test: lint ok; core 711, hooks 39, desktop 234 (+1 POSIX-only skip), cli 119; smoke:app ok
  - [x] review round 1: PASS, no blocking issues. Fixed: parallel tool-interrupt reopen (core), hook `received_at` taken from process start
  - [x] verify (terminal): every automated acceptance criterion is met (reviewer + tests; core is now 714). The real-session check is manual: see "Needs manual check" M1-1
  - [ ] commit+push
  - [ ] CI green
- [ ] **M2 Wait estimate**
- [ ] **M3 Avatar**
- [ ] **M4 Awaiting list**
- [ ] **M5 Recap and stats**
- [ ] **M6 Packaging and launch**

## Decisions for Levin

Safest reversible defaults picked during the run. Each can be changed later.

| # | Milestone | Question | Default chosen | Why / how to reverse |
|---|---|---|---|---|
| D0.1 | M0 | Node version for dev/CI | Node 22 (>= 22.12) | Node 20 is EOL; current better-sqlite3/Vitest need 22. Change `.nvmrc`, `engines`, ci.yml |
| D0.2 | M0 | better-sqlite3 native build | N-API prebuilds, `ignoredBuiltDependencies` | No toolchain needed. Fallback `pnpm --filter desktop rebuild:native` |
| D0.3 | M0 | Prettier scope | Skips `**/*.md` and `.claude/` | User-authored docs aren't reformatted. Remove the lines from `.prettierignore` |
| D1.1 | M1 | Min Claude Code version | ≥ 2.1.290, not enforced; the manual check records the version tested | The docs give no version for `async`/`args`. Change `MIN_CLAUDE_CODE` |
| D1.2 | M1 | async vs. sync hooks | async on 11 events; sync for Stop/StopFailure (timeout 2 s) and SessionEnd (1 s) | No added latency; turn-end events survive `-p` exit. Edit `desired()`, re-run install |
| D1.3 | M1 | Exec vs. shell form | Exec form (`command: node`, `args: [path]`); `--shell-form` escape hatch | Avoids Windows quoting and the no-Git-Bash blocking rule |
| D1.4 | M1 | Data dir | `~/.awaiting` (`AWAITING_HOME` override) | Hook and CLI find it without Electron. Change `resolveDataDir` |
| D1.5 | M1 | Server port | Ephemeral 127.0.0.1:0, written to `server.json`; no fallback port | No collisions |
| D1.6 | M1 | Token | Required, 256-bit, new on every app start | Blocks injection from other local processes and browsers |
| D1.7 | M1 | Hook path in settings | Copy to `~/.awaiting/hook/`; `--hook-path` for dev; uninstall keeps the copy unless `--purge` | Survives moving the repo or app |
| D1.8 | M1 | Identifying our entries | Script basename `awaiting-hook.js`, no custom keys | Also catches older installs |
| D1.9 | M1 | Dropping empty groups/arrays on uninstall | Only groups/arrays emptied by our removal | Equal in meaning, no state file |
| D1.10–11 | M1 | Missing settings file; backups | Create it without a backup; `settings.json.awaiting-backup-<UTC stamp>`, kept forever | Never deletes user data |
| D1.12 | M1 | CLI bin | Vite SSR bundle to `packages/cli/dist/awaiting.cjs`, run as `pnpm awaiting` | No runtime dependency |
| D1.13–14 | M1 | Hook Node floor and time budget | Node ≥ 20, ES2022, `node:test`; **300 ms hard exit, 250 ms request timeout** (lowered from the plan's 400/350: measured 495–566 ms vs. the 600 ms limit; now ~390–410 ms) | CI `hook-compat` job on Node 20. Constants at the top of `hooks/awaiting-hook.js` |
| D1.15–17 | M1 | What gets stored | Hook drops `tool_response`; server caps bodies at 8 MiB; allowlist sanitization; prompt first word kept only if it looks like a plain word or slash command | Derived features only (H3) |
| D1.18 | M1 | Raw-prompt opt-in | `privacy.storeRawPrompt` off; no UI toggle in M1 | Settings UI later |
| D1.19–20 | M1 | Interrupt and ordering | Inactivity 10 min (60 min while a tool runs or the user is asked); 250 ms reorder buffer | `turns.*` settings |
| D1.21–27 | M1 | Misc | Keep all events; doctor round-trip via the real hook; React ESLint deferred; Electron userData unchanged; `CLAUDE_CONFIG_DIR` not handled; server owned by hooks-integrator; `received_at` top-level | See plan §9.1 |

## Needs manual check

GUI-only or real-session checks, with exact steps.

- **M0-1: avatar window look.**
  1. Run `corepack enable`, then `pnpm dev`.
  2. Expected: a framed main window plus an avatar window with no frame, a see-through background and no taskbar button.
  3. Click another app and confirm the avatar stays on top.

- **M1-1: real Claude Code session.** PowerShell, repo root. Uses a temp settings file, never the real one.
  1. Set the data dir, build the CLI and install into a temp settings file:
     ```powershell
     $env:AWAITING_HOME = "$env:TEMP\awaiting-m1"
     pnpm --filter @awaiting/cli build
     pnpm awaiting install --settings "$env:AWAITING_HOME\claude-settings.json"
     ```
     Expected: 14 entries written, and the hook copied to `$env:AWAITING_HOME\hook\`.
  2. Run `pnpm dev` in the same shell. Expected: the debug view shows "Server: listening on 127.0.0.1:<port>".
  3. Run `pnpm awaiting doctor --settings "$env:AWAITING_HOME\claude-settings.json"`. Expected: exit 0.
  4. In a second PowerShell window, set `$env:AWAITING_HOME = "$env:TEMP\awaiting-m1"`, `cd` into a scratch git repo, then run:
     ```powershell
     claude --settings "$env:AWAITING_HOME\claude-settings.json" --debug-file "$env:AWAITING_HOME\cc-debug.txt"
     ```
     If `--settings` rejects a path, pass the file's JSON content instead. Accept workspace trust and note the `claude --version`.
  5. Normal turn: "read README.md and add a line to it". Expected: SessionStart, UserPromptSubmit, Pre/PostToolUse and Stop appear live, and the turn ends `done/stop`.
  6. Interrupted turn: ask for a long task, press Esc during a tool, then send a new prompt. Expected: the old turn is `interrupted`.
  7. `/exit`. Expected: SessionEnd appears.
  8. Check `cc-debug.txt`. Expected: our hook entries finish with status 0 or are "moved to the background", Stop/SessionEnd take under 500 ms, and the session shows no hook errors.
  9. Quit the app and run doctor again. Expected: exit 1 with a "start the awaiting app" fix. A new Claude prompt still shows no hook errors.
  10. Run `pnpm awaiting uninstall --settings "$env:AWAITING_HOME\claude-settings.json"`. Expected: the file becomes `{}` and a backup exists.
  11. Optional: save a recording for M2/M3:
      ```powershell
      node apps/desktop/scripts/export-events.mjs "$env:AWAITING_HOME\awaiting.db" packages/core/src/fixtures/recordings/m1-session.json
      ```

## Known issues / leftovers

- M0 review: the request blocker allows any `file:` URL. Restrict it to the renderer directory when untrusted content appears.
- M1 core: slash-command names (`/[a-z0-9:_-]{1,32}`) are stored as the prompt `firstWord` (D1.17). A custom command name could carry user text. Tighten to an allowlist of built-in commands if that matters.
- M1 CLI (D1.9): if settings already have an *empty* event array (e.g. `"PostToolUse": []`), install puts our group in it, and uninstall then removes the array. The result is equal in meaning (an empty array is a no-op) but not byte-identical. An exact round trip would need an install manifest.
- M1 ingestor: the in-memory session map holds every session ever seen. Prune ended sessions in a later milestone.
- M1 review: if the app crashes and its pid is later reused by another process, a stale `server.json` could make the hook POST one event (including the raw prompt) to whatever now listens on that loopback port. The exposure is local-only and unlikely. The app overwrites `server.json` on every start. Possible hardening: the server echoes a token-derived proof the hook verifies before sending the body.
- M1 review: subagent detection relies on having seen `SubagentStart`. If the app starts in the middle of a subagent, that subagent's tool events count as main activity. Kept, because in `--agent` sessions every event carries agent fields (plan R8).
- M1 review → M2: a `UserPromptSubmit` that wasn't typed by the user (background-subagent report, `/loop`, scheduled task) closes a running turn as `interrupted/next_prompt`. M2 must handle this before training on those turns.
