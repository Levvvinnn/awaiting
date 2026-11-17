# awaiting: Spec and milestones

This document lists awaiting's milestones and the criteria that mark each one done. Work through them in order. Each milestone gets its own plan in `docs/plans/` before any code is written (see `CLAUDE.md`).

Hook names and payloads come from https://code.claude.com/docs/en/hooks, read on **2026-11-16**. If anything here disagrees with the live docs, the docs win. Fix this file when that happens.

---

## Reference: Claude Code hooks we use

### Events

awaiting only observes. Its hooks never block anything, change anything or return decisions.

| Event | Fires when | Fields we read (beyond the common ones) | Used for |
|---|---|---|---|
| `SessionStart` | A session starts or resumes (`source`: `startup`, `resume`, `clear`, `compact`, `fork`) | `source`, `model?` | Session lifecycle, model as an ETA feature |
| `UserPromptSubmit` | The user submits a prompt | `prompt` (features only, see privacy) | **Turn start**, ETA features |
| `PreToolUse` | Before a tool call | `tool_name`, `tool_input`, `tool_use_id` | Avatar state, live ETA |
| `PostToolUse` | After a tool call succeeds | `tool_name`, `tool_input`, `tool_use_id`, `duration_ms?` | Recap (files, commands), ending "needs you" |
| `PostToolUseFailure` | After a tool call fails | `tool_name`, `tool_use_id`, `error`, `is_interrupt?`, `duration_ms?` | Avatar `error`, recap failures |
| `PermissionRequest` | A tool needs the user's permission | `tool_name` (no `tool_use_id`) | **Waiting-on-user start**, `needs you` |
| `Notification` | Claude Code sends a notification | `notification_type`, `message`, `title?` | `needs you` and callback |
| `SubagentStart` | A subagent is spawned or resumed | `agent_id`, `agent_type` | Helper characters |
| `SubagentStop` | A subagent finishes | `agent_id`, `agent_type` | Helper characters |
| `TaskCreated` | A task is created via `TaskCreate` | `task_id`, `task_subject` | Live ETA progress |
| `TaskCompleted` | A task is marked complete | `task_id`, `task_subject` | Live ETA progress |
| `Stop` | The main agent finishes responding | `last_assistant_message`, `background_tasks`, `stop_hook_active` | **Turn end (done)**, recap |
| `StopFailure` | The turn ends because of an API error | `error`, `error_details?` | **Turn end (error)** |
| `SessionEnd` | The session ends (`reason`) | `reason` | Close any open turn |

Every event carries these common fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `agent_id?` and `agent_type?`.

The `Notification` types we act on are `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog` and `agent_needs_input`. We store the others but don't act on them.

### Caveats from the docs that shape the design

- **`Stop` does not fire on a user interrupt.** A turn without a `Stop` or `StopFailure` is closed as `interrupted` when the next `UserPromptSubmit` or `SessionEnd` arrives for that session, or after an inactivity timeout. Interrupted turns are kept out of ETA training by default.
- **`TaskCreated` and `TaskCompleted` don't fire in sessions without the Task tools.** The ETA must work without them, so task progress is a bonus signal only.
- **`SubagentStop` also fires for Claude Code's internal agents** (prompt suggestions, `/btw`), sometimes with an empty `agent_type`. A helper character only appears for a `SubagentStart` that has a matching `agent_id`.
- **`agent_id` on the Task events needs Claude Code v2.1.290 or later.** Treat it as optional.
- **Plain-text stdout becomes context for Claude** on `UserPromptSubmit` and `SessionStart`, and other events parse stdout as JSON. This is why the hook writes nothing to stdout.
- **`SessionEnd` has a 1.5 s total budget by default.** The hook's ~500 ms limit fits inside it.
- **Hook config shape:** `hooks.<Event>[].hooks[]` with `type: "command"`. `timeout` is in seconds. `async: true` runs the hook in the background without blocking Claude Code. `args` runs `command` without a shell, which avoids quoting problems with Windows paths. The M1 plan must confirm which of these options our minimum supported Claude Code version honors.

---

## Cross-cutting requirements (every milestone)

These restate `CLAUDE.md`'s hard rules as testable criteria.

