// Shared wiring for the M1 end-to-end tests (plan 01 §6.1): the real hook script → the real
// loopback server → Ingestor → a file SQLite DB, all inside a temp AWAITING_HOME. This mirrors the
// app wiring (plan 01 §3.11) without Electron. Not a test file itself (no `.test.ts` suffix).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NormalizedEvent, TurnConfig } from '@awaiting/core';
import type Database from 'better-sqlite3';
import type { DebugUpdate } from '../../../shared/debug-types';
import { appDataDir, dbPath, ensureDataDir } from '../../paths';
import { Ingestor, TICK_INTERVAL_MS } from '../../pipeline/ingestor';
import { openStore } from '../../store/open';
import { createRepo, type Repo } from '../../store/repo';
import { startAwaitingServer, type AwaitingServer } from '../index';

/** The real, unbuilt hook script, spawned exactly as Claude Code would (exec form, plan 01 §3.4). */
export const HOOK_PATH = resolve(__dirname, '../../../../../../hooks/awaiting-hook.js');

export interface HookRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns `node hooks/awaiting-hook.js` with `AWAITING_HOME=<home>` and the payload on stdin. */
export function runHook(
  home: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<HookRun> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, AWAITING_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', rej);
    child.on('close', (code, signal) => res({ code, signal, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Polls `cond` every 10 ms until it is true or `timeoutMs` passes (then throws with `what`). */
export async function waitUntil(
  cond: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Every regular file below `dir`, recursively (absolute paths). */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/**
 * Searches every file below `dir` for `needle`: as UTF-8 and UTF-16LE bytes, in its original,
 * lower and upper case, and case-insensitively over a byte-for-byte (latin1) view of each file.
 * Returns the files that contain it, with the encoding that matched.
 */
export function findInFiles(dir: string, needle: string): { file: string; how: string }[] {
  const variants = [...new Set([needle, needle.toLowerCase(), needle.toUpperCase()])];
  const lowerNeedle = needle.toLowerCase();
  const hits: { file: string; how: string }[] = [];
  for (const file of listFilesRecursive(dir)) {
    const bytes = readFileSync(file);
    for (const v of variants) {
      if (bytes.includes(Buffer.from(v, 'utf8'))) hits.push({ file, how: `utf8:${v}` });
      if (bytes.includes(Buffer.from(v, 'utf16le'))) hits.push({ file, how: `utf16le:${v}` });
    }
    // Mixed case: latin1 maps each byte to one char, so lowercasing finds any ASCII casing (UTF-8).
    if (bytes.toString('latin1').toLowerCase().includes(lowerNeedle)) {
      hits.push({ file, how: 'utf8:case-insensitive' });
    }
    // Mixed case in UTF-16LE: decode at both byte alignments.
    for (const offset of [0, 1]) {
      const text = bytes.subarray(offset).toString('utf16le').toLowerCase();
      if (text.includes(lowerNeedle))
        hits.push({ file, how: `utf16le:case-insensitive@${offset}` });
    }
  }
  return hits;
}

export interface Harness {
  /** The temp AWAITING_HOME root (removed by `dispose`). */
  readonly root: string;
  /** The data dir the app resolves from AWAITING_HOME (= `root` here). */
  readonly dataDir: string;
  readonly dbFile: string;
  readonly db: Database.Database;
  readonly repo: Repo;
  readonly ingestor: Ingestor;
  readonly server: AwaitingServer;
  /** Every event the server handed to `onEvent`, in arrival order. */
  readonly received: NormalizedEvent[];
  /** Every `onChange` update the Ingestor emitted. */
  readonly updates: DebugUpdate[];
  /** Errors reported by the server, ingestor or `onEvent`. */
  readonly errors: unknown[];
  /** Sends one payload through the real hook; asserts nothing (callers check `HookRun`). */
  send(payload: Readonly<Record<string, unknown>>): Promise<HookRun>;
  /** Stops the tick timer and the server, flushes the ingestor and closes the DB (checkpoints the WAL). */
  shutdown(): Promise<void>;
  /** `shutdown()` if needed, then deletes the temp directory. */
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /** Set `privacy.storeRawPrompt` before the server starts (default: leave the default, off). */
  readonly storeRawPrompt?: boolean;
  /** Run the app's periodic `tick()` (100 ms) like the real main process (default false). */
  readonly ticking?: boolean;
}

/** Starts the full pipeline in a fresh temp AWAITING_HOME. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'awaiting-e2e-'));
  const dataDir = ensureDataDir(appDataDir({ env: { AWAITING_HOME: root } }));
  const dbFile = dbPath(dataDir);
  const db = openStore(dbFile);
  const repo = createRepo(db, Date.now);
  if (options.storeRawPrompt !== undefined) {
    repo.setSetting('privacy.storeRawPrompt', options.storeRawPrompt);
  }
  const cfg = (): TurnConfig => ({
    inactivityMs: repo.getSetting('turns.inactivityMs'),
    longInactivityMs: repo.getSetting('turns.longInactivityMs'),
  });

  const received: NormalizedEvent[] = [];
  const updates: DebugUpdate[] = [];
  const errors: unknown[] = [];
  const ingestor = new Ingestor(repo, cfg, Date.now, (u) => updates.push(u), {
    onError: (err) => errors.push(err),
  });
  ingestor.sweep();

  let server: AwaitingServer;
  try {
    server = await startAwaitingServer({
      dataDir,
      onEvent: (ev) => {
        received.push(ev);
        ingestor.enqueue(ev);
      },
      keepRawPrompt: () => repo.getSetting('privacy.storeRawPrompt'),
      onError: (err) => errors.push(err),
    });
  } catch (err) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }

  const timer =
    options.ticking === true ? setInterval(() => ingestor.tick(), TICK_INTERVAL_MS) : null;

  let shut: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shut ??= (async () => {
      if (timer !== null) clearInterval(timer);
      await server.close();
      ingestor.flush();
      // better-sqlite3 close() checkpoints the WAL and removes -wal/-shm on the last connection.
      db.close();
    })();
    return shut;
  };

  return {
    root,
    dataDir,
    dbFile,
    db,
    repo,
    ingestor,
    server,
    received,
    updates,
    errors,
    send: (payload) => runHook(root, payload),
    shutdown,
    dispose: async () => {
      await shutdown();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
