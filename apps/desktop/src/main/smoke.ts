import { app, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { sqliteVersion } from './db';
import type { AppWindows } from './windows/create';

const TIMEOUT_MS = 30_000;

/** Runs in the renderer's main world; proves the bridge is present and Node is not. */
const RENDERER_PROBE = `(() => ({
  bridgeVersion: window.awaiting && window.awaiting.bridgeVersion,
  bridgeFrozen: Object.isFrozen(window.awaiting),
  requireType: typeof require,
  processType: typeof process,
  hasCspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null,
}))()`;

interface ProbeResult {
  bridgeVersion: unknown;
  bridgeFrozen: unknown;
  requireType: unknown;
  processType: unknown;
  hasCspMeta: unknown;
}

async function probe(name: string, win: BrowserWindow): Promise<void> {
  const r = (await win.webContents.executeJavaScript(RENDERER_PROBE)) as ProbeResult;
  const problems: string[] = [];
  if (r.bridgeVersion !== 1) problems.push('bridge missing');
  if (r.bridgeFrozen !== true) problems.push('bridge not frozen');
  if (r.requireType !== 'undefined') problems.push('require exposed');
  if (r.processType !== 'undefined') problems.push('process exposed');
  if (r.hasCspMeta !== true) problems.push('CSP meta tag missing');
  if (problems.length > 0) throw new Error(`${name}: ${problems.join(', ')}`);
}

async function check(db: Database.Database, windows: AppWindows): Promise<string> {
  await windows.loaded;
  const version = sqliteVersion(db);
  if (windows.main.isDestroyed()) throw new Error('main window destroyed');
  if (windows.avatar.isDestroyed()) throw new Error('avatar window destroyed');
  if (!windows.avatar.isAlwaysOnTop()) throw new Error('avatar is not always on top');
  await probe('main', windows.main);
  await probe('avatar', windows.avatar);
  return version;
}

/**
 * Full-app smoke test (AWAITING_SMOKE=1): prints one AWAITING_SMOKE_OK / AWAITING_SMOKE_FAIL
 * line on stdout and exits. Run by scripts/run-app-smoke.mjs against the production build.
 */
export function runSmoke(db: Database.Database, windows: AppWindows): void {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
  });

  Promise.race([check(db, windows), timeout])
    .then((sqlite) => {
      console.log(`AWAITING_SMOKE_OK ${JSON.stringify({ sqlite, windows: 2 })}`);
      app.exit(0);
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`AWAITING_SMOKE_FAIL ${reason}`);
      app.exit(1);
    })
    .finally(() => {
      clearTimeout(timer);
    });
}