- **H1. The hook is harmless.**
  - Exit code is 0 in every case: server down, server slow, malformed stdin, empty stdin, server returns 500.
  - stdout is empty in every case.
  - The hook finishes in ≤ 600 ms even when the server never responds.
  - The hook has zero dependencies.
- **H2. Local only.**
  - The server listens on `127.0.0.1` only, which a test checks.
  - Nothing in the codebase makes an outbound network call. A lint rule or test enforces this where practical.
- **H3. No raw prompt text at rest by default.**
  - The server turns `prompt` into features on receipt (length, first word, pasted-block count) and drops the raw text before anything is written to the DB.
  - A test asserts that a prompt submitted through the pipeline does not appear in the SQLite file.
  - An opt-in setting exists to store raw text, and it is off by default.
- **H4. The installer is reversible.** See M1.
- **H5. Estimates are ranges.** No UI surface, notification or card shows a single-number ETA.
- **H6. Tests and lint pass.** `pnpm test` and `pnpm lint` pass on Windows, macOS and Linux in CI.

---

## M0: Scaffold

**Goal:** Set up an empty but working monorepo that every later milestone builds on.

**Scope**
- A pnpm workspace with `apps/desktop`, `packages/core`, `packages/cli` and `hooks/`.
- TypeScript strict mode, with a shared `tsconfig` base.
- An Electron + React + Vite desktop app with two windows:
  - the **main window** (normal frame)
  - the **avatar window** (frameless, transparent, always on top, empty for now)
- Vitest in `packages/core` and `packages/cli`.
- ESLint, plus Prettier if wanted, at the root.
- GitHub Actions CI running install, lint and test on `windows-latest`, `macos-latest` and `ubuntu-latest` with Node 20.
- `better-sqlite3` installed and rebuilt for Electron's ABI (electron-rebuild or the equivalent).

**Acceptance criteria**
- [ ] `pnpm install` on a clean clone succeeds on all three OSes.
- [ ] `pnpm test` runs Vitest in core and cli. At least one sample test passes.
- [ ] `pnpm lint` passes with zero errors.
- [ ] `pnpm --filter desktop dev` opens both windows. The avatar window has no frame, a transparent background and stays above other windows.
- [ ] The main process can open an in-memory SQLite database. A smoke test proves the native module loads under Electron.
- [ ] CI is green on all three OSes.
- [ ] The Commands section of `CLAUDE.md` is updated to match the real scripts.

---

## M1: Hook pipeline

**Goal:** Every Claude Code hook event reaches the app safely and is stored, and it can be seen live.

**Scope**
- **`hooks/awaiting-hook.js`**
  - Reads stdin JSON, adds `received_at` (epoch ms, taken in the hook), and POSTs it to `http://127.0.0.1:<port>/events`.
  - Has a hard timeout of ~500 ms.
  - Exits 0 and writes nothing to stdout, ever.
  - Finds the port in a small file written by the app, for example `~/.awaiting/port`, falling back to a default. A missing file means it exits 0 at once.
  - Optionally checks a shared token from the same file, so other local processes can't inject events.
- **Local HTTP server** (main process)
  - Accepts `POST /events`, validates against a per-event schema and strips the raw prompt (H3).
  - Responds quickly and does the work after replying.
  - Rejects unknown or invalid bodies with 400 but never crashes.
- **SQLite schema** with tables for `sessions`, `turns`, `events` and `settings`, plus migrations.
  - A turn opens on `UserPromptSubmit` and closes on `Stop`, `StopFailure` or interrupt detection (see caveats).
  - Each event stores derived fields plus sanitized JSON.
- **CLI `awaiting install | uninstall | doctor`**
  - `install` backs up `~/.claude/settings.json` to `settings.json.awaiting-backup-<timestamp>`.
    - It then merges one entry per event from the table above: `type: "command"`, the hook run with `node`, `async: true` if supported, and a short timeout.
    - Our entries are identified by the hook script's path.
    - It creates the file if it is missing. It aborts without writing if the JSON is malformed.
  - `uninstall` removes only entries whose command references our hook script, and drops event arrays or matcher groups that end up empty only if we created them.
  - `doctor` reports: the Node version, whether settings.json exists and parses, which of our events are installed or missing, whether the hook script path exists, whether the server is reachable and whether a test event round-trips. It never writes.
  - Every command accepts `--settings <path>` for tests.
