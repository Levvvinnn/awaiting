import { existsSync } from 'node:fs';
import { app, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { sqliteVersion } from './db';
import { readServerInfo, serverInfoPath, type AwaitingServer } from './server';
import type { Repo } from './store/repo';
import type { AppWindows } from './windows/create';

const TIMEOUT_MS = 30_000;
/** How long to wait for the driver (scripts/run-app-smoke.mjs) to deliver hook events. */
const EVENT_WAIT_MS = 15_000;
const POLL_MS = 50;
/** Session id the driver uses for its hook payloads. */
export const SMOKE_SESSION_ID = 'awaiting-smoke-session';

/** Runs in the renderer's main world; proves the bridge is present and Node is not. */
const RENDERER_PROBE = `(() => ({
  bridgeVersion: window.awaiting && window.awaiting.bridgeVersion,
  bridgeFrozen: Object.isFrozen(window.awaiting),
  bridgeKeys: Object.keys(window.awaiting).sort().join(','),
  debugGetSnapshot: window.awaiting && window.awaiting.debug ? typeof window.awaiting.debug.getSnapshot : 'absent',
  debugOnUpdate: window.awaiting && window.awaiting.debug ? typeof window.awaiting.debug.onUpdate : 'absent',
  ipcType: typeof window.ipcRenderer,
  requireType: typeof require,
  processType: typeof process,
  hasCspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null,
}))()`;

/** Main window: count validated update pushes that carry events. */
const SUBSCRIBE_UPDATES = `(() => {
  window.__awaitingSmokePushedEvents = 0;
  window.awaiting.debug.onUpdate((u) => { window.__awaitingSmokePushedEvents += u.events.length; });
  return true;
})()`;
const PUSHED_EVENTS = `window.__awaitingSmokePushedEvents`;

/** Main window: the snapshot as the renderer sees it (validated by the preload). */
const SNAPSHOT_PROBE = (
  sessionId: string,
): string => `window.awaiting.debug.getSnapshot().then((s) => ({
  listening: s.server.listening,
  port: s.server.port,
  storeRawPrompt: s.privacy.storeRawPrompt,
  events: s.events.filter((e) => e.sessionId === ${JSON.stringify(sessionId)}).map((e) => e.eventName).sort().join(','),
  turns: s.turns.filter((t) => t.sessionId === ${JSON.stringify(sessionId)}).map((t) => t.status + '/' + t.endReason).join(','),
}))`;

interface ProbeResult {
  bridgeVersion: unknown;
  bridgeFrozen: unknown;
  bridgeKeys: unknown;
  debugGetSnapshot: unknown;
  debugOnUpdate: unknown;
  ipcType: unknown;
  requireType: unknown;
  processType: unknown;
  hasCspMeta: unknown;
}

interface SnapshotProbe {
  listening: unknown;
  port: unknown;
  storeRawPrompt: unknown;
  events: unknown;
  turns: unknown;
}

export interface SmokeContext {
  readonly db: Database.Database;
  readonly repo: Repo;
  readonly windows: AppWindows;
  readonly dataDir: string;
  readonly server: AwaitingServer | null | undefined;
  /** The app's quit-time cleanup (flush, close server, close DB). */
  readonly shutdown: () => Promise<void>;
}

/** The main window gets the debug API; every other window gets the version only. */
async function probe(name: string, win: BrowserWindow, expectDebug: boolean): Promise<void> {
  const r = (await win.webContents.executeJavaScript(RENDERER_PROBE)) as ProbeResult;
  const problems: string[] = [];
  if (r.bridgeVersion !== 2) problems.push(`bridgeVersion ${String(r.bridgeVersion)} (want 2)`);
  const wantKeys = expectDebug ? 'bridgeVersion,debug' : 'bridgeVersion';
  if (r.bridgeKeys !== wantKeys)
    problems.push(`bridge keys ${String(r.bridgeKeys)} (want ${wantKeys})`);
  const wantFn = expectDebug ? 'function' : 'absent';
  if (r.debugGetSnapshot !== wantFn || r.debugOnUpdate !== wantFn) {
    problems.push(
      `debug API ${String(r.debugGetSnapshot)}/${String(r.debugOnUpdate)} (want ${wantFn})`,
    );
  }
  if (r.ipcType !== 'undefined') problems.push('ipcRenderer exposed');
  if (r.bridgeFrozen !== true) problems.push('bridge not frozen');
  if (r.requireType !== 'undefined') problems.push('require exposed');
  if (r.processType !== 'undefined') problems.push('process exposed');
  if (r.hasCspMeta !== true) problems.push('CSP meta tag missing');
  if (problems.length > 0) throw new Error(`${name}: ${problems.join(', ')}`);
}

async function waitFor(what: string, ms: number, cond: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function checkServer(ctx: SmokeContext): AwaitingServer {
  const server = ctx.server;
  if (!server) throw new Error('server not listening');
  if (server.address !== '127.0.0.1') throw new Error(`server bound to ${server.address}`);
  if (!existsSync(serverInfoPath(ctx.dataDir))) throw new Error('server.json missing');
  const info = readServerInfo(ctx.dataDir);
  if (info === null) throw new Error('server.json invalid');
  if (info.port !== server.port) throw new Error('server.json port mismatch');
  if (info.pid !== process.pid) throw new Error('server.json pid mismatch');
  return server;
}

async function check(ctx: SmokeContext): Promise<Record<string, unknown>> {
  const { windows, repo, db } = ctx;
  await windows.loaded;
  const sqlite = sqliteVersion(db);
  if (windows.main.isDestroyed()) throw new Error('main window destroyed');
  if (windows.avatar.isDestroyed()) throw new Error('avatar window destroyed');
  if (!windows.avatar.isAlwaysOnTop()) throw new Error('avatar is not always on top');
  await probe('main', windows.main, true);
  await probe('avatar', windows.avatar, false);

  const server = checkServer(ctx);
  await windows.main.webContents.executeJavaScript(SUBSCRIBE_UPDATES);
  const before = (await windows.main.webContents.executeJavaScript(
    SNAPSHOT_PROBE(SMOKE_SESSION_ID),
  )) as SnapshotProbe;
  if (before.listening !== true || before.port !== server.port) {
    throw new Error('snapshot: server status wrong');
  }
  if (before.storeRawPrompt !== false) throw new Error('snapshot: raw prompt storage not off');

  // Hand over to the driver: it checks server.json from outside and spawns the real hook.
  console.log(
    `AWAITING_SMOKE_READY ${JSON.stringify({ address: server.address, port: server.port })}`,
  );

  // The driver sends UserPromptSubmit then Stop for SMOKE_SESSION_ID: the turn must close done/stop.
  await waitFor('the smoke turn to close as done/stop', EVENT_WAIT_MS, () =>
    repo
      .currentTurns(0)
      .some(
        (t) => t.sessionId === SMOKE_SESSION_ID && t.status === 'done' && t.endReason === 'stop',
      ),
  );
  await waitFor('a debug update push', 2_000, async () => {
    const n = (await windows.main.webContents.executeJavaScript(PUSHED_EVENTS)) as unknown;
    return typeof n === 'number' && n >= 2;
  });
  const after = (await windows.main.webContents.executeJavaScript(
    SNAPSHOT_PROBE(SMOKE_SESSION_ID),
  )) as SnapshotProbe;
  if (after.events !== 'Stop,UserPromptSubmit' || after.turns !== 'done/stop') {
    throw new Error(`snapshot: events=${String(after.events)} turns=${String(after.turns)}`);
  }
  // H3: the raw prompt must not be stored by default.
  const raw = db
    .prepare<[string], { n: number }>(
      'SELECT count(*) AS n FROM turns WHERE session_id = ? AND prompt_text IS NOT NULL',
    )
    .get(SMOKE_SESSION_ID);
  if (raw === undefined || raw.n !== 0) throw new Error('raw prompt text was stored');

  await ctx.shutdown();
  if (existsSync(serverInfoPath(ctx.dataDir))) throw new Error('server.json not removed on quit');
  return { sqlite, windows: 2, address: server.address, events: after.events, turn: after.turns };
}

/**
 * Full-app smoke test (AWAITING_SMOKE=1): prints one AWAITING_SMOKE_OK / AWAITING_SMOKE_FAIL
 * line on stdout and exits. Driven by scripts/run-app-smoke.mjs against the production build.
 */
export function runSmoke(ctx: SmokeContext): void {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
  });

  Promise.race([check(ctx), timeout])
    .then((result) => {
      console.log(`AWAITING_SMOKE_OK ${JSON.stringify(result)}`);
      app.exit(0);
    })
    .catch(async (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`AWAITING_SMOKE_FAIL ${reason}`);
      await ctx.shutdown().catch(() => undefined);
      app.exit(1);
    })
    .finally(() => {
      clearTimeout(timer);
    });
}
