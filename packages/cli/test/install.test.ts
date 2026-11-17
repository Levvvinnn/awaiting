import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES, desiredHandler } from '../src/events';
import { HOOK_PACKAGE_JSON } from '../src/hook-copy';
import { SettingsChangedError, readSettings, writeSettings } from '../src/settings/io';
import { isOurs } from '../src/settings/merge';
import { backupStamp } from '../src/settings/backup';
import { fakeHookSource, readJson, runCli } from './harness';
import { backupsOf, fixturePath, makeWorkspace } from './semantic';

type Groups = Record<string, { matcher?: string; hooks: unknown[] }[]>;
const hooksOf = (v: unknown): Groups => (v as { hooks: Groups }).hooks;

async function install(ws: ReturnType<typeof makeWorkspace>, extra: string[] = []) {
  return runCli(['install', '--settings', ws.settingsPath, ...extra], {
    dataDir: ws.dataDir,
    hookSource: fakeHookSource(ws.root),
  });
}

describe('install: no settings file', () => {
  it('creates the parent dir and file, copies the hook, makes no backup', async () => {
    const ws = makeWorkspace();
    fs.rmSync(path.dirname(ws.settingsPath), { recursive: true });
    const res = await install(ws);
    expect(res.code).toBe(0);
    const hookPath = path.join(ws.dataDir, 'hook', 'awaiting-hook.js');
    const value = readJson(ws.settingsPath);
    expect(Object.keys(hooksOf(value))).toEqual([...HOOK_EVENT_NAMES]);
    for (const e of HOOK_EVENT_NAMES) {
      expect(hooksOf(value)[e]).toEqual([{ hooks: [desiredHandler(e, hookPath, 'exec')] }]);
    }
    expect(fs.readFileSync(hookPath, 'utf8')).toContain('const HOOK_VERSION = 1;');
    expect(fs.readFileSync(path.join(ws.dataDir, 'hook', 'package.json'), 'utf8')).toBe(
      HOOK_PACKAGE_JSON,
    );
    expect(backupsOf(ws.settingsPath)).toEqual([]);
    expect(fs.readFileSync(ws.settingsPath, 'utf8')).toMatch(/^\{\n {2}"hooks": \{\n[\s\S]*\}\n$/);
  });
});

describe.each([
  'empty-object.json',
  'unrelated-hooks.json',
  'matcher-groups.json',
  'other-settings.json',
  'stale-awaiting-entry.json',
  'user-handler-in-our-group.json',
])('install on %s', (fixture) => {
  it('backs up the exact original bytes before writing', async () => {
    const ws = makeWorkspace(fixture);
    const original = fs.readFileSync(ws.settingsPath);
    const res = await install(ws);
    expect(res.code).toBe(0);
    const backups = backupsOf(ws.settingsPath);
    expect(backups).toHaveLength(1);
    expect(path.basename(backups[0] ?? '')).toBe(
      `settings.json.awaiting-backup-${backupStamp(Date.UTC(2026, 10, 17, 12, 34, 56, 789))}`,
    );
    expect(fs.readFileSync(backups[0] ?? '').equals(original)).toBe(true);
    expect(res.stdout).toContain('Backup:');
  });

  it('installs exactly one of our handlers per event and keeps every user handler', async () => {
    const ws = makeWorkspace(fixture);
    const before = readJson(ws.settingsPath) as { hooks?: Groups };
    await install(ws);
    const after = hooksOf(readJson(ws.settingsPath));
    for (const e of HOOK_EVENT_NAMES) {
      expect(after[e]?.flatMap((g) => g.hooks).filter(isOurs)).toHaveLength(1);
    }
    for (const [event, groups] of Object.entries(before.hooks ?? {})) {
      const userBefore = groups.flatMap((g) => g.hooks).filter((h) => !isOurs(h));
      const userAfter = (after[event] ?? []).flatMap((g) => g.hooks).filter((h) => !isOurs(h));
      expect(userAfter).toEqual(userBefore);
    }
  });

  it('is idempotent: the second run writes nothing and adds no duplicates', async () => {
    const ws = makeWorkspace(fixture);
    await install(ws);
    const bytes = fs.readFileSync(ws.settingsPath);
    const mtime = fs.statSync(ws.settingsPath).mtimeMs;
    const hookMtime = fs.statSync(path.join(ws.dataDir, 'hook', 'awaiting-hook.js')).mtimeMs;
    const backups = backupsOf(ws.settingsPath);
    const res = await install(ws);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('already up to date');
    expect(fs.readFileSync(ws.settingsPath).equals(bytes)).toBe(true);
    expect(fs.statSync(ws.settingsPath).mtimeMs).toBe(mtime);
    expect(fs.statSync(path.join(ws.dataDir, 'hook', 'awaiting-hook.js')).mtimeMs).toBe(hookMtime);
    expect(backupsOf(ws.settingsPath)).toEqual(backups);
  });
});

describe.each([
  'malformed-trailing-comma.txt',
  'malformed-hooks-array.txt',
  'malformed-event-object.txt',
  'malformed-top-level-array.txt',
  'malformed-jsonc-comment.txt',
])('malformed %s', (fixture) => {
  it.each(['install', 'uninstall'])('%s aborts with exit 1, no write, no backup', async (cmd) => {
    const ws = makeWorkspace();
    fs.copyFileSync(fixturePath(fixture), ws.settingsPath);
    const original = fs.readFileSync(ws.settingsPath);
    const res = await runCli([cmd, '--settings', ws.settingsPath], {
      dataDir: ws.dataDir,
      hookSource: fakeHookSource(ws.root),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/malformed/);
    expect(res.stderr).toMatch(/Nothing was written/);
    expect(fs.readFileSync(ws.settingsPath).equals(original)).toBe(true);
    expect(fs.readdirSync(path.dirname(ws.settingsPath))).toEqual(['settings.json']);
    expect(fs.existsSync(ws.dataDir)).toBe(false);
  });
});

describe('install: formatting', () => {
  it('preserves BOM, CRLF and 4-space indent', async () => {
    const ws = makeWorkspace();
    fs.copyFileSync(fixturePath('bom-crlf.txt'), ws.settingsPath);
    expect((await install(ws)).code).toBe(0);
    const text = fs.readFileSync(ws.settingsPath, 'utf8');
    expect(text.startsWith('\uFEFF{\r\n    "model": "opus",\r\n')).toBe(true);
    expect(text.endsWith('}\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    const read = readSettings(ws.settingsPath);
    expect(read.kind === 'ok' && read.indent).toBe(4);
  });

  it('round-trips BOM/CRLF through install + uninstall to the original bytes', async () => {
    const ws = makeWorkspace();
    fs.copyFileSync(fixturePath('bom-crlf.txt'), ws.settingsPath);
    await install(ws);
    await runCli(['uninstall', '--settings', ws.settingsPath], { dataDir: ws.dataDir });
    expect(
      fs.readFileSync(ws.settingsPath).equals(fs.readFileSync(fixturePath('bom-crlf.txt'))),
    ).toBe(true);
  });
});

describe('install: options', () => {
  it('--dry-run writes nothing (no settings, no backup, no hook copy)', async () => {
    const ws = makeWorkspace('unrelated-hooks.json');
    const original = fs.readFileSync(ws.settingsPath);
    const res = await install(ws, ['--dry-run']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Dry run');
    expect(res.stdout).toContain('added');
    expect(fs.readFileSync(ws.settingsPath).equals(original)).toBe(true);
    expect(backupsOf(ws.settingsPath)).toEqual([]);
    expect(fs.existsSync(ws.dataDir)).toBe(false);
  });

  it('--dry-run on a missing file creates nothing', async () => {
    const ws = makeWorkspace();
    expect((await install(ws, ['--dry-run'])).code).toBe(0);
    expect(fs.existsSync(ws.settingsPath)).toBe(false);
  });

  it('--hook-path writes that absolute path and copies nothing', async () => {
    const ws = makeWorkspace('empty-object.json');
    const src = fakeHookSource(ws.root);
    const res = await install(ws, ['--hook-path', src]);
    expect(res.code).toBe(0);
    const h = hooksOf(readJson(ws.settingsPath));
    expect(h['Stop']).toEqual([{ hooks: [desiredHandler('Stop', path.resolve(src), 'exec')] }]);
    expect(fs.existsSync(path.join(ws.dataDir, 'hook'))).toBe(false);
  });

  it('--hook-path to a missing file fails without writing', async () => {
    const ws = makeWorkspace('empty-object.json');
    const res = await install(ws, ['--hook-path', path.join(ws.root, 'nope.js')]);
    expect(res.code).toBe(1);
    expect(fs.readFileSync(ws.settingsPath, 'utf8')).toBe('{}\n');
    expect(backupsOf(ws.settingsPath)).toEqual([]);
  });

  it('--shell-form writes command strings without args', async () => {
    const ws = makeWorkspace();
    await install(ws, ['--shell-form']);
    const hookPath = path.join(ws.dataDir, 'hook', 'awaiting-hook.js').replace(/\\/g, '/');
    expect(hooksOf(readJson(ws.settingsPath))['SessionEnd']).toEqual([
      { hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 1 }] },
    ]);
  });

  it('a second install that changes entries makes a second backup of the then-current bytes', async () => {
    const ws = makeWorkspace('empty-object.json');
    await install(ws);
    const afterFirst = fs.readFileSync(ws.settingsPath);
    const res = await runCli(['install', '--settings', ws.settingsPath, '--shell-form'], {
      dataDir: ws.dataDir,
      hookSource: fakeHookSource(ws.root),
      now: Date.UTC(2026, 10, 17, 12, 34, 56, 789),
    });
    expect(res.code).toBe(0);
    const backups = backupsOf(ws.settingsPath);
    expect(backups).toHaveLength(2);
    // same timestamp → collision suffix
    expect(backups[1]).toMatch(/-2$/);
    expect(fs.readFileSync(backups[1] ?? '').equals(afterFirst)).toBe(true);
  });

  it('refreshes the hook copy when the source changes', async () => {
    const ws = makeWorkspace();
    await install(ws);
    const src = fakeHookSource(ws.root, 1);
    fs.appendFileSync(src, '// v1.1\n');
    await runCli(['install', '--settings', ws.settingsPath], {
      dataDir: ws.dataDir,
      hookSource: src,
    });
    expect(fs.readFileSync(path.join(ws.dataDir, 'hook', 'awaiting-hook.js'), 'utf8')).toContain(
      '// v1.1',
    );
  });

  it('fails without writing when no hook source can be found', async () => {
    const ws = makeWorkspace('empty-object.json');
    const res = await runCli(['install', '--settings', ws.settingsPath], {
      dataDir: ws.dataDir,
      hookSource: path.join(ws.root, 'missing.js'),
      cliDir: path.join(ws.root, 'a', 'b', 'c'),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('not found');
    expect(fs.readFileSync(ws.settingsPath, 'utf8')).toBe('{}\n');
    expect(fs.existsSync(ws.dataDir)).toBe(false);
  });
});

describe('real-settings guard', () => {
  it('refuses the OS user real settings path with exit 2, even via the default', async () => {
    const real = path.join(os.userInfo().homedir, '.claude', 'settings.json');
    const ws = makeWorkspace();
    for (const cmd of ['install', 'uninstall', 'doctor']) {
      const explicit = await runCli([cmd, '--settings', real], { dataDir: ws.dataDir });
      expect(explicit.code).toBe(2);
      expect(explicit.stderr).toContain('refusing');
      const byDefault = await runCli([cmd], {
        dataDir: ws.dataDir,
        homedir: os.userInfo().homedir,
      });
      expect(byDefault.code).toBe(2);
    }
    expect(fs.existsSync(ws.dataDir)).toBe(false);
  });

  it('defaults to <homedir>/.claude/settings.json (the temp home in tests)', async () => {
    const ws = makeWorkspace();
    const res = await runCli(['install', '--dry-run'], {
      dataDir: ws.dataDir,
      hookSource: fakeHookSource(ws.root),
      homedir: ws.root,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(path.join(ws.root, '.claude', 'settings.json'));
  });
});

describe('writeSettings: changed during the operation', () => {
  it('aborts without backup or write when the bytes changed after reading', () => {
    const ws = makeWorkspace('unrelated-hooks.json');
    const read = readSettings(ws.settingsPath);
    if (read.kind !== 'ok') throw new Error('fixture should parse');
    fs.writeFileSync(ws.settingsPath, '{"changed":true}\n');
    expect(() => writeSettings(ws.settingsPath, '{}\n', read, Date.now())).toThrow(
      SettingsChangedError,
    );
    expect(fs.readFileSync(ws.settingsPath, 'utf8')).toBe('{"changed":true}\n');
    expect(backupsOf(ws.settingsPath)).toEqual([]);
    expect(fs.readdirSync(path.dirname(ws.settingsPath))).toEqual(['settings.json']);
  });

  it('aborts when a file appeared where none existed', () => {
    const ws = makeWorkspace();
    fs.writeFileSync(ws.settingsPath, '{"new":1}\n');
    expect(() => writeSettings(ws.settingsPath, '{}\n', null, Date.now())).toThrow(
      SettingsChangedError,
    );
    expect(fs.readFileSync(ws.settingsPath, 'utf8')).toBe('{"new":1}\n');
  });
});
