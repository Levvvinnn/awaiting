# M0: Scaffold — plan

Status: **approved 2026-11-16** with all §9 defaults (Q1 Node 22, Q2 N-API prebuilds, Q3 ESLint 9, Q4 TS 6.0.3, Q5 smoke:app outside `pnpm test`, Q6 Prettier in lint, Q9 tags). Q7 (remote/push) open.

Implementation deviations (recorded at review):
- `pnpm-workspace.yaml`: `better-sqlite3` is in `ignoredBuiltDependencies` (pnpm ran node-gyp despite prebuilds); `esbuild` dropped (not in the tree on Vite 8); `electron` 44 has no postinstall, its binary downloads on first `require('electron')`.
- Vitest configs: core `vitest.config.mjs`, desktop `vitest.config.mts`. Desktop uses `build.rolldownOptions` (Vite 8).
- Desktop `test` calls the smoke launcher directly instead of `pnpm run smoke:sqlite`. Dev CSP also allows `style-src 'unsafe-inline'` (Vite HMR). `frame-ancestors` lives in the dev header only (ignored in a meta CSP).
- Extra files: `src/main/policy.ts` (+ test) and `src/shared/bridge.ts`.
- `.prettierignore` excludes `.claude/` and `**/*.md` (user-authored docs aren't reformatted).
- Lint guards also cover `require()`, dynamic `import()`, `globalThis`/`window` network access, default `electron` imports, and `Date()` / global objects in core. The self-test includes real `.ts` paths.
Spec: `docs/SPEC.md` § M0. Author: architect. Date: 2026-11-16.

---

## 1. Goal

Create an empty but working pnpm monorepo (`apps/desktop`, `packages/core`, `packages/cli`, `hooks/`) where `pnpm install`, `pnpm lint` and `pnpm test` pass on Windows, macOS and Linux, the Electron app opens a normal main window plus a frameless, transparent, always-on-top avatar window, and a smoke test proves `better-sqlite3` loads and opens an in-memory DB under Electron.

## 2. Scope / non-goals

**In scope**

- Root workspace: `package.json` (pinned `packageManager`), `pnpm-workspace.yaml` (with `onlyBuiltDependencies`), `tsconfig.base.json`, ESLint 9 flat config, Prettier, `.gitattributes`, `.editorconfig`, `.gitignore`, `.nvmrc`.
- Lint guard rails: core purity (no I/O, no clock, no randomness) and a repo-wide ban on outbound network modules/globals (H2), plus a self-test that proves the guards fire.
- `packages/core` (`@awaiting/core`) and `packages/cli` (`@awaiting/cli`) with Vitest and one sample test each.
- `hooks/` placeholder package (no script; the real `awaiting-hook.js` is M1).
- `apps/desktop` (`desktop`): electron-vite + React, two windows with secure defaults, strict CSP, narrow preload, navigation/window.open blocked, network requests blocked at the session level.
- `better-sqlite3` loading under Electron, with two smoke tests (headless and full-app).
- `.github/workflows/ci.yml` (3-OS matrix).
- CLAUDE.md "Commands" update (orchestrator).

**Non-goals (later milestones)**

- Hook script, HTTP server, `/events`, SQLite schema/migrations, CLI commands (M1).
- Any ETA logic (M2), avatar art/states/drag/click-through (M3), notifications (M4), recap/stats (M5).
- Packaging, signing, electron-builder, Electron fuses, `npx awaiting` bin (M6).
- React-specific ESLint plugins (add when real UI code lands, M1/M3).
- A build step for `@awaiting/core` / `@awaiting/cli` (consumed as TS source in M0; CLI bundling decided in M1/M6).

## 3. Design

### 3.1 Runtime and toolchain decision (needs user sign-off, see §9 Q1)

The spec says Node 20. As of today (2026-11-16) **Node 20 is end-of-life (EOL 2026-04-30)**, and the current versions of several required tools no longer support it:

| Package | Latest checked on npm registry | `engines.node` |
|---|---|---|
| `better-sqlite3` 13.x | 13.0.3 / 13.2.0 | `>=22` |
| `@electron/rebuild` 4.x | 4.2.1 | `>=22.12.0` |
| `vitest` 5.x | 5.1.0 | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| `vite` 8.x / `electron-vite` 6.x | 8.3.8 / 6.0.0 | `^20.19.0 \|\| >=22.12.0` |

**Default chosen in this plan: Node 22 LTS (>= 22.12.0) for development and CI.** This is a one-line, reversible change (`.nvmrc`, `engines`, CI `node-version`). It satisfies CLAUDE.md's "Node 20+".

Important separation: the dev/CI toolchain Node version is **not** the runtime floor for user-facing scripts. `hooks/awaiting-hook.js` (M1) and the `awaiting` CLI (M1/M6) run on whatever `node` the user has; their supported floor (probably still Node 20+) is decided in the M1 plan and enforced there (e.g. by avoiding newer syntax/APIs and a CI job that runs the hook tests on Node 20). The Electron main process uses Electron's bundled Node (24.x for Electron 44), independent of both.

Fallback if the user insists on Node 20 in CI ("Option B"): Vitest 4.1.12 (supports Node 20), `better-sqlite3` 12.x (V8-ABI, needs `@electron/rebuild` 3.x), and an Electron major that `better-sqlite3` 12.x ships prebuilds for. This reintroduces the Node/Electron ABI conflict (§3.6) and the Linux glibc issue (better-sqlite3 v12.12.0 release notes: Electron v43+ prebuilds need glibc >= 2.41; `ubuntu-latest` 24.04 has 2.39). Not recommended; not detailed further unless chosen.

### 3.2 Pinned versions

All versions below were checked against the npm registry / release pages on 2026-11-16. Dependencies are saved **exact** (no `^`) via `savePrefix: ''` in `pnpm-workspace.yaml`; the committed `pnpm-lock.yaml` pins transitive deps.

| Package | Version | Where | Why this one |
|---|---|---|---|
| pnpm | **10.34.9** (`packageManager: "pnpm@10.34.9"`) | root | Latest of the 10.x line (still patched). pnpm 10's `onlyBuiltDependencies` in `pnpm-workspace.yaml` is well understood; 11/12 changed build-approval config and are not needed for M0. |
| Node | **22.x** (CI `node-version: 22`, `.nvmrc` `22`, `engines.node: ">=22.12.0"`) | root | See §3.1. |
| typescript | **6.0.3** | root | `typescript-eslint` 8.x peer range is `>=4.8.4 <6.1.0`, so TS 7.x (latest 7.0.2, the native port) is not yet usable. |
| eslint | **9.39.5** | root | ESLint 9 as requested (the `maintenance` dist-tag). ESLint 10.15.0 is `latest`; see §9 Q3. |
| @eslint/js | **9.39.5** | root | Matches eslint 9. |
| typescript-eslint | **8.72.2** | root | Released 2026-11-09 (8.73.0 is from today). Peers: eslint ^9, TS <6.1. |
| globals | **17.14.0** | root | Node/browser globals for flat config. |
| prettier | **3.10.1** | root | Latest 3.x. |
| vitest | **5.1.0** | core, cli, desktop | Peers `vite ^6.4 \|\| ^7 \|\| ^8`. |
| electron | **44.11.3** | desktop | N-1 stable major (44.0.0 on 2026-08-24; 45 is newest, 43–45 are supported). Latest 44.x patch for security fixes. Bundles Node 24.22.2, Chrome 152. |
| electron-vite | **6.0.0** | desktop | Released 2026-10-14; supports Vite 6/7/8 (Rolldown). `engines: ^20.19 \|\| >=22.12`. |
| vite | **8.3.8** | desktop | Latest; 2026-11-09 security backports went to every line, so take the newest patch. |
| @vitejs/plugin-react | **6.3.0** | desktop | Requires `vite ^8`; its other peers are optional. |
| react, react-dom | **19.3.1** | desktop | |
| @types/react, @types/react-dom | **19.3.0** (react-dom: latest 19.3.x, exact in lockfile) | desktop | |
| @types/node | latest **22.x** (exact in lockfile) | cli, desktop | Matches dev Node. Do not use 26.x (current `latest`) types. |
| better-sqlite3 | **13.0.3** | desktop | First N-API line (since 13.0.0): prebuilt binaries ship inside the package and work across Node and Electron versions. Avoid 13.1.0 (release notes: "NOT A VIABLE RELEASE", Windows arm64) and 13.1.1 / 13.2.0 (published 2026-11-11/14, too fresh). |
| @types/better-sqlite3 | latest 7.6.x | desktop | |
| @electron/rebuild | **4.2.1** | desktop (devDep) | **Fallback only**, see §3.6. |

GitHub Actions: `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` (see §9 Q9 on SHA pinning).

### 3.3 Workspace layout

```
/
  package.json              private, packageManager, engines, root scripts, root devDeps
  pnpm-workspace.yaml
  pnpm-lock.yaml            committed
  tsconfig.base.json
  eslint.config.mjs         .mjs so the root package.json needs no "type"
  .prettierrc.json  .prettierignore  .editorconfig  .gitattributes  .gitignore  .nvmrc
  scripts/check-lint-guards.mjs
  .github/workflows/ci.yml
  apps/desktop/             name "desktop"
  packages/core/            name "@awaiting/core"
  packages/cli/             name "@awaiting/cli"
  hooks/                    name "@awaiting/hooks" (placeholder)
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - hooks
savePrefix: ''
onlyBuiltDependencies:
  - electron        # postinstall downloads the Electron binary
  - better-sqlite3  # 13.x ships prebuilds; listed so any build/fallback script is allowed
  - esbuild         # transitive in the Vite/electron-vite toolchain
```

Root `package.json` scripts:

| Script | Command |
|---|---|
| `lint` | `eslint . --max-warnings 0 && prettier --check . && node scripts/check-lint-guards.mjs && pnpm -r --if-present typecheck` |
| `test` | `pnpm -r --if-present test` |
| `format` | `prettier --write .` |
| `dev` | `pnpm --filter desktop dev` |

Root has **no** `"type"` field. Consequence relied on in M1: `hooks/awaiting-hook.js` is CommonJS because `hooks/package.json` says `"type": "commonjs"` explicitly, regardless of the root.

Workspace packages are consumed as **TypeScript source** in M0: `@awaiting/core` and `@awaiting/cli` set `"exports": { ".": "./src/index.ts" }`. Vite/electron-vite and Vitest compile them; `tsc --noEmit` typechecks them via `moduleResolution: "Bundler"`. Desktop depends on `"@awaiting/core": "workspace:*"` (declared, imported once in main to prove the seam works).

### 3.4 TypeScript

`tsconfig.base.json` (compilerOptions):

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noPropertyAccessFromIndexSignature": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "target": "ES2023",
  "module": "ESNext",
  "moduleResolution": "Bundler",
  "resolveJsonModule": true,
  "skipLibCheck": true,
  "noEmit": true,
  "types": []          // explicit; each package opts into the types it needs (TS 6 also defaults types to [])
}
```

Per-package:

| File | extends | Notable options |
|---|---|---|
| `packages/core/tsconfig.json` | base | `lib: ["ES2023"]`, `types: []`. **No DOM, no Node types**, so an `import "node:fs"` or `process` use fails typecheck as a second line of defense behind ESLint. `include: ["src"]`. |
| `packages/cli/tsconfig.json` | base | `lib: ["ES2023"]`, `types: ["node"]`. |
| `apps/desktop/tsconfig.json` | — | `files: []`, `references` to the two below (solution file). |
| `apps/desktop/tsconfig.node.json` | base | main + preload + `electron.vite.config.ts` + `vitest.config.ts` + `scripts/`; `types: ["node"]`, `lib: ["ES2023"]`. |
| `apps/desktop/tsconfig.web.json` | base | renderer; `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`, `types: ["vite/client"]`. |

Each package's `typecheck` script: core/cli `tsc -p tsconfig.json`; desktop `tsc -p tsconfig.node.json && tsc -p tsconfig.web.json`.

### 3.5 ESLint + Prettier

`eslint.config.mjs` (flat config), in order:

1. `ignores`: `**/node_modules`, `**/out`, `**/dist`, `**/coverage`, `pnpm-lock.yaml`.
2. `js.configs.recommended`.
3. `tseslint.configs.recommendedTypeChecked` for `**/*.{ts,tsx}` with `parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }`. `tseslint.configs.disableTypeChecked` for `**/*.{js,mjs,cjs}`.
4. Globals: `globals.node` for `scripts/**`, `apps/desktop/scripts/**`, `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`, `packages/cli/**`, config files; `globals.browser` for `apps/desktop/src/renderer/**`; `hooks/**/*.js` gets `sourceType: "commonjs"` + `globals.node`.
5. **H2: repo-wide outbound-network ban** (all files):
   - `no-restricted-imports` paths/patterns: `https`, `node:https`, `http2`, `node:http2`, `tls`, `node:tls`, `dgram`, `node:dgram`, `undici`, `node-fetch`, `axios`, `got`, `ws`, `@sentry/*`, `posthog*`, `mixpanel*`, `@segment/*`; from `electron`: `importNames: ["net", "netLog", "crashReporter", "autoUpdater"]`.
   - `http` / `node:http` and `net` / `node:net` are banned everywhere **except** an override for `apps/desktop/src/main/server/**` and `hooks/**` (both empty in M0; M1 puts the 127.0.0.1 server and the hook there, and M1's bind test enforces loopback).
   - `no-restricted-globals`: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`.
   - `no-restricted-properties`: `navigator.sendBeacon`.
   - Messages cite "H2: no outbound network (CLAUDE.md hard rule 2)".
6. **Core purity** (`packages/core/**`):
   - `no-restricted-imports`: every Node builtin (generated from `builtinModules` of `node:module`, plus pattern `node:*`), `electron`, `better-sqlite3`, `@awaiting/cli`, `desktop`.
   - `no-restricted-globals`: `process`, `require`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `performance`, `crypto`, plus the H2 list.
   - `no-restricted-properties`: `Date.now`, `performance.now`, `Math.random`.
   - `no-restricted-syntax`: `NewExpression[callee.name='Date'][arguments.length=0]` ("pass `now` in").
   - Test files in core (`**/*.test.ts`) keep the same rules (tests pass fixed times too).
7. Prettier: no `eslint-config-prettier` needed (no stylistic rules in the recommended sets). `.prettierrc.json`: `{ "singleQuote": true, "trailingComma": "all", "printWidth": 100, "endOfLine": "lf" }`. `.prettierignore`: `pnpm-lock.yaml`, `out`, `dist`, `coverage`.
8. `.gitattributes`: `* text=auto eol=lf` (otherwise Windows checkouts with `core.autocrlf=true` fail `prettier --check` in CI on windows-latest).

`scripts/check-lint-guards.mjs` (part of `pnpm lint`): uses the ESLint Node API `new ESLint().lintText(code, { filePath })` on in-memory snippets and exits 1 if any expected error is **missing**:

- `packages/core/src/__guard__.ts` with `import fs from 'node:fs'` → error
- same path with `Date.now()` → error; with `new Date()` → error; with `Math.random()` → error
- `packages/core/src/__guard__.ts` with `import Database from 'better-sqlite3'` → error
- `apps/desktop/src/renderer/__guard__.ts` with `fetch('https://x')` → error
- `apps/desktop/src/main/__guard__.ts` with `import https from 'node:https'` → error; with `import { net } from 'electron'` → error
- `packages/core/src/__guard__.ts` with `export const f = (now: number) => now + 1` → **no** error (no false positives)

No files are written; `filePath` is virtual.

### 3.6 better-sqlite3 under Electron vs. Vitest under Node

**With the default (better-sqlite3 13.0.3, N-API):** the native binary is ABI-stable across Node and Electron, so there is **no ABI conflict**: the same `node_modules/better-sqlite3` loads in plain-Node Vitest (M1 DB tests) and in Electron. No rebuild step runs on install. We still prove it under Electron explicitly, because that is the risk the spec cares about.

**Fallback:** `apps/desktop` script `rebuild:native` = `electron-rebuild -f -w better-sqlite3` (`@electron/rebuild`). Use it only if `smoke:sqlite` fails on some platform (e.g. a missing prebuild). Requires a native toolchain (Windows: VS Build Tools + Python). If the fallback ever becomes necessary, the Node/Electron ABI split comes back: DB tests must then run under Electron via `run-electron-node.mjs` (below), never under plain-Node Vitest. Record that in the M1 plan if it happens.

**Bundling:** electron-vite externalizes `dependencies` from the main bundle by default; `better-sqlite3` must be in `apps/desktop` `dependencies` (not devDependencies) so it stays a runtime `require`, never bundled.

### 3.7 Smoke tests

| Name | Command | What it proves | Display needed | In `pnpm test` | In CI |
|---|---|---|---|---|---|
| `smoke:sqlite` | `node scripts/run-electron-node.mjs scripts/smoke-sqlite.mjs` | better-sqlite3 loads in **Electron's** runtime and opens `:memory:` | No | **Yes** (part of desktop `test`) | Yes, all 3 OSes |
| `smoke:app` | `electron-vite build && node scripts/run-app-smoke.mjs` | the real **main process** starts, opens `:memory:` via `src/main/db.ts`, creates both windows, both renderers load, avatar `isAlwaysOnTop()` | Yes (xvfb on Linux) | No (opens a GUI process; keeps `pnpm test` headless) | Yes, separate step, all 3 OSes |

- `scripts/run-electron-node.mjs <script>`: gets the Electron binary path via `createRequire(import.meta.url)('electron')` (the `electron` package returns the binary path when required from Node), spawns it with `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }`, `stdio: 'inherit'`, forwards the exit code; 30 s timeout → kill, exit 1. A Node launcher avoids `VAR=1 cmd` syntax, which fails under cmd.exe on Windows, without adding `cross-env`.
- `scripts/smoke-sqlite.mjs`: asserts `process.versions.electron` is set (proves it runs inside Electron, not plain Node), `new Database(':memory:')`, `create table t(x)`, insert, `select sqlite_version() as v, count(*) ...`, close; prints one line `smoke:sqlite ok electron=<v> sqlite=<v>`; any throw → exit 1.
- `scripts/run-app-smoke.mjs`: spawns Electron on `apps/desktop` with `AWAITING_SMOKE=1`, waits up to 60 s, requires exit 0 and a stdout line starting with `AWAITING_SMOKE_OK`.
- `src/main/smoke.ts`: when `AWAITING_SMOKE === '1'`, after both windows emit `did-finish-load` (windows created with `show: false`), checks DB query result, `avatar.isAlwaysOnTop() === true`, `main` and `avatar` both non-destroyed; prints `AWAITING_SMOKE_OK {"sqlite":"…","windows":2}` and `app.exit(0)`; on any failure or 30 s internal timeout prints `AWAITING_SMOKE_FAIL <reason>` and `app.exit(1)`. (Desktop stdout is fine; the no-stdout rule is for the hook.)
- Linux CI: Ubuntu 24.04 AppArmor blocks Chromium's user-namespace sandbox for an unpackaged Electron, and `chrome-sandbox` in `node_modules` is not SUID. The CI step runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` first, then `xvfb-run -a pnpm --filter desktop smoke:app`. We do **not** pass `--no-sandbox`.

