// Path resolution for the CLI (plan 01 §3.2, §3.10).
import os from 'node:os';
import path from 'node:path';
import { AWAITING_HOME_ENV, resolveDataDir, separatorForPlatform } from '@awaiting/core';

export type Env = Readonly<Record<string, string | undefined>>;

/** Env var set by every test: refuse to touch the real ~/.claude/settings.json. */
export const FORBID_REAL_SETTINGS_ENV = 'AWAITING_FORBID_REAL_SETTINGS';

/** Env var naming the hook script to copy on install (overrides the bundled/repo locations). */
export const HOOK_SOURCE_ENV = 'AWAITING_HOOK_SOURCE';

export function dataDirFor(env: Env, homedir: string): string {
  return path.resolve(
    resolveDataDir({
      awaitingHome: env[AWAITING_HOME_ENV],
      homeDir: homedir,
      sep: separatorForPlatform(process.platform),
    }),
  );
}

export function defaultSettingsPath(homedir: string): string {
  return path.join(homedir, '.claude', 'settings.json');
}

/** Resolved settings path: `--settings` or `<homedir>/.claude/settings.json`. */
export function settingsPathFor(flag: string | null, homedir: string): string {
  return path.resolve(flag ?? defaultSettingsPath(homedir));
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/** True if the guard env var is set and `settingsPath` is the OS user's real settings file. */
export function isForbiddenRealSettings(settingsPath: string, env: Env): boolean {
  if (env[FORBID_REAL_SETTINGS_ENV] !== '1') return false;
  // os.userInfo() reads the account database, not HOME/USERPROFILE, so tests can't redirect it.
  let realHome: string;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    return true; // can't tell: refuse
  }
  return samePath(settingsPath, defaultSettingsPath(realHome));
}

/** Candidate hook sources in priority order (plan §3.10 Hook path resolution). */
export function hookSourceCandidates(env: Env, cliDir: string): string[] {
  const list: string[] = [];
  const fromEnv = env[HOOK_SOURCE_ENV];
  if (fromEnv !== undefined && fromEnv !== '') list.push(path.resolve(fromEnv));
  list.push(path.join(cliDir, 'awaiting-hook.js'));
  list.push(path.resolve(cliDir, '..', '..', '..', 'hooks', 'awaiting-hook.js'));
  return list;
}
