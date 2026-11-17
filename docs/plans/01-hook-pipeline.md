# M1: Hook pipeline — plan

Spec: `docs/SPEC.md` § M1 (+ §Reference, H1–H4). Author: architect. Date: 2026-11-16.
Status: pre-approved run (PROGRESS.md run mode). Every open question has a default in §9 "Decisions (defaults chosen)".
Hook docs read on 2026-11-16 at https://code.claude.com/docs/en/hooks (latest Claude Code in the changelog that day: v2.1.326).

---

## 1. Goal

Every Claude Code hook event in the SPEC table reaches the awaiting app through a harmless, zero-dependency hook and a token-protected 127.0.0.1 server. It is stored in SQLite as derived fields plus sanitized JSON (no raw prompt text by default), grouped into correct turns and shown live in a debug view. A reversible `awaiting install | uninstall | doctor` CLI wires it into `settings.json`.

## 2. Scope / non-goals

**In scope**
- `hooks/awaiting-hook.js` (CommonJS, zero deps, Node ≥ 20) and its `node:test` suite.
- `apps/desktop/src/main/server/`: loopback HTTP server, `server.json` runtime file (port, token, pid), doctor ping endpoint.
- `packages/core`: event validation and normalization, prompt features, sanitization allowlist, the turn state machine, the reorder buffer and data-dir resolution. All pure, all with Vitest tests.
- `apps/desktop` main: SQLite file DB, migrations, repository, the ingest pipeline, a narrow debug IPC push, and the debug view in the main window.
- `packages/cli`: `install`, `uninstall` and `doctor` with `--settings <path>`, bundled to `dist/awaiting.cjs`.
- Lint guards for the hook, a CI job for hook compatibility, and an updated app smoke test.

**Non-goals (later milestones)**
- ETA, waiting-on-user intervals, active duration (M2). M1 only tracks `awaitingUser`/in-flight tools to pick the inactivity timeout.
- Avatar states and helpers (M3), notifications (M4), recap, storing `last_assistant_message` and commands (M5).
- A settings UI. The raw-prompt opt-in exists as a DB setting with a read-only indicator in M1. The toggle UI comes with the settings screen (M4/M5).
- Event retention and pruning, packaging, a stable install location inside the app bundle, `npx` (M6).
- Subscribing to events outside the SPEC table (`PostToolBatch`, `PermissionDenied` and others).

## 3. Design

### 3.1 Data flow

```
Claude Code ──stdin JSON──▶ node ~/.awaiting/hook/awaiting-hook.js
   (async for 11 events; sync for Stop/StopFailure/SessionEnd)
        │ reads ~/.awaiting/server.json {port, token, pid}; drops tool_response; adds received_at
        ▼ POST http://127.0.0.1:<port>/events  (Authorization: Bearer <token>, ≤ 350 ms)
main: server/http.ts ─ auth → size → JSON → core.parseHookEvent (validate + features + sanitize, raw prompt dropped)
        │ 202 sent first; then enqueue
        ▼
pipeline/ingestor.ts ─ core.takeReady (250 ms reorder) → core.stepTurn → store/repo.ts (one transaction per event)
        │
        ▼ ipc/debug.ts ─ batched push (≤ 100 ms) ─▶ preload `window.awaiting.debug` ─▶ renderer DebugView
```

Pure vs. I/O: everything that decides something lives in `packages/core`. That covers validation, features, the sanitization allowlist, turn rules, reorder order and the data-dir rule. `apps/desktop` main does sockets, files, SQLite, timers and IPC. `packages/cli` does file I/O around a pure merge module (`packages/cli/src/settings/merge.ts`, no `fs`). The merge module stays in cli and not core because it is installer-specific, not app logic.

### 3.2 Data directory (one location for everything)

`dataDir = AWAITING_HOME (if set, non-empty, resolved to absolute) else <os.homedir()>/.awaiting`.

| Path | Writer | Content |
|---|---|---|
| `<dataDir>/server.json` | app (mode 0600, atomic tmp+rename, deleted on quit if pid matches) | `{ "version": 1, "port": int, "token": "<64 hex>", "pid": int, "startedAt": ms }` |
| `<dataDir>/awaiting.db` (+ `-wal`, `-shm`) | app | SQLite |
| `<dataDir>/hook/awaiting-hook.js`, `<dataDir>/hook/package.json` (`{"type":"commonjs"}`) | `awaiting install` (copy) | stable hook location referenced from settings.json |

The directory is created with mode 0700 on POSIX. Windows relies on the profile ACL.

Why `~/.awaiting` rather than Electron `userData`: the hook and the CLI must find `server.json` without Electron. Electron's `userData` path depends on platform and app name, and the zero-dependency hook would have to re-derive it. Keeping one directory also gives one override (`AWAITING_HOME`) for every test, one place for the M6 privacy page, and one thing to delete. Electron's own Chromium profile stays in default `userData` (D1.24).

`core/src/paths.ts`: `resolveDataDir(input: { awaitingHome: string | undefined; homeDir: string; sep: '/' | '\\' }): string` is pure string logic. Desktop and CLI call it and then `path.resolve`. The hook carries its own six-line copy, and a contract test (hook test vs. core test table) asserts that both give the same results.

### 3.3 Hook script `hooks/awaiting-hook.js`

- CommonJS (`hooks/package.json` `"type": "commonjs"`). It only `require`s `node:` builtins: `node:fs`, `node:os`, `node:path`, `node:http`. Supported Node: **≥ 20**. Syntax is capped at ES2022 by ESLint (`ecmaVersion: 2022`) and APIs are checked by a CI job on Node 20. `const HOOK_VERSION = 1;` sits on one line so doctor can read it.
- Order of operations:
  1. First statement: `process.stdout.write = process.stderr.write = () => true`, `process.noDeprecation = true`, `uncaughtException`/`unhandledRejection` → `exit0()`. Start the hard deadline `setTimeout(exit0, 400)`. Everything else runs inside `try { … } catch { exit0() }`. `exit0` = `process.exit(0)` wrapped in try.
  2. Read `server.json` synchronously. If it is missing, unreadable, invalid JSON, has a bad port (1–65535), a token that is not `^[0-9a-f]{64}$`, or a `pid` that is not alive (`process.kill(pid, 0)` throws ESRCH): **exit 0 at once**. stdin is not read and nothing is sent.
  3. Read stdin to end, capped at 16 MiB (over the cap → exit). Empty, unparsable, non-object, or missing string `hook_event_name`/`session_id` → exit with no request.
  4. `delete payload.tool_response` (largest field, never used, D1.15). Set `payload.received_at = Date.now()`.
  5. `http.request({ host: '127.0.0.1', port, method: 'POST', path: '/events', agent: false, timeout: 350, headers: { 'content-type': 'application/json', 'content-length', authorization: 'Bearer ' + token, 'x-awaiting-hook': '1' } })`. Any response → `res.resume()` then exit on `end`. `error`/`timeout` → `req.destroy()`, exit.
- It never writes stdout or stderr, never exits non-zero and never exits 2. It never reads the response body.

### 3.4 Settings entries written by `install`

One matcher group per event, **no `matcher` key** (match all), containing only our handler (exec form):

| Events | Handler |
|---|---|
| `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted` | `{ "type": "command", "command": "node", "args": ["<abs hook path>"], "async": true, "timeout": 5 }` |
| `Stop`, `StopFailure` | `{ "type": "command", "command": "node", "args": ["<abs hook path>"], "timeout": 2 }` (sync) |
| `SessionEnd` | `{ "type": "command", "command": "node", "args": ["<abs hook path>"], "timeout": 1 }` (sync; 1 s stays under the 1.5 s budget and does not raise it) |

Why: `async` gives zero added latency on the frequent events. `timeout` is not enforced for async hooks, so the hook's own 400 ms deadline is the real limit and `timeout: 5` is documentation only. The three turn-boundary events run sync because async hooks are killed at `-p` teardown, and losing `Stop` would turn every `claude -p` run into "interrupted". Exec form avoids shell quoting of Windows paths and the Windows-without-Git-Bash failure-blocks-tool rule for shell-form `PreToolUse`/`PermissionRequest`. `--shell-form` writes `"command": "node \"<path with forward slashes>\""` without `args` as an escape hatch (D1.3). The hook-doc citations are in §5.

### 3.5 Server `apps/desktop/src/main/server/`

`startEventServer(opts: { token: string; port?: number /* default 0 */; maxBodyBytes?: number /* 8 MiB */; timeouts?: {...}; onEvent(ev: NormalizedEvent): void; onDoctorPing(nonce: string): void; hasDoctorPing(nonce: string): boolean; keepRawPrompt(): boolean; now(): number }): Promise<{ port: number; address: string; close(): Promise<void> }>`. It uses only `node:http`/`node:crypto` and has no Electron import, so it runs under plain-Node Vitest.

