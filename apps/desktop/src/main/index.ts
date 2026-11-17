import { AWAITING_HOME_ENV, elapsedMs, type TurnConfig } from '@awaiting/core';
import { app, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { sqliteVersion } from './db';
import { buildDebugSnapshot, SERVER_NOT_LISTENING } from './ipc/debug-snapshot';
import { registerDebugIpc, type DebugIpc } from './ipc/debug';
import { appDataDir, dbPath, ensureDataDir } from './paths';
import { Ingestor, SWEEP_INTERVAL_MS, TICK_INTERVAL_MS } from './pipeline/ingestor';
import { parseDevOrigin } from './policy';
import { installSecurity } from './security';
import { startAwaitingServer, type AwaitingServer } from './server';
import { runSmoke } from './smoke';
import { openStore } from './store/open';
import { createRepo, type Repo } from './store/repo';
import { createWindows, type AppWindows } from './windows/create';
import type { DebugServerStatus } from '../shared/debug-types';

const startedAtMs = Date.now();
const smoke = process.env['AWAITING_SMOKE'] === '1';
const devOrigin = smoke ? null : parseDevOrigin(process.env['ELECTRON_RENDERER_URL']);

/** Upper bound for the quit-time cleanup, so quitting can never hang. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** Everything started on `ready`, in start order. Fields are set as each step succeeds. */
interface Runtime {
  dataDir?: string;
  db?: Database.Database;
  repo?: Repo;
  ingestor?: Ingestor;
  server?: AwaitingServer | null;
  debugIpc?: DebugIpc;
  timers: NodeJS.Timeout[];
}

const rt: Runtime = { timers: [] };
let windows: AppWindows | undefined;

/** Error text for logs: name and message only, never an event body or a stack with data. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

let shutdownPromise: Promise<void> | null = null;

/** Stops timers, flushes the ingestor, closes the server (removes server.json), closes the DB. Idempotent. */
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    for (const t of rt.timers) clearInterval(t);
    rt.timers = [];
    const flush = (): void => {
      try {
        rt.ingestor?.flush();
      } catch (error) {
        console.error('awaiting: ingestor flush failed:', describe(error));
      }
    };
    flush();
    rt.debugIpc?.dispose();
    if (rt.server) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      });
      try {
        await Promise.race([rt.server.close(), timeout]);
      } catch (error) {
        console.error('awaiting: server close failed:', describe(error));
      } finally {
        clearTimeout(timer);
      }
    }
    // Events accepted while the server was closing are applied before the DB goes away.
    flush();
    try {
      rt.db?.close();
    } catch (error) {
      console.error('awaiting: database close failed:', describe(error));
    }
  })();
  return shutdownPromise;
}

function fail(error: unknown): void {
  console.error('awaiting: startup failed:', describe(error));
  void shutdown().finally(() => {
    app.exit(1);
  });
}

function serverStatus(): DebugServerStatus {
  const s = rt.server;
  return s ? { listening: true, port: s.port } : SERVER_NOT_LISTENING;
}

async function start(): Promise<void> {
  installSecurity(devOrigin);

  // The smoke test must never touch the real ~/.awaiting.
  if (smoke && (process.env[AWAITING_HOME_ENV] ?? '').trim() === '') {
    throw new Error(`smoke mode requires ${AWAITING_HOME_ENV} (a temp dir)`);
  }

  // 1. Data directory (AWAITING_HOME or ~/.awaiting, mode 0700).
  const dataDir = ensureDataDir(appDataDir());
  rt.dataDir = dataDir;

  // 2. Store: open, check the schema version, migrate.
  const db = openStore(dbPath(dataDir));
  rt.db = db;
  const repo = createRepo(db);
  rt.repo = repo;
  console.log(`awaiting: sqlite ${sqliteVersion(db)}, data dir ready`);

  // 3. Ingestor (restores session states itself), then one sweep for turns that went stale
  //    while the app was not running. Updates go to the debug IPC once it exists.
  const turnConfig = (): TurnConfig => ({
    inactivityMs: repo.getSetting('turns.inactivityMs'),
    longInactivityMs: repo.getSetting('turns.longInactivityMs'),
  });
  const ingestor = new Ingestor(
    repo,
    turnConfig,
    Date.now,
    (update) => {
      rt.debugIpc?.push(update);
    },
    {
      onError: (error) => {
        console.error('awaiting: ingest error:', describe(error));
      },
    },
  );
  rt.ingestor = ingestor;
  const swept = ingestor.sweep();
  if (swept > 0) console.log(`awaiting: closed ${String(swept)} stale turn(s) at startup`);

  // 4. Loopback server + server.json. A failure (e.g. a port error) is not fatal: the app runs
  //    and the debug view shows "Server: not listening".
  let server: AwaitingServer | null = null;
  try {
    server = await startAwaitingServer({
      dataDir,
      onEvent: (ev) => {
        ingestor.enqueue(ev);
      },
      keepRawPrompt: () => repo.getSetting('privacy.storeRawPrompt'),
      onError: (error) => {
        console.error('awaiting: server error:', describe(error));
      },
    });
    console.log(`awaiting: server listening on ${server.address}:${String(server.port)}`);
  } catch (error) {
    console.error('awaiting: server not listening:', describe(error));
  }
  // Quit (or a startup failure) while the server was starting: shutdown() has already run
  // without it, so close it here and stop, or server.json would be left behind.
  if (shutdownPromise !== null) {
    await server?.close();
    return;
  }
  rt.server = server;

  // 5. Windows, then the debug IPC (snapshot handler + batched pushes, main window only).
  windows = createWindows(devOrigin);
  rt.debugIpc = registerDebugIpc({
    getMainWindow: () => windows?.main,
    snapshot: () => buildDebugSnapshot({ repo, server: serverStatus, now: Date.now }),
    onError: (message) => {
      console.error(`awaiting: ${message}`);
    },
  });
  windows.loaded
    .then(() => {
      console.log(`awaiting: windows loaded in ${elapsedMs(startedAtMs, Date.now())} ms`);
    })
    .catch(fail);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    windows = createWindows(devOrigin);
    windows.loaded.catch((error: unknown) => {
      console.error('awaiting: window reload failed:', describe(error));
    });
  });

  // 6. Timers. unref: they never keep the process alive on their own.
  const tick = setInterval(() => {
    ingestor.tick();
  }, TICK_INTERVAL_MS);
  const sweep = setInterval(() => {
    ingestor.sweep();
  }, SWEEP_INTERVAL_MS);
  tick.unref();
  sweep.unref();
  rt.timers.push(tick, sweep);

  if (smoke) {
    runSmoke({
      db,
      repo,
      windows,
      dataDir,
      server: rt.server,
      shutdown,
    });
  }
}

// The smoke run is a separate, short-lived process; it must not hand off to a running instance.
if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const main = windows?.main;
    if (main === undefined || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  });

  app.on('window-all-closed', () => {
    // macOS convention: apps stay alive without windows until Cmd+Q.
    if (process.platform !== 'darwin') app.quit();
  });

  // will-quit: flush the ingestor, close the server (removes server.json), then close the DB.
  // The first will-quit is deferred until that async cleanup finishes, then quit continues.
  let cleanedUp = false;
  app.on('will-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    void shutdown().finally(() => {
      cleanedUp = true;
      app.quit();
    });
  });

  app.whenReady().then(start).catch(fail);
}
