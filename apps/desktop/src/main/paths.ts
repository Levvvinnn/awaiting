// Main-process data-directory helpers (plan 01 §3.2). The rule itself is pure and lives in
// @awaiting/core; this module adds `path.resolve`, the directory creation and file names.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AWAITING_HOME_ENV, resolveDataDir } from '@awaiting/core';

/** SQLite database file name inside the data directory. */
export const DB_FILE_NAME = 'awaiting.db';

/** Inputs for `appDataDir`; defaults are the real process environment and home directory. */
export interface AppDataDirInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

/** The absolute data directory: `AWAITING_HOME` if set and non-blank, else `<home>/.awaiting`. */
export function appDataDir(input: AppDataDirInput = {}): string {
  const env = input.env ?? process.env;
  const dir = resolveDataDir({
    awaitingHome: env[AWAITING_HOME_ENV],
    homeDir: input.homeDir ?? homedir(),
    sep: sep === '\\' ? '\\' : '/',
  });
  return resolve(dir);
}

/** Create the data directory (and parents) if missing; mode 0700 on POSIX, profile ACL on Windows. */
export function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** `<dataDir>/awaiting.db`. */
export function dbPath(dataDir: string): string {
  return join(dataDir, DB_FILE_NAME);
}
