// Stable copy of the hook script in <dataDir>/hook/ (plan 01 §3.10, D1.7).
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_SCRIPT_BASENAME } from './events';
import { atomicWrite } from './settings/io';

/** Sibling package.json: keeps the hook CommonJS even under a `"type": "module"` parent. */
export const HOOK_PACKAGE_JSON = '{\n  "type": "commonjs"\n}\n';

export function hookDirFor(dataDir: string): string {
  return path.join(dataDir, 'hook');
}

export function installedHookPath(dataDir: string): string {
  return path.join(hookDirFor(dataDir), HOOK_SCRIPT_BASENAME);
}

/** First existing regular file among `candidates`, or null. */
export function findHookSource(candidates: readonly string[]): string | null {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // try the next one
    }
  }
  return null;
}

export type CopyResult = { hookPath: string; written: string[] };

function writeIfDifferent(file: string, data: Buffer, written: string[]): void {
  let current: Buffer | null = null;
  try {
    current = fs.readFileSync(file);
  } catch {
    current = null;
  }
  if (current !== null && current.equals(data)) return;
  atomicWrite(file, data);
  written.push(file);
}

/** Copies `source` (+ package.json) into `<dataDir>/hook/`, writing only what differs. */
export function copyHook(source: string, dataDir: string): CopyResult {
  const written: string[] = [];
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = hookDirFor(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hookPath = installedHookPath(dataDir);
  writeIfDifferent(hookPath, fs.readFileSync(source), written);
  writeIfDifferent(path.join(dir, 'package.json'), Buffer.from(HOOK_PACKAGE_JSON, 'utf8'), written);
  return { hookPath, written };
}

/** Deletes our two files in `<dataDir>/hook/` and the dir if it is then empty. */
export function purgeHook(dataDir: string): string[] {
  const dir = hookDirFor(dataDir);
  const removed: string[] = [];
  for (const name of [HOOK_SCRIPT_BASENAME, 'package.json']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // dir missing or not removable: leave it
  }
  return removed;
}