- **Debug view** in the main window: a live, filterable list of incoming events (event name, session, tool, timestamp) and the current turn per session.

**Acceptance criteria**
- [ ] The hook tests (spawning the real script) cover:
  - server down
  - server hanging for 5 s
  - a 500 response
  - empty stdin
  - garbage stdin
  - a valid event

  Every case exits 0 with empty stdout. The hanging case finishes in ≤ 600 ms.
- [ ] The server binds only to `127.0.0.1`, which a test asserts. Connecting via a non-loopback interface fails.
- [ ] The privacy test passes: after a `UserPromptSubmit` containing a sentinel string, the sentinel is absent from the DB file.
- [ ] The installer tests run on fixtures:
  - no file
  - an empty object
  - existing unrelated hooks on the same events
  - existing matcher groups
  - malformed JSON
  - running install twice
  - install then uninstall

  The user's hooks are untouched in every case. Install twice yields no duplicates. Install then uninstall gives back JSON equal in meaning to the original. Malformed input is never overwritten.
- [ ] A backup file is created before every write.
- [ ] `doctor` exits non-zero when something is wrong and prints what to fix.
- [ ] Manual check with a real Claude Code session: the debug view shows `SessionStart`, `UserPromptSubmit`, tool events, `Stop` and `SessionEnd` live. Claude Code shows no hook errors and no added latency.
- [ ] Turn boundaries are correct for: a normal turn, a turn ended by an API error (`StopFailure`), and a user-interrupted turn (no `Stop`).
- [ ] The M1 plan cites the doc sections for every event and config field used.

---

## M2: Wait estimate

**Goal:** When a turn starts, show a p50–p90 estimate of how long it will take, update it live while the turn runs, and count only time the agent is actually working.

**Scope (all logic in `packages/core`)**
- **Features per turn:**
  - the repo (git root of `cwd`, resolved in the main process)
  - prompt length (bucketed, for example log scale)
  - the prompt's first word (lowercased, normalized)
  - optionally the model and `permission_mode`
- **k-nearest-neighbors** over past completed turns.
  - Distance: same repo weighted heavily, then the prompt-length distance, then whether the first word matches.
  - Output: the p50 and p90 of the neighbors' **active durations**.
  - Fallbacks when there are fewer than `kMin` neighbors: widen to all repos, then to a global prior. Low data means a wider range plus a `low confidence` flag.
- **Active duration** = turn wall time minus waiting-on-user intervals.
  - A wait interval opens on `PermissionRequest`, or on a `Notification` of type `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` or `idle_prompt`.
  - It closes on the next agent-activity event in the same session (`PostToolUse`, `PostToolUseFailure`, `PreToolUse`, `Stop`, `StopFailure`).
  - The M2 plan must check this event order against a real session and document any edge cases.
- **Live updates while a turn runs:**
  - The estimate is conditioned on elapsed active time. Only neighbors that ran longer than the elapsed time count, so the range never says "done in 2 min" at minute 5.
  - When `TaskCreated` and `TaskCompleted` are seen, completed/total tasks adjusts the remaining estimate. This only helps when present.
  - The estimate is frozen while the agent is waiting on the user.
- **Calibration screen:**
  - the share of past turns whose actual active duration was ≤ p50 (target ~50%) and ≤ p90 (target ~90%)
  - those shares broken down by repo
  - a list of recent turns showing predicted vs. actual
  - a way to exclude outlier turns

**Acceptance criteria**
- [ ] Core unit tests cover:
  - kNN selection and the distance ordering
  - percentile computation
  - the fallback chain
  - conditioning on elapsed time (p50 and p90 are never below elapsed)
  - task-progress adjustment
  - waiting-interval subtraction, including overlapping and unclosed intervals
  - interrupted turns excluded from training
- [ ] Core is deterministic: there are no clock reads in core, and time is passed in.
- [ ] With zero history, the UI shows a wide range labelled low-confidence, never a single number (H5).
- [ ] Replay test: feeding a recorded event fixture through the pipeline gives the expected active duration and stored estimate.
- [ ] The estimate visibly updates during a real run, and its range only narrows or shifts forward as time passes.
- [ ] Time spent at a permission prompt is excluded from the turn's active duration. This is checked manually by waiting 60 s at a prompt.
- [ ] The calibration screen shows p50 and p90 hit rates once there are ≥ 20 completed turns. After 50 or more turns on a test dataset, the p90 hit rate is between 80% and 95%.