### 3.8 Desktop app (apps/desktop)

**Toolchain: electron-vite 6.** Justification: one config for the three Electron targets (main, preload, renderer) with correct defaults for each (Node/CJS for main and preload, browser for renderer), dependency externalization for native modules like better-sqlite3, multi-page renderer support (needed for two windows), and an integrated dev loop that starts Vite then Electron and restarts main on change. Alternatives: Electron Forge + Vite plugin (heavier, couples to Forge packaging before M6 decides electron-builder vs. Forge), or hand-rolled Vite + `vite-plugin-electron` (more glue to maintain).

`package.json` (no `"type"` field, so main and preload build as CommonJS; a **sandboxed preload cannot be ESM**):

```jsonc
{
  "name": "desktop", "private": true, "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc -p tsconfig.node.json && tsc -p tsconfig.web.json",
    "test": "vitest run && pnpm run smoke:sqlite",
    "smoke:sqlite": "node scripts/run-electron-node.mjs scripts/smoke-sqlite.mjs",
    "smoke:app": "electron-vite build && node scripts/run-app-smoke.mjs",
    "rebuild:native": "electron-rebuild -f -w better-sqlite3"
  }
}
```

`electron.vite.config.ts`:
- `main`: entry `src/main/index.ts`.
- `preload`: entry `src/preload/index.ts`, output CJS.
- `renderer`: root `src/renderer`, `plugins: [react(), cspMetaPlugin()]`, `server: { host: '127.0.0.1', strictPort: true, port: 5173 }` (dev server never on `localhost`/`::`/`0.0.0.0`, in the spirit of H2), multi-page input `{ index: 'src/renderer/index.html', avatar: 'src/renderer/avatar.html' }` (`build.rollupOptions.input`; electron-vite 6 accepts it on Vite 8).
- `cspMetaPlugin` (inline in the config): `transformIndexHtml` with `apply: 'build'` injects the production CSP `<meta http-equiv="Content-Security-Policy">` into both HTML files.