- `listen({ host: '127.0.0.1', port: 0, exclusive: true })`. The host is a constant. `requestTimeout` 3 s, `headersTimeout` 2 s, `keepAliveTimeout` 1 s, `maxHeadersCount` 32. `clientError` → `socket.destroy()`. Every handler is wrapped in try/catch → 500, so the server never throws.
- Checks in order (first failure wins):

| Check | Response |
|---|---|
| `Host` ≠ `127.0.0.1:<port>` (DNS-rebinding guard) | 403 |
| `Origin` header present (browser) | 403 |
| route: `POST /events`, `GET /health`, `GET /doctor/ping/<32 hex>`; other path / method | 404 / 405 |
| `Authorization: Bearer` ≠ token (`crypto.timingSafeEqual` on equal-length buffers) | 401 |
| `POST`: content-type not `application/json` | 415 |
| body > `maxBodyBytes` (stop reading, destroy after reply) | 413 |
| JSON parse error | 400 |
| `hook_event_name === "AwaitingDoctorPing"` with `nonce` `^[0-9a-f]{32}$` | `onDoctorPing(nonce)` (in-memory, TTL 60 s, max 16) → 202. Never stored. |
| `core.parseHookEvent(body, { keepRawPrompt })` fails | 400 `{ "error": "<code>" }` |
| OK | **202 empty body sent, then** `setImmediate(() => onEvent(ev))`. `onEvent` errors are caught and counted. |

  `GET /health` → 200 `{ "app": "awaiting", "ok": true, "hookVersion": 1 }`. `GET /doctor/ping/<nonce>` → 200 if seen, otherwise 404.
- The raw `prompt` exists only inside the request handler's scope. `parseHookEvent` returns features, and returns `promptText` only when `keepRawPrompt()` is true.
- `runtime-file.ts`: `writeServerInfo(dataDir, info)`, `removeServerInfo(dataDir, pid)`, `readServerInfo(dataDir)`. The token is `crypto.randomBytes(32).toString('hex')`, new on every app start.

### 3.6 Core: events (`packages/core/src/events/`)

