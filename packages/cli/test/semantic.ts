// Helpers for "equal in meaning" assertions on settings files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

/** Same values AND the same key order at every level (JSON.stringify is key-order sensitive). */
export function expectSameMeaningAndOrder(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

/**
 * Expected result of install → uninstall. Known D1.9 limit: an event array that was already
 * empty (`"PostToolUse": []`) receives our group on install, and uninstall deletes the array our
 * removal emptied (it can't know it pre-existed without an install manifest). An empty array of
 * matcher groups and a missing key both mean "no hooks", so the result is equal in meaning.
 * Everything else, including key order, must match exactly.
 */
export function afterRoundTrip<T>(original: T): T {
  const copy = structuredClone(original) as { hooks?: Record<string, unknown> };
  const hooks = copy.hooks;
  if (hooks !== undefined && hooks !== null && typeof hooks === 'object') {
    for (const [k, v] of Object.entries(hooks))
      if (Array.isArray(v) && v.length === 0) delete hooks[k];
  }
  return copy as T;
}

export const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'settings');

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

/** Fresh temp workspace: <root>/claude/settings.json (optionally copied from a fixture) + data dir. */
export function makeWorkspace(fixture?: string): {
  root: string;
  settingsPath: string;
  dataDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-cli-'));
  const settingsDir = path.join(root, 'claude');
  fs.mkdirSync(settingsDir);
  const settingsPath = path.join(settingsDir, 'settings.json');
  if (fixture !== undefined) fs.copyFileSync(fixturePath(fixture), settingsPath);
  return { root, settingsPath, dataDir: path.join(root, 'data') };
}

/** Files next to settings.json that are backups. */
export function backupsOf(settingsPath: string): string[] {
  const dir = path.dirname(settingsPath);
  const prefix = `${path.basename(settingsPath)}.awaiting-backup-`;
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => path.join(dir, f));
}

export type Snapshot = Record<string, { size: number; mtimeMs: number; dir: boolean }>;

/** Recursive listing with sizes and mtimes (missing dir → empty). */
export function snapshot(dir: string): Snapshot {
  const out: Snapshot = {};
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const st = fs.statSync(full);
      out[path.relative(dir, full)] = { size: st.size, mtimeMs: st.mtimeMs, dir: e.isDirectory() };
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}