---

## M3: Avatar

**Goal:** Add a small companion in a transparent always-on-top window that shows at a glance what the agent is doing.

**Scope**
- **States, mapped from events in core as a pure state machine:**

  | State | Triggered by |
  |---|---|
  | `reading` | `PreToolUse` with a read or search tool (`Read`, `Grep`, `Glob`, web fetch or search) |
  | `typing` | `PreToolUse` with an edit or write tool (`Edit`, `Write`, notebook edit) |
  | `running` | `PreToolUse` with `Bash` or another execution tool, and the default while a turn is active |
  | `needs you` | an open waiting-on-user interval (see M2) |
  | `error` | `PostToolUseFailure` (brief) or `StopFailure` (stays until the next turn) |
  | `done` | `Stop` |
  | `sleeping` | no active turn for N minutes, or no session at all |

  Tool names come from the actual `tool_name` values seen in M1 recordings, not guesses. Unknown tools fall back to `running`.
- **Speech bubble** showing the live estimate range from M2 and elapsed time. It can be clicked to open the main window.
- **Helper characters:**
  - one per active subagent (`SubagentStart` with `agent_id`), labelled with `agent_type`
  - each leaves on the matching `SubagentStop`
  - capped at a small number, with "+N" for extras
- **Window behavior:**
  - The window can be dragged and remembers its position.
  - Clicks pass through except on the character and bubble.
  - It can be hidden from a tray or menu.
  - It works across multiple displays.
- **With several sessions at once:** the avatar shows the most recently active session, and the bubble indicates the count.

**Acceptance criteria**
- [ ] State-machine unit tests cover every transition in the table, including unknown tools, an error followed by recovery, and `needs you` taking priority over the other active states.
- [ ] Helper tests cover: a start/stop pair, a stop with no start (internal agents), a duplicate start on resume, and overflow past the cap.
- [ ] The window is transparent, frameless and always on top on Windows and macOS, with no taskbar or dock entry.
- [ ] The bubble always shows a range (H5).
- [ ] Animations hold ≥ 30 fps on idle hardware, and CPU use is below ~2% while `sleeping`.
- [ ] A real session visibly passes through reading → typing → running → done, and shows a helper while a subagent runs.

---

## M4: Awaiting list

**Goal:** Turn the wait into reclaimed time by suggesting one of the user's own tasks that fits it, then call them back when the agent needs them.

**Scope**
- **Task list (stored locally):**
  - Each task has a title, estimated minutes, an energy level (`low`, `medium`, `high`), optional tags and a done/archived status.
  - Tasks can be added, edited, reordered and completed, using the keyboard as well as the mouse.
- **Picker (pure function in core):**
  - Inputs: the task list, the current estimate (p50/p90), the energy filter and the time of day.
  - Output: a ranked list of suggestions.
  - A task fits if its minutes are ≤ the conservative end of the window (p50 by default, configurable).
  - Ties are broken by energy match, then by how long since the task was last suggested.
  - There are actions to accept, skip ("not now") and mark done.
- **Callback** when the agent needs the user (`needs you`) or finishes (`Stop` or `StopFailure`):
  - a native OS notification plus an optional sound, configurable per kind
  - clicking the notification focuses the terminal or the app where possible
  - no notification while the app window is focused, configurable
  - a quiet-hours setting
- **Tracking:** the accepted task, and whether it was done before the agent finished. M5's stats use this.

**Acceptance criteria**
- [ ] Picker unit tests cover: fit vs. no fit, the energy filter, tie-breaking, rotation (a skipped task is not suggested again immediately), an empty list and an estimate with low confidence.
- [ ] With no fitting task, the picker says so plainly instead of suggesting something too long.
- [ ] A native notification fires within 1 s of `Stop` and of a `permission_prompt` `Notification`, on Windows and macOS.
- [ ] The sound can be turned off. Quiet hours suppress the sound and, if set, the notification.
- [ ] Tasks persist across restarts.

---

## M5: Welcome-back recap and stats

**Goal:** When the user comes back, show what happened in a few seconds, and show over time how much waiting they turned into doing.