**CSP**

- Production (meta tag, file:// pages):
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`
- Development (response header set in main via `session.defaultSession.webRequest.onHeadersReceived`, only when `ELECTRON_RENDERER_URL` is set): same, except `script-src 'self' 'unsafe-inline'` (React Refresh preamble) and `connect-src ws://127.0.0.1:5173 http://127.0.0.1:5173` (HMR). No `unsafe-eval` in either. The meta tag is not present in dev (both policies would otherwise intersect).

**Windows** (`src/main/windows/options.ts`, pure, Electron imported as `import type` only so it is unit-testable under Vitest):

```ts
import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron';

/** Security-critical webPreferences shared by every window. */
export function secureWebPreferences(preloadPath: string): WebPreferences;
// → { preload, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
//     nodeIntegrationInSubFrames: false, sandbox: true, webSecurity: true,
//     allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
//     navigateOnDragDrop: false, safeDialogs: true }

export function mainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions;
// → { width: 960, height: 640, show: false, title: 'awaiting', autoHideMenuBar: true,
//     webPreferences: secureWebPreferences(preloadPath) }

export function avatarWindowOptions(preloadPath: string): BrowserWindowConstructorOptions;
// → { width: 240, height: 240, show: false, frame: false, transparent: true,
//     backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false,
//     hasShadow: false, focusable: false, fullscreenable: false, maximizable: false,
//     minimizable: false, webPreferences: secureWebPreferences(preloadPath) }
```

`spellcheck: false` matters for H2: Chromium's spellchecker downloads dictionaries from a Google CDN.

`src/main/windows/create.ts`: creates both windows; avatar additionally `setAlwaysOnTop(true, 'floating')`. Loads `ELECTRON_RENDERER_URL + '/index.html' | '/avatar.html'` in dev, `loadFile(join(__dirname, '../renderer/index.html' | 'avatar.html'))` in prod. `ready-to-show` → `show()` (avatar via `showInactive()` so it doesn't steal focus). Position, drag and click-through are M3.

`src/main/security.ts` (called before `app.whenReady` resolves windows):
- `app.on('web-contents-created', (_e, wc) => { wc.setWindowOpenHandler(() => ({ action: 'deny' })); wc.on('will-navigate', blockUnlessSameDocument); wc.on('will-redirect', block); wc.on('will-attach-webview', (e) => e.preventDefault()); })`. Allowed navigation: only the exact loaded URL (dev origin `http://127.0.0.1:5173` or the renderer `file://` paths).
- `session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))` and `setPermissionCheckHandler(() => false)`.
- `session.defaultSession.webRequest.onBeforeRequest` cancels every request whose URL is not `file:`, `devtools:`, `data:` or (dev only) `http(s)/ws://127.0.0.1:5173`. Defense in depth for H2; M1's server is reached by the hook, not the renderer.
- No `shell.openExternal` in M0.

`src/main/index.ts`: `app.requestSingleInstanceLock()` (quit if not acquired; focus main window on `second-instance`); `installSecurity()`; on ready: `openDatabase(':memory:')`, log `sqlite_version()` once, create windows; if `AWAITING_SMOKE === '1'` run `runSmoke()`. Imports one function from `@awaiting/core` (e.g. `elapsedMs`) to prove the cross-package seam bundles. macOS: keep the app alive on `window-all-closed` per platform convention; quit elsewhere.

`src/main/db.ts`:

```ts
import Database from 'better-sqlite3';
/** Open a SQLite database. M0 uses ':memory:' only; file paths and migrations are M1. */
export function openDatabase(path: ':memory:'): Database.Database;
```

`src/preload/index.ts` — the narrowest useful bridge:

```ts
import { contextBridge } from 'electron';
export interface AwaitingBridge { readonly bridgeVersion: 1 }
contextBridge.exposeInMainWorld('awaiting', Object.freeze({ bridgeVersion: 1 } satisfies AwaitingBridge));
```

`src/renderer/env.d.ts` declares `interface Window { readonly awaiting: AwaitingBridge }`. No `ipcRenderer` exposure, no IPC channels in M0.

Renderer:
- `index.html` + `src/main.tsx` + `src/App.tsx`: a static "awaiting — scaffold" heading. **No ETA text of any kind** (H5).
- `avatar.html` + `src/avatar.tsx`: renders nothing (`null`); `html, body { background: transparent; margin: 0; }` in a local CSS file (CSP `style-src 'self'` blocks inline `<style>`).

`vitest.config.ts` (desktop): `environment: 'node'`, `include: ['src/main/**/*.test.ts']`.

### 3.9 packages/core (eta-engine)

- `package.json`: `name: "@awaiting/core"`, `private: true`, `type: "module"`, `exports: { ".": "./src/index.ts" }`, scripts `test: vitest run`, `typecheck: tsc -p tsconfig.json`. devDeps: `vitest`.
- `src/time.ts`:

```ts
/** Milliseconds elapsed from `startedAtMs` to `nowMs` (epoch ms, UTC), clamped to >= 0. */
export function elapsedMs(startedAtMs: number, nowMs: number): number;
```

- `src/index.ts`: `export { elapsedMs } from './time.js';`
- `src/time.test.ts`: normal case (`elapsedMs(1_000, 4_500) === 3_500`), equal times → 0, clock skew (`now < start`) → 0, non-finite input → throws `RangeError` (pick and test one behavior; throwing is the stated choice).
- `vitest.config.ts`: `include: ['src/**/*.test.ts']`.

### 3.10 packages/cli (hooks-integrator)

- `package.json`: `name: "@awaiting/cli"`, `private: true` (until M6), `type: "module"`, `exports: { ".": "./src/index.ts" }`, scripts `test`, `typecheck`. devDeps `vitest`, `@types/node`. **No `bin` yet** (M1).
- `src/commands.ts`:

```ts
export const COMMANDS = ['install', 'uninstall', 'doctor'] as const;
export type Command = (typeof COMMANDS)[number];
/** True when `value` is one of the CLI's subcommands. */
export function isCommand(value: string): value is Command;
```

- `src/commands.test.ts`: each command accepted; `''`, `'Install'`, `'help'` rejected.
- M0 tests touch no filesystem; the "never the real `~/.claude`" rule starts to matter in M1 (`--settings <path>` + temp dirs).

### 3.11 hooks/ (hooks-integrator)

- `hooks/package.json`: `{ "name": "@awaiting/hooks", "private": true, "type": "commonjs", "version": "0.0.0" }`. **No dependencies, ever** (rule 1). No scripts in M0 (`--if-present` skips it).
- No `awaiting-hook.js` yet. The explicit `"type": "commonjs"` guarantees M1's script parses as CJS no matter what the root or a future `package.json` says.

### 3.12 CI (`.github/workflows/ci.yml`)

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  ci:
    strategy:
      fail-fast: false
      matrix: { os: [windows-latest, macos-latest, ubuntu-latest] }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4          # reads packageManager from package.json
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test                      # includes desktop smoke:sqlite (headless)
      - name: App smoke (Linux)
        if: runner.os == 'Linux'
        run: |
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          xvfb-run -a pnpm --filter desktop smoke:app
      - name: App smoke (Windows/macOS)
        if: runner.os != 'Linux'
        run: pnpm --filter desktop smoke:app
```

The Electron binary download during `pnpm install` (electron postinstall, GitHub releases) is install-time package fetching, not an app network call, so H2 does not apply.

### 3.13 Data flow in M0

None. No hook, no server, no persisted data. The only "data" is an in-memory SQLite DB opened and discarded by the main process.

## 4. Files to create or change, by owner

**orchestrator** (root, CI, docs outside `docs/plans/`)
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (generated at integration), `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore` (`node_modules`, `out`, `dist`, `coverage`, `*.log`, `.DS_Store`), `.nvmrc`
- `scripts/check-lint-guards.mjs`
- `.github/workflows/ci.yml`
- `CLAUDE.md`: Commands section only (§8 T7)
- (orchestrator's own tracking: `docs/PROGRESS.md`, optional `README.md` stub. Not required by the spec for M0.)

**eta-engine** (`packages/core`)
- `packages/core/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/time.ts`, `src/time.test.ts`

**hooks-integrator** (`packages/cli`, `hooks/`)
- `packages/cli/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/commands.ts`, `src/commands.test.ts`
- `hooks/package.json`

**desktop-ui** (`apps/desktop`)
- `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`
- `src/main/index.ts`, `src/main/security.ts`, `src/main/db.ts`, `src/main/smoke.ts`, `src/main/windows/options.ts`, `src/main/windows/options.test.ts`, `src/main/windows/create.ts`
- `src/preload/index.ts`
- `src/renderer/index.html`, `src/renderer/avatar.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/avatar.tsx`, `src/renderer/src/avatar.css`, `src/renderer/src/app.css`, `src/renderer/src/env.d.ts`
- `scripts/run-electron-node.mjs`, `scripts/smoke-sqlite.mjs`, `scripts/run-app-smoke.mjs`

## 5. Hook docs referenced

**N/A for M0.** M0 uses no hook events, payload fields, settings.json keys, or exit-code/stdout behavior (rule 4). The only hook-adjacent decision is `hooks/package.json` `"type": "commonjs"`, which is a Node module-resolution concern, not a Claude Code one. The M1 plan must fetch https://code.claude.com/docs/en/hooks and cite sections.

## 6. Test plan

### Automated

| Test | Location | Runs in |
|---|---|---|
| `elapsedMs` cases | `packages/core/src/time.test.ts` | `pnpm test`, CI |
| `isCommand` cases | `packages/cli/src/commands.test.ts` | `pnpm test`, CI |
| Window options: both windows have `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false`, `spellcheck: false`, preload set; avatar has `frame: false`, `transparent: true`, `alwaysOnTop: true`, `skipTaskbar: true`, transparent `backgroundColor`; main window has no `frame: false` | `apps/desktop/src/main/windows/options.test.ts` | `pnpm test`, CI |
| `smoke:sqlite` (Electron runtime, headless) | `apps/desktop/scripts/smoke-sqlite.mjs` | `pnpm test`, CI |
| `smoke:app` (real main process + both windows) | `apps/desktop/scripts/run-app-smoke.mjs` + `src/main/smoke.ts` | CI step; locally on demand |
| Lint guards fire / no false positive | `scripts/check-lint-guards.mjs` | `pnpm lint`, CI |
| `tsc --noEmit` all packages | `typecheck` scripts | `pnpm lint`, CI |
| Prettier check | root | `pnpm lint`, CI |

### Manual (Windows 11 dev machine)

1. `pnpm --filter desktop dev`: main window appears with a frame; avatar window appears with no frame, no visible background (desktop shows through), no taskbar button; click another app and confirm the avatar stays on top.
2. In the main window's DevTools console: `window.awaiting` → `{ bridgeVersion: 1 }`; `typeof require` → `"undefined"`; `window.open('https://example.com')` → `null` and nothing opens; `fetch('https://example.com')` → rejected (CSP / request blocker).
3. Main-process log shows the `sqlite_version()` line once.

### Acceptance criteria mapping

| # | Criterion (SPEC M0) | Verified by | Locally verifiable on Windows? |
|---|---|---|---|
| A1 | `pnpm install` on a clean clone succeeds on all 3 OSes | Windows: fresh `git clone` into a temp dir → `pnpm install --frozen-lockfile`. All OSes: CI install step | Windows yes; **macOS/Linux CI only** |
| A2 | `pnpm test` runs Vitest in core and cli; ≥1 sample passes | `pnpm test` output shows core + cli (and desktop) Vitest suites passing | Yes |
| A3 | `pnpm lint` passes with zero errors | `pnpm lint` exit 0 (ESLint `--max-warnings 0`, Prettier, guard self-test, tsc) | Yes |
| A4 | `pnpm --filter desktop dev` opens both windows; avatar frameless, transparent, stays on top | Automated part: `options.test.ts` + `smoke:app` (`isAlwaysOnTop`, both renderers loaded). Visual part: manual steps 1–2 | Windows yes (manual); **macOS manual not possible locally**; Linux visual not required by spec |
| A5 | Main process opens in-memory SQLite; smoke test proves native module loads under Electron | `smoke:sqlite` (in `pnpm test`) + `smoke:app` (main process) | Yes |
| A6 | CI green on all 3 OSes | GitHub Actions run on push | **No: needs a push to GitHub** (§9 Q7) |
| A7 | CLAUDE.md Commands matches real scripts | Reviewer runs each listed command and diffs against `package.json` scripts | Yes |

## 7. Hard-rule check

1. **Hook harmless:** no hook in M0. `hooks/package.json` has no deps and pins CommonJS for M1.
2. **Privacy:**
   - No server in M0. The electron-vite dev server binds `127.0.0.1` (not `localhost`/`::`).
   - No telemetry/analytics/crash-reporting deps; ESLint bans outbound network modules/globals and Electron `net`/`crashReporter`/`autoUpdater`; guard self-test keeps the ban from rotting.
   - Runtime: CSP `connect-src 'none'` (prod), session request blocker, permission handler denies all, spellcheck off (no dictionary downloads).
   - No prompt text exists in M0.
3. **Installer:** no installer in M0. Nothing touches `~/.claude`.
4. **Hook docs:** N/A (§5).
5. **Ranges:** no estimate UI. Placeholder text contains no times.

Electron secure defaults (desktop-ui role): `contextIsolation`, no `nodeIntegration`, `sandbox`, `webSecurity`, strict CSP without `unsafe-eval`, narrow frozen preload with no IPC, `setWindowOpenHandler` deny, `will-navigate`/`will-redirect`/`will-attach-webview` blocked, no remote URLs, all assets local. Unit-tested in `options.test.ts`.

## 8. Task breakdown

Ordered. Each task has one owner and its own check.

| ID | Owner | Task | Depends on | Done when |
|---|---|---|---|---|
| T0 | orchestrator | `git checkout main` (the session snapshot shows a detached `HEAD`); confirm Node >= 22.12 and `corepack enable` / pnpm 10.34.9 available | — | `node -v`, `pnpm -v` match |
| T1 | orchestrator | Root scaffold: all root files in §4 except `ci.yml`, `pnpm-lock.yaml`, CLAUDE.md. Root devDeps: typescript, eslint, @eslint/js, typescript-eslint, globals, prettier | T0 | `pnpm install` succeeds with zero packages; `npx eslint --print-config eslint.config.mjs` loads |
| T2 | eta-engine | `packages/core` (§3.9) | T1 | `pnpm --filter @awaiting/core test` and `typecheck` pass |
| T3 | hooks-integrator | `packages/cli` + `hooks/package.json` (§3.10–3.11) | T1 | `pnpm --filter @awaiting/cli test` and `typecheck` pass |
| T4 | desktop-ui | `apps/desktop` (§3.6–3.8), including smoke scripts and `options.test.ts` | T1 (and T2 for the `@awaiting/core` import; stub the import until T2 lands, or start T4 after T2) | `pnpm --filter desktop test`, `typecheck`, `smoke:app` pass; manual steps 1–3 done on Windows |
| T5 | orchestrator | CI workflow (§3.12) | T1 | YAML lints (`actionlint` if available, otherwise review) |
| T6 | orchestrator | Integrate: clean `pnpm install` (regenerates and commits `pnpm-lock.yaml`), `pnpm lint`, `pnpm test`, `pnpm --filter desktop smoke:app`, `pnpm dev`; fresh-clone install check (A1, Windows) | T2–T5 | All pass; actual output recorded |
| T7 | orchestrator | Update CLAUDE.md "Commands" to the real scripts: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm format`, `pnpm --filter @awaiting/core test`, `pnpm --filter @awaiting/cli test`, `pnpm --filter desktop dev`, `pnpm --filter desktop smoke:sqlite`, `pnpm --filter desktop smoke:app`, `pnpm --filter desktop rebuild:native` (fallback). Remove the "adjust to actual …" and "Update this section once the scripts exist" notes; note Node 22 | T6 | Reviewer confirms every listed command runs |
| T8 | reviewer | Review against hard rules + A1–A7 | T7 | Verdict PASS |
| T9 | orchestrator (+ user) | Commit; push to GitHub; confirm CI green on 3 OSes (A6) | T8 | Green run URL recorded |

**Parallelism:** after T1, **T2, T3, T5 can run in parallel** (disjoint directories). T4 can run in parallel too if it stubs the `@awaiting/core` import until T2 is done. Caveat: `pnpm install` rewrites the shared `pnpm-lock.yaml`, so **installs must not run concurrently**. Owners serialize their `pnpm install` runs (one at a time), and T6 regenerates the lockfile from scratch before committing.

## 9. Open questions and risks

**Questions needing the user's decision**

- **Q1 (blocking default): Node 22 instead of Node 20 for dev/CI.** Node 20 is EOL and current better-sqlite3 13, @electron/rebuild 4 and Vitest 5 require Node 22. Plan default: Node 22 (>= 22.12). The hook/CLI runtime floor for end users is decided separately in M1.
- **Q2: N-API prebuilt better-sqlite3 instead of an `@electron/rebuild` step.** The spec says "rebuilt for Electron's ABI (electron-rebuild or the equivalent)". 13.x's N-API prebuilds are the equivalent and remove the Node/Electron ABI conflict. `@electron/rebuild` stays as the `rebuild:native` fallback. Default: yes.
- **Q3: ESLint 9 (maintenance line, 9.39.5) vs ESLint 10 (latest 10.15.0).** Requested 9; typescript-eslint 8.72 supports both. Default: 9, and upgrade in a later milestone. Ask how long ESLint 9 maintenance will last before relying on it long-term.
- **Q4: TypeScript 6.0.3, not 7.x.** typescript-eslint doesn't support TS 7 yet (peer `<6.1.0`). Default: 6.0.3.
- **Q5: `smoke:app` stays out of `pnpm test`** (it launches a GUI process) and runs as a separate CI step, with the Linux AppArmor sysctl + xvfb. OK?
- **Q6: Prettier `--check` inside `pnpm lint`?** Default: yes, so the definition of done covers formatting.
- **Q7: GitHub remote and pushing.** A6 can only be verified after a push. Is there a remote, and may the orchestrator push (or will the user)?
- **Q8: Dev machine architecture.** If the Windows 11 machine is arm64, confirm better-sqlite3 13.0.3 ships a win32-arm64 prebuild (13.1.0's notes mention arm64 build failures) before T4.
- **Q9: Pin GitHub Actions to commit SHAs** instead of `@v4` tags (supply-chain hardening)? Default: tags in M0.

**Risks**

- **R1:** better-sqlite3 13's prebuild doesn't load under Electron 44 on some OS ("should theoretically work" per its release notes). Detected by `smoke:sqlite` on all 3 OSes in CI. Mitigation: `rebuild:native` (needs a native toolchain), or move Electron to 45/43.
- **R2:** Linux CI Electron sandbox / xvfb flakiness in `smoke:app`. Mitigation: sysctl step; if it is still flaky, keep `smoke:app` required on Windows/macOS and mark the Linux step `continue-on-error` (decision then recorded in PROGRESS.md).
- **R3:** Windows CRLF breaks `prettier --check`. Mitigated by `.gitattributes` `eol=lf` + Prettier `endOfLine: lf`.
- **R4:** Concurrent `pnpm install` by parallel subagents corrupts the lockfile. Mitigated by serialized installs + T6 regeneration.
- **R5:** `ELECTRON_RUN_AS_NODE` is a dev/test convenience. In packaged builds (M6) the `RunAsNode` Electron fuse should be **disabled**, so the shipped app cannot be used as a generic Node runtime. Carry into the M6 plan.
- **R6:** pnpm's symlinked `node_modules` and electron-builder (M6) don't always mix; may need `node-linker=hoisted` in `apps/desktop` later. No impact on M0.
- **R7:** electron-vite 6 is a fresh major (2026-10-14) on Vite 8 / Rolldown. If multi-page input or the CSP plugin misbehave, fall back to electron-vite 5.0.0 + Vite 7.3.8 + @vitejs/plugin-react 5.x (supported combo per peers).
- **R8:** Dev CSP allows `'unsafe-inline'` scripts for React Refresh. Prod CSP does not; `options.test.ts` doesn't cover CSP, so the reviewer checks the built `out/renderer/*.html` meta tags.
- **R9:** Several pinned versions (vite 8.3.8, Electron 44.11.3, @vitejs/plugin-react 6.3.0) are under two weeks old. They were chosen because they carry security patches. Re-check at T6 if a regression shows up.

**Note on the orchestration brief received mid-planning.** It names plans `docs/plans/M<N>.md` and the hook `hooks/meanwhile-hook.js`. CLAUDE.md wins (the brief itself says its hard rules override): this plan uses `docs/plans/00-scaffold.md` and the project name **awaiting** (`hooks/awaiting-hook.js`). The brief's "pick the safest reversible default and keep going" conflicts with CLAUDE.md's "get agreement on the plan before coding". Q1–Q9 have defaults so work can proceed if the user accepts them.

## 10. Spec issues

- **S1:** SPEC M0 and H6 say CI uses **Node 20**, which is EOL (2026-04-30) and unsupported by current better-sqlite3 / @electron/rebuild / Vitest. Suggest SPEC say "Node 22 LTS for dev/CI; the hook and CLI support Node >= 20 at runtime (M1 decides)". CLAUDE.md "Node 20+" is still accurate.
- **S2:** "better-sqlite3 installed and rebuilt for Electron's ABI" assumes a V8-ABI module. Since 13.0.0 it is N-API with bundled prebuilds, so no rebuild step is needed. Suggest "loads under Electron's runtime, proven by a smoke test".
- **S3:** The A4 criterion ("transparent background and stays above other windows") is partly visual and cannot be fully automated. Plan: automated option and `isAlwaysOnTop` checks plus a manual Windows check; the macOS check is deferred to M3's criterion "on Windows and macOS".
- **S4:** "CI is green on all three OSes" can't be verified before a push, and the repo has no recorded remote. Needs Q7.
- **S5:** Rule 4 citations are N/A for M0 (no hooks used). Not an error, noted for completeness.
- **S6:** SPEC lists `hooks/` as a workspace member without saying it is a package. This plan makes it a dependency-free `@awaiting/hooks` package so it can carry `"type": "commonjs"` and, from M1, its own `test` script.
