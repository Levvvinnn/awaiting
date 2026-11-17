// In-process CLI runner with captured output and an isolated environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/run';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const REAL_HOOK = path.join(REPO_ROOT, 'hooks', 'awaiting-hook.js');
export const CLI_SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');

/** A stand-in hook source so install tests don't depend on the real script's contents. */
export function fakeHookSource(dir: string, version = 1): string {
  const file = path.join(dir, 'src-hook', 'awaiting-hook.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `'use strict';\nconst HOOK_VERSION = ${version};\nprocess.exit(0);\n`);
  return file;
}

export type CliResult = { code: number; stdout: string; stderr: string };

export async function runCli(
  argv: string[],
  opts: {
    dataDir: string;
    hookSource?: string;
    env?: Record<string, string | undefined>;
    now?: number;
    homedir?: string;
    cliDir?: string;
  },
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const env: Record<string, string | undefined> = {
    ...process.env,
    AWAITING_HOME: opts.dataDir,
    AWAITING_FORBID_REAL_SETTINGS: '1',
    AWAITING_HOOK_SOURCE: opts.hookSource,
    ...opts.env,
  };
  const code = await run(argv, {
    env,
    homedir: opts.homedir ?? os.homedir(),
    now: () => opts.now ?? Date.UTC(2026, 10, 17, 12, 34, 56, 789),
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    cliDir: opts.cliDir ?? CLI_SRC_DIR,
  });
  return { code, stdout, stderr };
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