**Scope**
- **Recap** for the turn (or turns) since the user was last active:
  - **Files changed:** unique `tool_input.file_path` values from successful `PostToolUse` on edit and write tools.
  - **Commands run:** from `PostToolUse` and `PostToolUseFailure` on `Bash`.
    - Show the command truncated, and add a setting to hide commands entirely.
    - Don't store full output.
  - **Failures:** `PostToolUseFailure` (tool name plus the `Exit code N` first line only, as the docs advise) and `StopFailure` `error`.
  - **Last message:** `last_assistant_message` from `Stop`.
    - Store it truncated (for example 500 characters), only the latest per session.
    - Add a setting to disable storing it.
  - **Timing:** actual active duration vs. the predicted range, plus time spent waiting on the user.
- **Trigger:** the recap shows when the user returns: the window is focused after a callback, or the system comes back from idle after a turn ended.
- **Stats:**
  - time reclaimed = the sum of active agent time during which the user accepted and completed an awaiting-list task
  - turns per day
  - total agent time
  - time waiting on the user
  - estimate accuracy (from M2)
  - top repos
  - streaks
- **Shareable recap card ("Wrapped"-style):**
  - a generated image covering a chosen period (week, month or year)
  - it never includes repo names, file paths, commands or message text unless the user explicitly turns each one on
  - it is saved locally as PNG, with copy to clipboard
  - nothing is uploaded

**Acceptance criteria**
- [ ] Unit tests for the recap builder in core cover: deduplicating files, failures, truncation, an empty turn, multiple turns since away, and the hide-commands setting.
- [ ] Unit tests for stats aggregation cover: time-reclaimed math, day boundaries in the local timezone and streaks.
- [ ] The recap appears on return after a real run and correctly lists the files changed and commands run.
- [ ] The default card contains no repo names, paths, commands or message text. This is checked by a test on the card's input data.
- [ ] Every duration shown is a range or an actual measured value, never a single-number prediction (H5).
- [ ] Settings that disable storing data also stop collecting it from then on, and offer to delete existing data.

---

## M6: Packaging and launch

**Goal:** A user can install awaiting, connect it to Claude Code and remove it cleanly, on Windows, macOS and Linux.

**Scope**
- **Desktop installers** via electron-builder or the equivalent:
  - Windows: NSIS
  - macOS: dmg, signed and notarized
  - Linux: AppImage and/or deb
- **Hook placement:** the installed app ships the hook script at a stable path.
  - First run offers to run `awaiting install` with a preview of the settings.json changes.
  - The CLI is available from the app or via `npx`.
- **Uninstall path:** the app's uninstaller, or a menu item, runs `awaiting uninstall` first.
- **Docs:**
  - README with install, privacy and uninstall sections
  - a privacy page listing exactly what is stored and where
  - a troubleshooting section that points to `awaiting doctor`
- **Release CI:** a tagged build produces signed artifacts for all three OSes.
- **Auto-update:** not included by default, because it would be an outbound network call. Shipping it requires an explicit opt-in and a decision recorded in the M6 plan.

**Acceptance criteria**
- [ ] A fresh install on clean Windows, macOS and Linux machines reaches a working avatar and an estimate after one real Claude Code turn.
- [ ] Uninstalling the app leaves `~/.claude/settings.json` equal in meaning to its pre-install state, and a backup remains.
- [ ] The macOS build passes notarization, and the Windows build is signed or its SmartScreen behavior is documented.
- [ ] A network capture during a full session shows no traffic except loopback.
- [ ] `awaiting doctor` passes on every fresh install.
- [ ] README and privacy docs are complete and match the actual behavior.

---

## Open questions (resolve in the relevant milestone plan)

1. **M1:** Do `async: true` and `args` (exec form) work on our minimum Claude Code version? If `async` isn't available, the hook's ~500 ms limit is the only protection, which is acceptable.
2. **M1:** What is the minimum supported Claude Code version? It decides whether we can rely on optional fields like `agent_id` on the Task events.
3. **M2:** What is the exact event order around a permission prompt (`PreToolUse` → `PermissionRequest` → `Notification`?) and when the user denies? Confirm with a recording.
4. **M2:** What inactivity timeout should close an interrupted turn? Start at 10 min and tune it.
5. **M5:** What should count as "the user returned"? Window focus, system idle, or both? Confirm per OS.