- `names.ts`: `HOOK_EVENT_NAMES` (the 14 SPEC events, in table order), `type HookEventName`, `ACTIONABLE_NOTIFICATION_TYPES` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`).
- `parse.ts`: `parseHookEvent(body: unknown, opts: { keepRawPrompt: boolean }): { ok: true; event: NormalizedEvent } | { ok: false; error: ParseErrorCode }`.
  - Required (else 400): an object body; `session_id` (non-empty string ≤ 256); `hook_event_name` ∈ `HOOK_EVENT_NAMES`; `received_at` (finite number > 0).
  - Per-event required: `UserPromptSubmit.prompt` (string); the `tool_name` string on `PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PermissionRequest`; `Notification.notification_type`; `SubagentStart|Stop.agent_id`; `TaskCreated|Completed.task_id`; `StopFailure.error`.
  - Everything else is optional. A wrong type on an optional field is treated as absent and its name is listed in `data.invalid_fields` (lenient, so a Claude Code payload change doesn't drop events).
- `NormalizedEvent` (flat, JSON-safe): `eventName, sessionId, receivedAt, promptId, agentId, agentType, cwd, permissionMode, effortLevel, toolName, toolUseId, notificationType, durationMs, isInterrupt, stopHookActive, source, reason, error, prompt: PromptFeatures | null, promptText: string | null, data: Record<string, JsonValue>`. Strings are capped (ids 256, tool name 128, cwd 1024).
- `prompt-features.ts`: `promptFeatures(prompt: string): { length /* code points */, wordCount, lineCount, pastedBlocks /* lines matching ^<pasted_content id="…">$ */, codeFences, isSlashCommand, firstWord: string | null }`. `firstWord` is the first token, lowercased and with trailing punctuation stripped. It is kept only if it matches `^[a-z][a-z'-]{0,23}$` or `^/[a-z0-9:_-]{1,32}$`, otherwise `null`. This way a token like a sentinel, a secret or a path is never stored.
- `sanitize.ts` is an **allowlist** per event that builds `data`. Nothing outside the allowlist is stored:

| Event | `data` keys |
|---|---|
| all | `invalid_fields?` (columns carry the common fields; `transcript_path`, `scratchpad_dir`, `session_title` are dropped) |
| SessionStart | `source`, `model`, `agent_type` |
| UserPromptSubmit | `prompt_features` (no text) |
| PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest | `tool_input_summary` (below), plus `duration_ms`; on failure also `is_interrupt` and `error_first_line` (≤ 200 chars); on PermissionRequest `permission_suggestions_count` |
| Notification | `notification_type`, `title` (≤ 120), `message` (≤ 200) |
| SubagentStart / SubagentStop | `agent_id`, `agent_type`, `stop_hook_active` (`last_assistant_message`, `agent_transcript_path` dropped) |
| TaskCreated / TaskCompleted | `task_id`, `task_subject_length` (subject text dropped) |
| Stop | `stop_hook_active`, `background_tasks_count`, `background_task_types[]`, `session_crons_count` (`last_assistant_message` dropped) |
| StopFailure | `error` (≤ 64), `error_details` (≤ 200) (`last_assistant_message` dropped) |
| SessionEnd | `reason` |

  `summarizeToolInput(toolName, input)`: `file_path` / `notebook_path` / `path` (≤ 1024). For `Bash` and `PowerShell`: `command_program` (basename of the first token if it matches `^[A-Za-z0-9._-]{1,64}$`), `command_length`, `run_in_background`. For `Agent`/`Task`: `subagent_type`. In every case `input_keys` (names only, ≤ 20). Content, `old_string`/`new_string`, URLs, queries and agent prompts are never kept.

### 3.7 Core: turns (`packages/core/src/turns/`)

Types: `TurnStatus = 'running' | 'done' | 'error' | 'interrupted'`, `EndReason = 'stop' | 'stop_failure' | 'next_prompt' | 'session_end' | 'inactivity' | 'tool_interrupt'`. `SessionTurnState { sessionId; lastSeq; current: TurnRef | null; ended; knownSubagents: string[] /* cap 256 */ }`, `TurnRef { seq; promptId; startedAt; lastEventAt; endedAt; status; endReason; inflightTools: string[] /* cap 64 */; awaitingUser }`.
API: `stepTurn(state | null, ev: NormalizedEvent, cfg): { state; effects: TurnEffect[]; attachSeq: number | null }`, `sweepInactive(state, nowMs, cfg)` (same result shape), `DEFAULT_TURN_CONFIG = { inactivityMs: 600_000, longInactivityMs: 3_600_000 }`. `TurnEffect` = `open{seq,startedAt,promptId}` | `close{seq,endedAt,status,reason}` | `reopen{seq}` | `touch{seq,lastEventAt}`.

Definitions: an event is **subagent** if `agentId ∈ knownSubagents` (added on SubagentStart). **Main activity** = non-subagent `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`. A closed turn is **reopenable** if `endReason ∈ {stop, stop_failure, inactivity, tool_interrupt}` and no later UserPromptSubmit has arrived.

| Event | Open turn | No open turn |
|---|---|---|
| UserPromptSubmit | close `interrupted/next_prompt` at `current.lastEventAt`; open `seq+1` at `receivedAt` | open `seq+1` |
| Stop | close `done/stop` at `receivedAt` | if current is reopenable and `receivedAt > endedAt`: reopen, then close `done/stop` at `receivedAt` (stop-hook continuation) |
| StopFailure | close `error/stop_failure` | same as Stop with `error` |
| SessionEnd | close `interrupted/session_end` at `lastEventAt`; `ended = true` | `ended = true` |
| PostToolUseFailure `is_interrupt === true`, non-subagent | close `interrupted/tool_interrupt` at `receivedAt` | as main activity |
| Main activity | touch; PreToolUse adds `tool_use_id` to in-flight, Post* remove it; clears `awaitingUser`; PermissionRequest sets `awaitingUser` | reopen if current is reopenable, `receivedAt > endedAt` and (`promptId` null or equal to `current.promptId`); otherwise orphan |
| Notification (actionable type) | touch; `awaitingUser = true` | orphan |
| Anything else (SessionStart, SubagentStart/Stop, Task*, subagent events, other notifications) | touch | orphan (`SessionStart` with `source=resume` sets `ended=false`) |

- **Attach:** `promptId` equal to `current.promptId` → `current.seq`; else the open turn; else `current.seq` if `receivedAt ≤ current.endedAt` (late event); else `null`.
- **Inactivity:** an open turn with `now − lastEventAt ≥ (inflightTools.length > 0 || awaitingUser ? longInactivityMs : inactivityMs)` closes as `interrupted/inactivity` at `lastEventAt`. Interrupted turns close at the last observed activity, never at detection time, so wall time is not inflated.
- Interrupted turns get `train_exclude = 1` in the store (M2 reads it).

`ingest/reorder.ts`: `takeReady<T>(pending: readonly Pending<T>[], nowMs, windowMs = 250): { ready; rest }`. An event is ready once `nowMs − receivedAt ≥ windowMs`. Ready events are sorted by `(receivedAt, arrival)`. This absorbs ordering races between parallel async hook processes.

### 3.8 SQLite (`apps/desktop/src/main/store/`)

`openStore(path)`: better-sqlite3 13 (N-API, loads in plain Node and in Electron). Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=2000`, `synchronous=NORMAL`. Migrations: an ordered `MIGRATIONS: { version, sql }[]`, versions tracked in `PRAGMA user_version`, each applied in its own transaction. If `user_version` > latest known, it refuses to open (no downgrade writes) and the app shows a startup error.

Migration 1:

- `sessions(session_id TEXT PK, first_seen_at INT NOT NULL, last_event_at INT NOT NULL, started_at INT, start_source TEXT, ended_at INT, end_reason TEXT, model TEXT, cwd TEXT, permission_mode TEXT, agent_type TEXT)`
- `turns(id INTEGER PK AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions, seq INT NOT NULL, prompt_id TEXT, started_at INT NOT NULL, ended_at INT, last_event_at INT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','done','error','interrupted')), end_reason TEXT CHECK(end_reason IN (…6…)), reopened_count INT NOT NULL DEFAULT 0, event_count INT NOT NULL DEFAULT 0, tool_count INT NOT NULL DEFAULT 0, cwd TEXT, permission_mode TEXT, model TEXT, prompt_length INT, prompt_word_count INT, prompt_line_count INT, prompt_pasted_blocks INT, prompt_code_fences INT, prompt_is_slash INT, prompt_first_word TEXT, prompt_text TEXT /* only if opt-in */, stop_error TEXT, train_exclude INT NOT NULL DEFAULT 0, UNIQUE(session_id, seq))`. Indexes `(session_id, started_at)`, `(status)`.
- `events(id INTEGER PK AUTOINCREMENT, received_at INT NOT NULL, ingested_at INT NOT NULL, session_id TEXT NOT NULL, turn_id INT REFERENCES turns(id), event_name TEXT NOT NULL, prompt_id TEXT, agent_id TEXT, agent_type TEXT, tool_name TEXT, tool_use_id TEXT, notification_type TEXT, duration_ms INT, is_interrupt INT, data TEXT NOT NULL /* sanitized JSON */)`. Indexes `(session_id, received_at)`, `(turn_id)`, `(event_name)`.
- `settings(key TEXT PK, value TEXT NOT NULL /* JSON */, updated_at INT NOT NULL)`. Defaults live in code. M1 keys: `privacy.storeRawPrompt` (false), `turns.inactivityMs` (600000), `turns.longInactivityMs` (3600000).

`repo.ts` (prepared statements): `applyEvent(ev, step)` runs in one transaction: upsert session, apply effects, insert event with `turn_id`, bump counters. Also `loadSessionStates()` (rebuilds core state on startup from sessions + latest turn), `recentEvents(limit)`, `currentTurns(sinceMs)`, `getSetting` / `setSetting`.

`pipeline/ingestor.ts`: `class Ingestor { constructor(repo, cfg, now: () => number, onChange: (u: DebugUpdate) => void); enqueue(ev); tick() /* every 100 ms: takeReady → stepTurn → repo */; sweep() /* every 30 s and once at startup */ }`. No Electron import.

### 3.9 Debug view and IPC

- `src/shared/bridge.ts` → `bridgeVersion: 2` plus `debug: { getSnapshot(): Promise<DebugSnapshot>; onUpdate(cb: (u: DebugUpdate) => void): () => void }`.
- `src/shared/debug-types.ts`:
  - `DebugEventRow { id, receivedAt, eventName, sessionId, turnSeq, toolName, notificationType, agentType }`
  - `DebugTurnRow { sessionId, seq, status, startedAt, endedAt, endReason, eventCount }`
  - `DebugSnapshot { events: DebugEventRow[] /* last 500 */, turns: DebugTurnRow[], server: { listening, port }, privacy: { storeRawPrompt } }`
  - `DebugUpdate { events, turns }`
  - `isDebugUpdate(x)` / `isDebugSnapshot(x)` validators
- Channels, hard-coded in the preload:
  - `awaiting:debug:snapshot` (`ipcRenderer.invoke`, no arguments). Main checks `event.sender === windows.main.webContents`, otherwise it throws.
  - `awaiting:debug:update` (`webContents.send` to the main window only, batched ≤ 100 ms, ≤ 200 rows per batch).
- The preload validates each payload with the shared guards before calling the listener, and passes only the data, never the `IpcRendererEvent`. Nothing else is exposed. The token never leaves main.
- The CSP, sandbox, `contextIsolation`, request blocker and navigation rules are unchanged (IPC is not network).
- Renderer `src/renderer/src/debug/`: `DebugView.tsx`, `EventList.tsx`, `TurnsPanel.tsx`, and a pure `state.ts` (merge updates, cap 1000 rows, `filterEvents(rows, { eventNames: Set, sessionId | null, text })`). Filters: event-name checkboxes, a session select, and a text box over tool name / notification type.
  - Times show as local `HH:MM:SS.mmm`.
  - Closed turns show a measured wall time ("2 min 05 s"). Running turns show "running since …".
  - No estimate of any kind (H5).
  - A header shows server status and "Raw prompt storage: off|on".

### 3.10 CLI `packages/cli`

- Entry `src/bin.ts` → `run(argv, deps: { env, homedir, now, stdout, stderr }): Promise<number>`. Bundled with Vite 8 SSR build (`vite.config.mts`, `build.ssr: 'src/bin.ts'`, `ssr.noExternal: ['@awaiting/core']`, target `node20`, CJS output `dist/awaiting.cjs` with a `#!/usr/bin/env node` banner). It runs on the user's Node ≥ 20 and stays private. `"bin": { "awaiting": "dist/awaiting.cjs" }`. Root script `"awaiting": "node packages/cli/dist/awaiting.cjs"`.
- Flags:
  - `--settings <path>` (default `<homedir>/.claude/settings.json`)
  - `--hook-path <path>` (use this path verbatim, no copy)
  - `--shell-form`
  - `--dry-run` (print the planned change and write nothing)
  - `--purge` (uninstall: also delete `<dataDir>/hook/`)
  - `--help`
- Exit codes: 0 ok, 1 failure/problem, 2 usage. `AWAITING_FORBID_REAL_SETTINGS=1` (set by every test) makes the CLI exit 2 if the resolved settings path equals `<os.userInfo().homedir>/.claude/settings.json`.
- **Hook path resolution:** source = first existing of `AWAITING_HOOK_SOURCE` env, `<cliDir>/awaiting-hook.js` (M6 ships the hook next to the bundled CLI), `<cliDir>/../../../hooks/awaiting-hook.js` (repo dev). `install` copies the source to `<dataDir>/hook/awaiting-hook.js` plus `package.json` (`{"type":"commonjs"}`, guarding against a `"type":"module"` in a parent such as `~/package.json`). It writes only if the content differs, atomically, and writes the copy's absolute path into settings. With `--hook-path`, that absolute path is written and nothing is copied. The stable copy survives moving or deleting the repo or app. With no `server.json` it exits 0 in about 50 ms, whereas a missing script would make Node exit 1 on every event.
- **Our-entry identification:** `isOurs(h)` = plain object, `h.type === 'command'`, and either some `args` element whose basename (split on `/` and `\`) equals `awaiting-hook.js` case-insensitively, or a `command` string containing `awaiting-hook.js` bounded by start / separator / quote / space. Matching by basename also catches stale paths from earlier installs. No custom keys are added to handlers (an unknown key could fail settings validation).
- **Read** (`settings/io.ts`): `missing` | `ok { value, raw, bom, eol, indent, trailingNewline, mtimeMs }` | `malformed { error }`. The top level must be a plain object. `hooks`, if present, must be a plain object, and each event value must be an array. Anything else counts as malformed for us: **abort, exit 1, no write, no backup**. JSONC comments are malformed.
- **Install merge** (`settings/merge.ts`, pure, returns a new object plus `changes[]`). For each of the 14 events in table order:
  1. `hooks` missing → add `hooks: {}` as the last top-level key. Event missing → `hooks[E] = [ourGroup(E)]` (`added`).
  2. Find our handlers across groups (`group.hooks` arrays only). None → push `ourGroup(E)` at the end of the event array (`added`).
  3. The first one found: if it is deep-equal to `desired(E)`, `unchanged`. Otherwise replace that handler object in place (`updated`), keeping its group and position.
  4. Any further ones are removed. A group left empty that contained only our handlers is removed (`deduped`).
  - User groups, handlers, matchers and the order of keys and array items are never touched.
- **Uninstall merge:** for **every** key in `hooks` (not only the 14):
  1. Remove our handlers from each group. A group that had at least one of ours and is now empty is removed.
  2. An event array that had at least one removal and is now empty is deleted.
  3. If `hooks` had at least one deletion and is now `{}`, delete `hooks`.
  - Groups with any user handler stay (minus ours). Pre-existing empty arrays/groups that never held our entries are untouched.
- **Write** (only if `changes` has something other than `unchanged`):
  1. Re-`stat` and re-read. If the content differs from what was parsed, abort ("settings.json changed during install, retry").
  2. **Backup**: `copyFileSync(path, path + '.awaiting-backup-' + YYYYMMDDTHHmmssSSSZ (UTC), COPYFILE_EXCL)`, with a `-2`, `-3` suffix on collision. The raw bytes are copied. Backups are kept forever.
  3. Serialize with `JSON.stringify(value, null, indent)` (indent detected, default 2), the original EOL, BOM and trailing newline.
  4. Write `path + '.awaiting-tmp-<pid>'`, fsync, rename (retry rename 3× on Windows EPERM/EBUSY).
  - Missing file on install → `mkdir -p` the parent and create it. No backup, because there is nothing to back up (S9).
- **Doctor** (read-only, prints `ok` / `warn` / `FAIL` lines with `fix:` hints; exit 1 on any FAIL):
  1. `node` on PATH (`spawnSync('node', ['--version'], { timeout: 5000 })`) ≥ 20.
  2. settings file exists, parses and is an object. `disableAllHooks: true` → warn.
  3. For each of the 14 events: installed exactly once / missing / duplicated / shape ≠ `desired(E)`.
  4. Every handler of ours points to the same path, which exists, is readable and has `HOOK_VERSION` equal to the CLI's version, with a sibling `package.json` of type commonjs.
  5. `server.json` exists, is valid and its pid is alive.
  6. `GET /health` (1 s).
  7. Round-trip: spawn the installed hook with `{"hook_event_name":"AwaitingDoctorPing","session_id":"awaiting-doctor","nonce":<32 hex>}`. Expect exit 0 and empty stdout/stderr, then poll `GET /doctor/ping/<nonce>` for up to 1.5 s.
  - HTTP lives in `src/doctor/probe.ts`, the only cli file allowed `node:http` (ESLint override, §4).
  - Doctor prints "Claude Code version: not checked (doctor never runs claude); supported ≥ 2.1.290" (D1.1).

### 3.11 App wiring (`apps/desktop/src/main/index.ts`)

On ready:
1. `installSecurity`.
2. `dataDir` (mkdir 0700).
3. `openStore(<dataDir>/awaiting.db)` and migrate.
4. Create the `Ingestor` and load states.
5. Generate the token and `startEventServer`.
6. `writeServerInfo`.
7. Windows, then `registerDebugIpc`.
8. Timers (`tick` 100 ms, `sweep` 30 s, both `unref`).

On `will-quit`: close the server, `removeServerInfo`, close the DB.

The single-instance lock (M0) guarantees one server. The event body is never logged. In smoke mode, `run-app-smoke.mjs` sets `AWAITING_HOME` to a temp dir and `smoke.ts` also asserts `bridgeVersion === 2`, the `debug` API exists, the server address is `127.0.0.1` and `server.json` exists.

## 4. Files to create or change, by owner

**eta-engine** (`packages/core`)
- `src/paths.ts`, `src/paths.test.ts`
- `src/events/names.ts`, `types.ts`, `parse.ts`, `prompt-features.ts`, `sanitize.ts`, `tool-input.ts`, plus `*.test.ts` for each
- `src/turns/types.ts`, `machine.ts`, `machine.test.ts`
- `src/ingest/reorder.ts`, `reorder.test.ts`
- `src/fixtures/index.ts` and `src/fixtures/hook-payloads/*.json`. The doc examples are copied verbatim (+ `received_at`) for each of the 14 events, along with the Windows `Write` PreToolUse example, the failed `npm test` PostToolUseFailure, a resumed SessionStart, Stop with `background_tasks`, and StopFailure `rate_limit`.
- `src/index.ts` (exports), `package.json` (`exports["./fixtures"]`)

**hooks-integrator** (`hooks/`, `packages/cli`, `apps/desktop/src/main/server/`)
- `hooks/awaiting-hook.js`, `hooks/test/hook.test.js`, `hooks/test/fake-server.js`, `hooks/package.json` (`"scripts": { "test": "node --test test/hook.test.js" }`, still no dependencies)
- `packages/cli/package.json` (scripts `build: vite build`, `test: vite build && vitest run`, `bin`, deps `@awaiting/core: workspace:*`, devDep `vite: 8.3.8`), `vite.config.mts`, `vitest.config.ts` (setupFiles), `tsconfig.json` (include `test`)
- `packages/cli/src/`: `bin.ts`, `run.ts`, `args.ts`, `paths.ts`, `events.ts` (desired handlers), `settings/io.ts`, `settings/merge.ts`, `settings/backup.ts`, `hook-copy.ts`, `commands/install.ts`, `commands/uninstall.ts`, `commands/doctor.ts`, `doctor/probe.ts`. The existing `commands.ts` and `index.ts` are kept and extended.
- `packages/cli/test/`: `setup.ts`, `merge.test.ts`, `install.test.ts`, `uninstall.test.ts`, `doctor.test.ts`, `bin.e2e.test.ts`, `semantic.ts` (helper), `fixtures/settings/{empty-object,unrelated-hooks,matcher-groups,other-settings,malformed-trailing-comma,malformed-hooks-array,stale-awaiting-entry,user-handler-in-our-group,bom-crlf}.json`
- `apps/desktop/src/main/server/`: `http.ts`, `auth.ts`, `runtime-file.ts`, `doctor-ping.ts`, `index.ts`, `http.test.ts`, `bind.test.ts`, `runtime-file.test.ts`, `e2e/privacy.e2e.test.ts`, `e2e/pipeline.e2e.test.ts`

**desktop-ui** (`apps/desktop`, except `server/`)
- `src/main/paths.ts`, `src/main/db.ts` (signature widened to `string`), `src/main/store/{open,migrations,repo}.ts` + `store.test.ts`
- `src/main/pipeline/ingestor.ts` + `ingestor.test.ts`
- `src/main/ipc/debug.ts`, `src/main/index.ts`, `src/main/smoke.ts`
- `src/shared/bridge.ts`, `src/shared/debug-types.ts` (+ `debug-types.test.ts`), `src/preload/index.ts`
- `src/renderer/src/App.tsx`, `src/renderer/src/debug/{DebugView,EventList,TurnsPanel}.tsx`, `state.ts`, `state.test.ts`, `debug.css`
- `vitest.config.mts` (include `src/**/*.test.ts`, node env), `scripts/run-app-smoke.mjs` (temp `AWAITING_HOME`), `scripts/export-events.mjs` (sanitized recording export, home dir replaced by `~`)

**orchestrator**
- `eslint.config.mjs`:
  - add `packages/cli/src/doctor/probe.ts` to the `http`/`net` override
  - `hooks/**/*.js`: `ecmaVersion: 2022`, `no-console: error`, and `no-restricted-syntax` for `require()` of anything not starting with `node:`
- `scripts/check-lint-guards.mjs`: new expected errors for
  - `hooks/__guard__.js` with `require('left-pad')` and with `console.log(1)`
  - `packages/cli/src/__guard__.ts` with `import http from 'node:http'`
  - `apps/desktop/src/main/server/__guard__.ts` with `import https from 'node:https'`
  - and a no-error case for `hooks/__guard__.js` with `require('node:http')`
- `.github/workflows/ci.yml`: new job `hook-compat` (matrix 3 OS × Node 20, no pnpm install: `node --test hooks/test/hook.test.js`)
- Root `package.json` (`awaiting` script), `pnpm-lock.yaml`, CLAUDE.md Commands, SPEC.md fixes from §10, PROGRESS.md

## 5. Hook docs referenced

All at https://code.claude.com/docs/en/hooks, read 2026-11-16.

| What the plan relies on | Section |
|---|---|
| Event list and cadence (`SessionStart`/`SessionEnd` per session; `UserPromptSubmit`/`Stop`/`StopFailure` per turn) | [#hook-lifecycle](https://code.claude.com/docs/en/hooks#hook-lifecycle) |
| `hooks.<Event>[]` matcher groups → `hooks[]` handlers; user file `~/.claude/settings.json` | [#configuration](https://code.claude.com/docs/en/hooks#configuration), [#hook-locations](https://code.claude.com/docs/en/hooks#hook-locations) |
| Omitted matcher = match all; a matcher on an event without matcher support is ignored | [#matcher-patterns](https://code.claude.com/docs/en/hooks#matcher-patterns) |
| `type`, `timeout` (seconds, default 600; not enforced with `async: true`); matching hooks run in parallel; an identical handler in several settings files runs once | [#common-fields](https://code.claude.com/docs/en/hooks#common-fields), [#hook-handler-fields](https://code.claude.com/docs/en/hooks#hook-handler-fields) |
| `command`, `args`, `async`, `shell`, `onFailure` (v2.1.295+) | [#command-hook-fields](https://code.claude.com/docs/en/hooks#command-hook-fields) |
| Exec form: no shell, each `args` element passed verbatim; on Windows use `node` + script path because `.cmd` shims can't be spawned | [#exec-form-and-shell-form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form) |
| Shell-form `PreToolUse`/`PermissionRequest` hooks that fail can block the tool call on Windows without Git Bash | [#failed-hooks-on-windows-without-git-bash](https://code.claude.com/docs/en/hooks#failed-hooks-on-windows-without-git-bash), [#block-the-action-when-a-hook-fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) |
| `onFailure` has no effect on async hooks or on `Stop` | [#block-the-action-when-a-hook-fails](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) |
| Async: runs in the background, can't block, output delivered next turn, killed at `-p` teardown, one process per execution | [#run-hooks-in-the-background](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background), [#limitations](https://code.claude.com/docs/en/hooks#limitations) |
| Exit 0 + no stdout = success; exit 2 blocks; other codes are non-blocking errors | [#exit-code-output](https://code.claude.com/docs/en/hooks#exit-code-output), [#exit-code-2-behavior-per-event](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event) |
| Plain stdout becomes Claude context on `UserPromptSubmit`/`SessionStart` (and others); otherwise it is parsed as JSON | [#exit-code-0](https://code.claude.com/docs/en/hooks#exit-code-0), [#json-output](https://code.claude.com/docs/en/hooks#json-output) |
| A timed-out hook is cancelled and its output discarded | [#timeouts](https://code.claude.com/docs/en/hooks#timeouts) |
| Common input: `session_id`, `prompt_id` (absent until first input), `transcript_path`, `cwd`, `permission_mode` (not on all events), `effort`, `hook_event_name`, `agent_id`/`agent_type` | [#common-input-fields](https://code.claude.com/docs/en/hooks#common-input-fields) |
| `SessionStart.source` (`startup/resume/clear/compact/fork`), optional `model`, `agent_type`; supports only `command`/`mcp_tool` | [#sessionstart](https://code.claude.com/docs/en/hooks#sessionstart), [#sessionstart-input](https://code.claude.com/docs/en/hooks#sessionstart-input) |
| `UserPromptSubmit.prompt`; `<pasted_content id="…">` markers; also fires for scheduled tasks, background-subagent reports, cross-session messages | [#userpromptsubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit), [#userpromptsubmit-input](https://code.claude.com/docs/en/hooks#userpromptsubmit-input) |
| `PreToolUse` `tool_name`, `tool_input`, `tool_use_id`; Bash `command`, `run_in_background` | [#pretooluse-input](https://code.claude.com/docs/en/hooks#pretooluse-input) |
| `PostToolUse` `tool_response`, `duration_ms?` | [#posttooluse-input](https://code.claude.com/docs/en/hooks#posttooluse-input) |
| Esc cancels running hooks | [#posttooluse-after-an-interrupt](https://code.claude.com/docs/en/hooks#posttooluse-after-an-interrupt) |
| `PostToolUseFailure` `error`, `is_interrupt?`, `duration_ms?`; not fired for permission denials, and cancelling a tool doesn't fire it | [#posttoolusefailure](https://code.claude.com/docs/en/hooks#posttoolusefailure) |
| `PermissionRequest` `tool_name`, `tool_input`, no `tool_use_id`, `permission_suggestions?` | [#permissionrequest-input](https://code.claude.com/docs/en/hooks#permissionrequest-input) |
| `Notification` `message`, `title?`, `notification_type`; types table (`permission_prompt` after ~6 s, `idle_prompt` ~60 s after the response, …) | [#notification](https://code.claude.com/docs/en/hooks#notification) |
| `SubagentStart` `agent_id`, `agent_type` | [#subagentstart-input](https://code.claude.com/docs/en/hooks#subagentstart-input) |
| `SubagentStop` fields; fires for internal agents with an empty `agent_type` | [#subagentstop-input](https://code.claude.com/docs/en/hooks#subagentstop-input) |
| `TaskCreated`/`TaskCompleted` `task_id`, `task_subject`; `agent_id` needs v2.1.290+; not fired without Task tools | [#taskcreated-input](https://code.claude.com/docs/en/hooks#taskcreated-input), [#taskcompleted-input](https://code.claude.com/docs/en/hooks#taskcompleted-input) |
| `Stop` doesn't run on user interrupt; `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | [#stop](https://code.claude.com/docs/en/hooks#stop), [#stop-input](https://code.claude.com/docs/en/hooks#stop-input) |
| `StopFailure` `error` enum, `error_details?`, `last_assistant_message?`; output and exit code ignored | [#stopfailure](https://code.claude.com/docs/en/hooks#stopfailure) |
| `SessionEnd` `reason` values; 1.5 s default budget; a per-hook `timeout` raises the budget | [#sessionend](https://code.claude.com/docs/en/hooks#sessionend) |
| Hooks held back until workspace trust is accepted (interactive) | [#workspace-trust](https://code.claude.com/docs/en/hooks#workspace-trust) |
| Edits picked up by the file watcher; `disableAllHooks`; `--settings` flag | [#disable-or-remove-hooks](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks) |
| `claude --debug-file`, `Hooks:` duration lines (v2.1.296+) | [#debug-hooks](https://code.claude.com/docs/en/hooks#debug-hooks) |

**Not covered by the docs** (so the plan doesn't rely on them):
- the Claude Code version that introduced `async` or `args`. The docs carry no version note, and the 1.3 M-character changelog could not be fully scanned (D1.1)
- whether interactive exit waits for async hooks
- whether `prompt_id` is stable across a stop-hook continuation
- whether a mid-turn queued message fires `UserPromptSubmit`
- whether `--settings` accepts a file path (the docs only show a JSON string)
- `CLAUDE_CONFIG_DIR`

**SPEC open questions answered:**
- **Q1:** `async` and `args` are both documented today. The docs give no introduction version, so we use exec form + async (sync for the three boundary events) and offer `--shell-form` as a fallback.
- **Q2:** supported Claude Code ≥ **2.1.290** (newest version gate on a field we read). That field, `agent_id` on Task events, is still treated as optional. The manual check records the version actually tested.

## 6. Test plan

### 6.1 Automated

| Suite | Runner | Key cases |
|---|---|---|
| `hooks/test/hook.test.js` | `node --test` (Node 20 and 22, 3 OS) | Spawns `process.execPath hooks/awaiting-hook.js` with a temp `AWAITING_HOME` and a `fake-server.js` on 127.0.0.1:0. Every case asserts **exit 0, stdout `''`, stderr `''`**. Cases: (1) no `server.json`, (2) server down (port of a closed server), (3) server hangs 5 s, which must finish **≤ 600 ms from spawn** (run 3×, assert the max), (4) 500 response, (5) empty stdin, (6) garbage stdin, (7) valid event (exactly one POST `/events`, Bearer token, JSON content-type, body = input − `tool_response` + `received_at` ∈ [t0, t1]), (8) stdin left open (≤ 600 ms), (9) malformed `server.json`, (10) dead pid, (11) stdin > 16 MiB, (12) JSON array. Also: `package.json` has no `dependencies`/`devDependencies`; every `require(` in the script starts with `node:`; a `resolveDataDir` contract table matching the core test. |
| `core` `events/*.test.ts` | Vitest | Every doc fixture parses. Missing/invalid required field → each error code. An optional wrong type becomes `invalid_fields`. Unknown event → error. Sanitize: a sentinel planted in **every** string field of every fixture never appears in `JSON.stringify(event.data)` or in any column field except `promptText` with `keepRawPrompt`. `promptFeatures`: code-point length, pasted blocks, slash commands, `firstWord` regex (a sentinel as first word → `null`). `summarizeToolInput` per tool. |
| `core` `turns/machine.test.ts` | Vitest | Every row of the §3.7 table, plus: normal turn; StopFailure turn; interrupted by next prompt (ends at `lastEventAt`); interrupted by SessionEnd; `is_interrupt` close then reopen on activity; stop-hook continuation (Stop, PreToolUse, Stop → one turn, `reopened_count` 1); `idle_prompt` after Stop doesn't reopen; subagent activity after Stop doesn't reopen; an internal SubagentStop with empty `agent_type` is an orphan; late event attaches to a closed turn; inactivity 10 min vs. 60 min with a tool in flight / awaiting user; inactivity close then reopen. |
| `core` `ingest/reorder.test.ts`, `paths.test.ts` | Vitest | Window boundary, tie on `receivedAt` keeps arrival order, late event released at once; `AWAITING_HOME` empty / set / Windows separator. |
| `cli` `merge.test.ts` (pure) + `install`/`uninstall`/`doctor.test.ts` (temp dir copies of fixtures) | Vitest | Fixtures: no file, `{}`, unrelated hooks on the same events, existing matcher groups, malformed (trailing comma, `hooks` as array, event as object, top-level array): **file bytes unchanged and no backup**. Install twice → second run writes nothing and has no duplicates. Install → uninstall deep-equals the original parse and keeps `Object.keys` order at every level. Stale path → updated in place. Our handler inside a user group → only it removed. A backup exists with identical bytes before every write. BOM/CRLF preserved. Changed-during-write → abort. `--dry-run` writes nothing. Doctor: each FAIL path (missing node mocked via a PATH without node, missing events, duplicate, bad script path, no `server.json`, dead server) gives exit 1 plus a `fix:` line. Healthy (fake server in test + real hook) gives exit 0. Doctor leaves the settings dir and data dir listing, sizes and mtimes unchanged. |
| `cli` `bin.e2e.test.ts` | Vitest (after `vite build`) | Spawns `node dist/awaiting.cjs install/uninstall/doctor --settings <tmp>` with `HOME`/`USERPROFILE`/`AWAITING_HOME` temp and `AWAITING_FORBID_REAL_SETTINGS=1`; `--settings` pointed at the real path → exit 2. |
| `desktop` `server/http.test.ts`, `bind.test.ts`, `runtime-file.test.ts` | Vitest (plain Node) | Status codes for every §3.5 row; 202 arrives even when `onEvent` throws; the server survives garbage sockets; `onEvent` runs after the response is written. **Bind:** `address().address === '127.0.0.1'`; connecting to every non-internal IPv4/IPv6 from `os.networkInterfaces()` on that port fails with ECONNREFUSED/EADDRNOTAVAIL (skipped with a logged reason only if none exists); `::1` fails. `server.json` mode 0600 on POSIX, atomic, removed only for a matching pid. |
| `desktop` `store.test.ts`, `pipeline/ingestor.test.ts` | Vitest + better-sqlite3 (N-API) on a temp file DB | Migration from empty; `user_version` too new → refuses. Replay of fixture sequences gives the expected `turns` rows (normal / StopFailure / interrupted / continuation). Restart: close and reopen, `loadSessionStates`, then sweep closes a stale turn. |
| `desktop` `server/e2e/privacy.e2e.test.ts` (**H3**) | Vitest | Real server + Ingestor + file DB in a temp `AWAITING_HOME`, with the event sent **by spawning the real hook**. UserPromptSubmit prompts carry a sentinel `AWT_SENTINEL_<random hex>` as the first word, mid-text and inside a `<pasted_content>` block, plus a PreToolUse with the sentinel in `tool_input.content` and a Stop with it in `last_assistant_message`. Wait for ingest, close the DB (checkpoint), read **every file** in the data dir. The sentinel is absent as UTF-8 and UTF-16LE. Control: with `privacy.storeRawPrompt = true` a new sentinel **is** found in `turns.prompt_text` (proves the probe works). |
| `desktop` `server/e2e/pipeline.e2e.test.ts` | Vitest | Hook → server → DB for a 6-event turn; the debug `onChange` sees the rows. |
| `desktop` `shared/debug-types.test.ts`, `renderer/.../state.test.ts` | Vitest | Validators reject extra/missing/wrong-typed fields; merge cap; filters. |
| `smoke:app` | CI step | `bridgeVersion 2`, `debug` API present, server on 127.0.0.1, `server.json` in temp `AWAITING_HOME`. |
| Lint guards | `pnpm lint` | §4 orchestrator snippets. |

Tests never touch the real `~/.claude`. `packages/cli/test/setup.ts` sets `HOME`/`USERPROFILE` to a temp dir, sets `AWAITING_FORBID_REAL_SETTINGS=1` and asserts `os.homedir() !== os.userInfo().homedir`. Every test passes `--settings` or a temp path explicitly.

### 6.2 Manual check (Windows 11; never the real settings file)

PowerShell, from the repo root:
1. `$env:AWAITING_HOME = "$env:TEMP\awaiting-m1"`, then `corepack pnpm --filter @awaiting/cli build`.
2. `corepack pnpm awaiting install --settings "$env:AWAITING_HOME\claude-settings.json"`. Expect a new file with 14 of our entries and the hook copied to `$env:AWAITING_HOME\hook\`.
3. `corepack pnpm dev` in the same shell, so the app inherits `AWAITING_HOME`. Open the debug view.
4. `corepack pnpm awaiting doctor --settings "$env:AWAITING_HOME\claude-settings.json"`. Expect exit 0.
5. In a second PowerShell, set the same `$env:AWAITING_HOME`, `cd` into a scratch git repo and run `claude --settings "$env:AWAITING_HOME\claude-settings.json" --debug-file "$env:AWAITING_HOME\cc-debug.txt"`. If `--settings` rejects a path, pass the file content as a JSON string (§9 open question). Accept the workspace trust dialog. Record `claude --version`.
6. Turn A (normal): "read README.md and add a line to it". The debug view shows `SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, `Stop` live, and the turn becomes `done/stop`.
7. Turn B (interrupt): ask for a long task, press Esc during a tool, then send a new prompt. Turn B is `interrupted/next_prompt` (or `tool_interrupt`) and a new turn opens.
8. Turn C (API error): `/model does-not-exist` then a prompt, expecting `StopFailure` and `error/stop_failure`. If Claude Code refuses before a turn or no `StopFailure` fires, record that. The criterion is then covered by the automated replay with the doc's `StopFailure` payload.
9. `/exit`. `SessionEnd` shows up.
10. Latency: in `cc-debug.txt`, every `Hooks:` line for our command shows `moved to the background` or `finished with status 0` with Stop/StopFailure durations < 500 ms. The session shows no hook error.
11. Quit the app, then run doctor again. Expect exit 1 with a "start the awaiting app" fix. Run one Claude prompt and confirm still no hook errors (missing `server.json` → instant exit 0).
12. `corepack pnpm awaiting uninstall --settings …`. The file becomes `{}`, a backup exists.
13. `node apps/desktop/scripts/export-events.mjs "$env:AWAITING_HOME\awaiting.db" packages/core/src/fixtures/recordings/m1-session.json` (sanitized, `~` paths). This is the recording M2/M3 rely on.
14. Optional, user only: install into the real `~/.claude/settings.json` without `--settings`, and inspect the backup.

### 6.3 Acceptance criteria mapping

| SPEC M1 criterion | Verified by |
|---|---|
| Hook tests: server down, hang 5 s, 500, empty stdin, garbage stdin, valid event → exit 0, empty stdout, hang ≤ 600 ms | `hooks/test/hook.test.js` cases 2–7 (+ 1, 8–12), Node 20 & 22 × 3 OS |
| Server binds only 127.0.0.1; non-loopback connect fails | `server/bind.test.ts` |
| Privacy sentinel absent from the DB file | `server/e2e/privacy.e2e.test.ts` (+ core sanitize sentinel test) |
| Installer fixtures: no file, `{}`, unrelated hooks, matcher groups, malformed, install twice, install→uninstall | `cli/test/install|uninstall|merge.test.ts` |
| Backup before every write | install/uninstall tests assert the backup bytes for every write on an existing file (missing-file case: S9) |
| `doctor` exits non-zero and prints fixes | `cli/test/doctor.test.ts` + manual step 11 |
| Real session shows events live, no hook errors, no added latency | Manual 6.2 steps 5–10 |
| Turn boundaries: normal, StopFailure, interrupted | `turns/machine.test.ts`, `ingestor.test.ts` replay, manual steps 6–8 |
| Plan cites doc sections | §5 |

## 7. Hard-rule check

1. **Hook harmless:**
   - always exit 0 (`exit0` everywhere, handlers for uncaught errors)
   - 400 ms hard deadline and a 350 ms request timeout, tested ≤ 600 ms
   - stdout/stderr writes are stubbed and `console` is banned by lint
   - zero deps, enforced by a test and the lint `require('node:…')` rule
   - async on the frequent events, sync only for the three boundary events, with SessionEnd `timeout: 1` < 1.5 s budget
   - a missing app or `server.json` gives an instant exit; the stable copy means a missing script can't happen after a repo or app move
2. **Privacy:**
   - the host is the constant `127.0.0.1` with a bind test
   - token + Host + no-Origin checks on the server
   - no new outbound modules; `node:http` only in `hooks/**`, `main/server/**` and `cli/src/doctor/probe.ts`, with lint guards
   - the raw prompt is dropped in `parseHookEvent` before the queue; allowlist sanitization; the opt-in `privacy.storeRawPrompt` is off by default; H3 e2e test
   - the hook drops `tool_response`; the event body is never logged
3. **Installer:**
   - timestamped backup before every write
   - append-only merge into our own matcher groups; no reordering
   - identified by script basename
   - uninstall removes only ours; idempotent
   - malformed → abort without writing
   - atomic write with a changed-during-write check
   - doctor is read-only (tested via mtimes), with the HTTP probe and hook spawn the only side effects
   - tests never touch the real file (setup guard + env guard)
4. **Hook docs:** §5 cites every event, field, config key, async/timeout/args, and exit-code and stdout rule. Gaps are listed.
5. **Ranges:** M1 shows no estimate. The debug view shows only timestamps and measured durations.

## 8. Task breakdown

Installs (`corepack pnpm install`) are serialized. Only the orchestrator regenerates `pnpm-lock.yaml`. Owners in the same parallel group touch disjoint files.

| ID | Group | Owner | Task | Depends on | Done when |
|---|---|---|---|---|---|
| T0 | A | orchestrator | ESLint changes, lint-guard snippets, CI `hook-compat` job, root `awaiting` script (§4) | — | `pnpm lint` passes; guard self-test fires on the new snippets |
| T1 | A | eta-engine | Core contracts: `events/names.ts`, `events/types.ts`, `turns/types.ts`, `paths.ts` (implemented + tested); `parse.ts`, `prompt-features.ts`, `sanitize.ts`, `tool-input.ts`, `turns/machine.ts`, `ingest/reorder.ts` as signature stubs that throw; `index.ts` exports; fixtures JSON | — | core typecheck + `paths.test.ts` pass |
| T2 | B ∥ | eta-engine | Implement parse / features / sanitize / tool-input + tests | T1 | core tests green |
| T3 | B ∥ | eta-engine (2nd agent ok) | Implement turn machine + reorder + tests | T1 | core tests green |
| T4 | B ∥ | hooks-integrator | Hook script + `node:test` suite + `hooks/package.json` | T0 | `node --test hooks/test/hook.test.js` green on Node 22 locally; CI compat on 20 |
| T5 | B ∥ | hooks-integrator (2nd agent ok) | CLI: args, io, merge, backup, hook copy, install/uninstall, doctor (fake server in tests), vite bin build, fixtures | T1 (`HOOK_EVENT_NAMES`, `resolveDataDir`) | `pnpm --filter @awaiting/cli test` green |
| T6 | B ∥ | desktop-ui | `paths.ts`, `db.ts`, `store/*` + tests | T1 | desktop vitest green |
| T7 | B ∥ | desktop-ui (2nd agent ok) | Shared debug types + validators, bridge v2, preload, renderer debug view + state tests (static mock data until T10), `smoke.ts` bridge check, vitest include | T1 | desktop typecheck + tests green |
| T8 | C ∥ | hooks-integrator | `server/*` (http, auth, runtime-file, doctor-ping) + http/bind/runtime-file tests | T2 | tests green |
| T9 | C ∥ | desktop-ui | `pipeline/ingestor.ts` + replay/restart tests | T3, T6 | tests green |
| T10 | D ∥ | desktop-ui | `index.ts` wiring, `ipc/debug.ts`, timers, `run-app-smoke.mjs` temp `AWAITING_HOME`, `export-events.mjs` | T7, T8, T9 | `smoke:app` passes; `pnpm dev` shows live rows when the hook is spawned by hand with a fixture payload |
| T11 | D ∥ | hooks-integrator | `server/e2e/privacy.e2e.test.ts`, `pipeline.e2e.test.ts`; doctor round-trip against the real server | T8, T9 | e2e green |
| T12 | E | orchestrator | Integrate: clean install, `pnpm lint`, `pnpm test`, `smoke:app`; CLAUDE.md Commands (`pnpm awaiting …`, `pnpm --filter @awaiting/cli build`, hooks test); SPEC.md fixes per §10 | T0–T11 | actual outputs recorded |
| T13 | E | orchestrator + user | Manual check §6.2; commit recording fixture | T12 | steps 1–13 logged in PROGRESS.md |
| T14 | E | reviewer | Review against hard rules and §6.3 | T13 | PASS |

Parallel groups:
- **B** = T2 ∥ T3 ∥ T4 ∥ T5 ∥ T6 ∥ T7
- **C** = T8 ∥ T9
- **D** = T10 ∥ T11

Disjointness:
- T2 and T3 share only `index.ts`, which T1 finalizes.
- T6 and T7 split `apps/desktop` into `store/`/`paths`/`db` vs. `shared/`/`preload`/`renderer`/`smoke`/`vitest.config`.
- T10 owns `index.ts`/`ipc/`/`scripts/`, T11 owns `server/e2e/`.

## 9. Decisions (defaults chosen), open questions and risks

### 9.1 Decisions (defaults chosen)

| # | Question | Default | Why | How to reverse |
|---|---|---|---|---|
| D1.1 | Minimum Claude Code version (SPEC Q2) | **≥ 2.1.290**, not enforced. Doctor doesn't run `claude`. The manual check records the tested version | Newest version gate on a field we read (Task `agent_id`, still optional). The docs give no intro version for `async`/`args` | Change `MIN_CLAUDE_CODE` in `cli/src/events.ts` and README |
| D1.2 | `async` (SPEC Q1) | `async: true` on 11 events; **sync** on `Stop`, `StopFailure` (`timeout: 2`), `SessionEnd` (`timeout: 1`) | Zero latency on frequent events; boundary events survive `-p` teardown; 1 s stays under the 1.5 s SessionEnd budget | Edit `desired()` table in `cli/src/events.ts`, rerun `install` (updates in place) |
| D1.3 | Exec form vs. shell form | Exec form `command: "node"`, `args: [path]`; `--shell-form` escape hatch | No quoting of Windows paths; avoids the shell-form failure-blocks rule on Windows without Git Bash; docs recommend `node` + path | `install --shell-form` |
| D1.4 | Data dir | `~/.awaiting` (override `AWAITING_HOME`) for `server.json`, DB and hook copy | Hook and CLI need it without Electron; one place to test, document and delete | Change `resolveDataDir` + hook copy; migrate files |
| D1.5 | Port | Ephemeral `127.0.0.1:0`, published in `server.json`; **no default-port fallback** in the hook | No collisions; with a mandatory token a fallback can't authenticate anyway | Pass `port` to `startEventServer` |
| D1.6 | Token | Mandatory, 256-bit, new each app start, Bearer header, constant-time compare | Blocks injection by other local processes and browsers | Remove the check in `auth.ts` (not recommended) |
| D1.7 | Hook path written to settings | Copy to `<dataDir>/hook/awaiting-hook.js` (+ commonjs `package.json`); `--hook-path` for dev; uninstall keeps the copy unless `--purge` | Stable across repo/app moves; a missing script would make every event error | `install --hook-path <repo>/hooks/awaiting-hook.js` |
| D1.8 | Identifying our entries | `type: "command"` + `args` element or `command` token with basename `awaiting-hook.js` (case-insensitive); no custom keys | Matches stale paths from earlier installs; unknown keys may fail settings validation | Tighten `isOurs` to exact path |
| D1.9 | "Drop empty groups/arrays only if we created them" | Drop a group only if all its handlers were ours; drop an event array / `hooks` only when our removal emptied it | No install state file needed; result is equal in meaning | Add an install manifest in `<dataDir>` |
| D1.10 | Missing settings file | Create the parent dir + file with only our hooks; no backup | Nothing exists to back up | Refuse to create, require an existing file |
| D1.11 | Backup naming / retention | `settings.json.awaiting-backup-YYYYMMDDTHHmmssSSSZ` (UTC, no colons), `-N` on collision, kept forever | Sortable, Windows-safe; never deletes user-recoverable data | Add pruning in M6 |
| D1.12 | CLI bin | Vite 8 SSR bundle → `packages/cli/dist/awaiting.cjs` (CJS, node20), private, `pnpm awaiting` | Vite is already pinned; no tsx runtime dep; runs on plain `node` | Switch to rolldown/esbuild directly |
| D1.13 | Hook Node floor / test runner | Node ≥ 20, ES2022 syntax, `node:test` suite, CI job on Node 20 × 3 OS | Runs on the user's `node`; the suite itself needs no deps | Change `ecmaVersion` and CI matrix |
| D1.14 | Hook budget | Hard exit 400 ms after start; request timeout 350 ms | Leaves ~200 ms for Node startup inside the 600 ms test bound | Constants at the top of the script |
| D1.15 | Payload size | Hook deletes `tool_response`; server body cap 8 MiB → 413 | Largest, unused field; less sensitive data on loopback | Remove the `delete` line |
| D1.16 | Sanitization | Allowlist (§3.6): Bash → program name + length; task subject → length; `last_assistant_message` not stored; notification message ≤ 200; error first line ≤ 200 | Derived features only (rule 2); M5 decides any opt-in text | Extend the allowlist in `sanitize.ts` |
| D1.17 | Prompt first word | Stored only if it matches `^[a-z][a-z'-]{0,23}$` or a slash command | Keeps tokens, secrets and paths out | Relax the regex |
| D1.18 | Raw-prompt opt-in | Setting `privacy.storeRawPrompt`, default **false**, no UI toggle in M1 (read-only indicator) | No new renderer→main write channel before a settings screen | Settings UI in M4/M5 |
| D1.19 | Interrupt / inactivity | 10 min inactivity (60 min with a tool in flight or awaiting user); interrupted turns end at `lastEventAt`; reopen on continuation (§3.7) | Answers SPEC Q4 for M1; long tools and permission waits aren't cut | `turns.*` settings keys |
| D1.20 | Async ordering | 250 ms reorder buffer by `received_at` | Parallel hook processes can arrive out of order | `windowMs` argument |
| D1.21 | Event retention | Keep all in M1 | No data loss before M2 needs history | Pruning job later |
| D1.22 | Doctor round-trip | Synthetic `AwaitingDoctorPing` through the real hook; nonce kept in server memory 60 s, never in the DB | True end-to-end check; doctor writes no files | Drop step 7 of doctor |
| D1.23 | React ESLint plugins | Deferred to M3 | Keeps M1 dependency changes small | Add `eslint-plugin-react-hooks` |
| D1.24 | Electron `userData` | Unchanged (Chromium profile only); our data in `~/.awaiting` | Moving it risks Electron quirks for no M1 gain | `app.setPath('userData', …)` |
| D1.25 | `CLAUDE_CONFIG_DIR` | Not handled; `--settings` covers custom locations | Not documented on the hooks page (rule 4) | Add after verifying the docs |
| D1.26 | Server ownership | hooks-integrator owns `main/server/**` | Hook↔server contract stays with one owner; disjoint from desktop-ui files | Reassign in a later plan |
| D1.27 | `received_at` key | Top-level `received_at` as SPEC says; the hook overwrites any existing value | Spec wording; Claude Code has no such field today | Rename to `awaiting_received_at` |

### 9.2 Open questions (none blocking)

- **OQ1:** Does `claude --settings <path>` accept a file path? The docs only show a JSON string. Manual step 5 falls back to passing the content.
- **OQ2:** Is `prompt_id` stable across a stop-hook continuation, and is it the new prompt's id on `UserPromptSubmit`? The turn logic uses it only when present and consistent. Confirm in the M1 recording.
- **OQ3:** Does a mid-turn queued message (Enter) or a background-subagent report fire `UserPromptSubmit` while a turn is open? If so, the open turn is wrongly closed as `next_prompt`. Check in the recording, and M2 may refine the rules.
- **OQ4:** Does interactive exit wait for async hooks? Irrelevant for `SessionEnd` (sync), but late async events may be lost. They are then orphans, which is harmless.

### 9.3 Risks

- **R1:** Older Claude Code without `args` support would run bare `node` with the payload on stdin. That gives a SyntaxError, exit 1 and a non-blocking error on every event. Mitigation: D1.1 floor, `--shell-form`, and `uninstall` is instant.
- **R2:** Hook timing on slow Windows CI (Node startup 100–200 ms) could flake the ≤ 600 ms test. Mitigation: 400 ms deadline, max-of-3 measurement. If it is still flaky, lower the deadline rather than relaxing the bound.
- **R3:** A stale `server.json` port reused by another local process would receive event JSON (including prompts). Mitigation: pid liveness check, removal on quit. PID reuse remains a residual risk.
- **R4:** `JSON.parse`/`stringify` reformat the user's settings and lose precision on integers > 2^53. Meaning is otherwise preserved. Mitigation: documented; numbers that large are not expected in settings.
- **R5:** A permission-denied tool never gets a Post event, so its in-flight entry leaks until turn close. The only effect is a later inactivity close (end time is still `lastEventAt`).
- **R6:** Claude Code may write settings.json concurrently. Mitigation: re-read before rename, abort on change.
- **R7:** `received_at` jitter between parallel hook processes is tens of ms. The reorder buffer can't fix events closer than that. Acceptable for turn boundaries.
- **R8:** In `--agent` sessions every event carries `agent_type`. The subagent test uses `knownSubagents` (ids from SubagentStart), not the presence of `agent_id`.

## 10. Spec issues

- **S1:** Common fields. `permission_mode` is "Not all events receive this field" and `prompt_id` is "Absent until the first user input" ([#common-input-fields](https://code.claude.com/docs/en/hooks#common-input-fields)). Both are optional. The docs also add `effort`, `scratchpad_dir` and `session_title`. SPEC should mark `permission_mode?` and `prompt_id?`.
- **S2:** `PostToolUseFailure` and `PermissionRequest` also carry `tool_input`. `PermissionRequest` has `permission_suggestions?` and `mcp_server?`. `StopFailure` also has `last_assistant_message?` (the API error text). `Stop` and `SubagentStop` also have `session_crons`. `SubagentStop` has `last_assistant_message`, `agent_transcript_path` and `stop_hook_active`. SPEC's table omits these. None are needed in M1 beyond the sanitized summaries.
- **S3:** `UserPromptSubmit` is not only "the user submits a prompt". It also fires for scheduled tasks / `/loop`, background-subagent reports, cross-session messages and Code Mode output ([#userpromptsubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit)). "Turn start" therefore includes non-user turns, and the interrupt rule can misfire (OQ3).
- **S4:** `agent_needs_input` is about background sessions in agent view, teammate setup questions and the auto-mode billing notice ([#notification](https://code.claude.com/docs/en/hooks#notification)), not always "this session needs you". Also `permission_prompt` fires only after ~6 s and `idle_prompt` ~60 s after the response. These matter for M2/M4. SPEC should note them.
- **S5:** `timeout` is **not enforced** for `async: true` hooks ([#common-fields](https://code.claude.com/docs/en/hooks#common-fields)), so the SPEC's "async plus a short timeout" gives no Claude-side limit. The hook's own deadline is the protection. Async hooks are also killed at `-p` teardown, which is why D1.2 keeps the boundary events sync.
- **S6:** A per-hook `timeout` on `SessionEnd` **raises** the shared 1.5 s budget (up to 60 s) ([#sessionend](https://code.claude.com/docs/en/hooks#sessionend)). Our `SessionEnd` timeout must stay ≤ 1 s, and SPEC should say so.
- **S7:** SPEC doesn't mention the Windows-without-Git-Bash rule ([#failed-hooks-on-windows-without-git-bash](https://code.claude.com/docs/en/hooks#failed-hooks-on-windows-without-git-bash)): a failing shell-form `PreToolUse`/`PermissionRequest` hook can block tool calls. This is the main reason for exec form, and SPEC should record it.
- **S8:** The port file is described as "falling back to a default" and "a missing file means it exits 0 at once". These contradict each other. With a mandatory token (SPEC calls it optional) a fallback port can't authenticate. Plan: no fallback, token mandatory.
- **S9:** "Backup before every write" can't apply when `settings.json` doesn't exist. Plan: no backup in that case (D1.10). SPEC should say "before every write to an existing file".
- **S10:** "Drop event arrays or matcher groups that end up empty only if we created them" needs install state that doesn't exist. Plan: inferred rule D1.9 (we only ever create our own groups), equal in meaning.
- **S11:** SPEC says the hook POSTs the stdin JSON as-is. The plan drops `tool_response` in the hook (D1.15).
- **S12:** SPEC open question 1 can't be fully answered from the docs. They document `async` and `args` with no introduction version, and the changelog is too large to verify. D1.1/D1.2/D1.3 pick defaults, with a `--shell-form` fallback.
- **S13:** CLAUDE.md says the hook runs on "whatever `node` is on the user's PATH". Claude Code's native installer doesn't require Node, so some users may have no `node`. Doctor reports it. SPEC/README (M6) should state that Node ≥ 20 is required for awaiting.

