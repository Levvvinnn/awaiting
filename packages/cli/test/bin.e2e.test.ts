// Runs the built bundle (dist/awaiting.cjs, produced by `vite build` before vitest) as a child
// process with a temp HOME/USERPROFILE/AWAITING_HOME and AWAITING_FORBID_REAL_SETTINGS=1.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES } from '../src/events';
import { REAL_HOOK } from './harness';
import { afterRoundTrip, backupsOf, makeWorkspace } from './semantic';

const BIN = path.resolve(import.meta.dirname, '..', 'dist', 'awaiting.cjs');

function runBin(args: string[], ws: ReturnType<typeof makeWorkspace>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['AWAITING_HOOK_SOURCE'];
  Object.assign(env, {
    HOME: ws.root,
    USERPROFILE: ws.root,
    AWAITING_HOME: ws.dataDir,
    AWAITING_FORBID_REAL_SETTINGS: '1',
  });
  return spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('dist/awaiting.cjs', () => {
  it('exists and starts with a node shebang', () => {
    expect(fs.readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('--help exits 0, bad usage exits 2', () => {
    const ws = makeWorkspace();
    expect(runBin(['--help'], ws).status).toBe(0);
    expect(runBin([], ws).status).toBe(2);
    expect(runBin(['install', '--purge'], ws).status).toBe(2);
    expect(runBin(['frobnicate'], ws).status).toBe(2);
  });

  it.skipIf(!fs.existsSync(REAL_HOOK))(
    'install → doctor → uninstall on a temp settings file',
    () => {
      const ws = makeWorkspace('matcher-groups.json');
      const original = fs.readFileSync(ws.settingsPath, 'utf8');

      const inst = runBin(['install', '--settings', ws.settingsPath], ws);
      expect(inst.stderr).toBe('');
      expect(inst.status).toBe(0);
      // the bundle found the repo hook via <cliDir>/../../../hooks and copied it
      const copy = path.join(ws.dataDir, 'hook', 'awaiting-hook.js');
      expect(fs.readFileSync(copy).equals(fs.readFileSync(REAL_HOOK))).toBe(true);
      const settings = JSON.parse(fs.readFileSync(ws.settingsPath, 'utf8')) as {
        hooks: Record<string, unknown>;
      };
      for (const e of HOOK_EVENT_NAMES) expect(settings.hooks[e]).toBeDefined();

      const doc = runBin(['doctor', '--settings', ws.settingsPath], ws);
      expect(doc.status).toBe(1); // no app running
      expect(doc.stdout).toContain('fix: start the awaiting app');
      expect(doc.stdout).toContain('hook events installed exactly once');

      const un = runBin(['uninstall', '--settings', ws.settingsPath], ws);
      expect(un.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(ws.settingsPath, 'utf8'))).toEqual(
        afterRoundTrip(JSON.parse(original)),
      );
      expect(backupsOf(ws.settingsPath)).toHaveLength(2);
    },
  );

  it('default settings path is under the (temp) HOME', () => {
    const ws = makeWorkspace();
    const r = runBin(['install', '--dry-run'], ws);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(path.join(ws.root, '.claude', 'settings.json'));
  });

  it('--settings pointed at the real ~/.claude/settings.json exits 2 for every command', () => {
    const ws = makeWorkspace();
    const real = path.join(os.userInfo().homedir, '.claude', 'settings.json');
    for (const cmd of ['install', 'uninstall', 'doctor']) {
      const r = runBin([cmd, '--settings', real], ws);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('refusing');
      expect(r.stdout).toBe('');
    }
  });
});
