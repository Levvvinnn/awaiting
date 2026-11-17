import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHookSource, readJson, runCli } from './harness';
import {
  afterRoundTrip,
  backupsOf,
  expectSameMeaningAndOrder,
  fixturePath,
  makeWorkspace,
} from './semantic';

async function cli(ws: ReturnType<typeof makeWorkspace>, argv: string[]) {
  return runCli([argv[0] ?? '', '--settings', ws.settingsPath, ...argv.slice(1)], {
    dataDir: ws.dataDir,
    hookSource: fakeHookSource(ws.root),
  });
}

describe.each([
  'empty-object.json',
  'unrelated-hooks.json',
  'matcher-groups.json',
  'other-settings.json',
])('install then uninstall on %s', (fixture) => {
  it('restores the original meaning and key order, backing up before each write', async () => {
    const ws = makeWorkspace(fixture);
    const original = readJson(ws.settingsPath);
    expect((await cli(ws, ['install'])).code).toBe(0);
    const installedBytes = fs.readFileSync(ws.settingsPath);
    const res = await cli(ws, ['uninstall']);
    expect(res.code).toBe(0);
    expectSameMeaningAndOrder(readJson(ws.settingsPath), afterRoundTrip(original));
    const backups = backupsOf(ws.settingsPath);
    expect(backups).toHaveLength(2);
    // the uninstall backup holds the installed bytes
    expect(fs.readFileSync(backups[1] ?? '').equals(installedBytes)).toBe(true);
    // the hook copy is kept without --purge
    expect(fs.existsSync(path.join(ws.dataDir, 'hook', 'awaiting-hook.js'))).toBe(true);
  });
});

describe('uninstall', () => {
  it('on a file created by install leaves {}', async () => {
    const ws = makeWorkspace();
    await cli(ws, ['install']);
    expect((await cli(ws, ['uninstall'])).code).toBe(0);
    expect(fs.readFileSync(ws.settingsPath, 'utf8')).toBe('{}\n');
    expect(backupsOf(ws.settingsPath)).toHaveLength(1);
  });

  it('removes only our handler from a user group', async () => {
    const ws = makeWorkspace('user-handler-in-our-group.json');
    expect((await cli(ws, ['uninstall'])).code).toBe(0);
    expect(readJson(ws.settingsPath)).toEqual({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: 'log-prompt.sh' },
              { type: 'command', command: 'after.sh' },
            ],
          },
        ],
      },
    });
    const backups = backupsOf(ws.settingsPath);
    expect(backups).toHaveLength(1);
    expect(
      fs
        .readFileSync(backups[0] ?? '')
        .equals(fs.readFileSync(fixturePath('user-handler-in-our-group.json'))),
    ).toBe(true);
  });

  it('with nothing of ours writes nothing and makes no backup', async () => {
    const ws = makeWorkspace('unrelated-hooks.json');
    const bytes = fs.readFileSync(ws.settingsPath);
    const res = await cli(ws, ['uninstall']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No awaiting entries');
    expect(fs.readFileSync(ws.settingsPath).equals(bytes)).toBe(true);
    expect(backupsOf(ws.settingsPath)).toEqual([]);
  });

  it('with no settings file exits 0 and creates nothing', async () => {
    const ws = makeWorkspace();
    const res = await cli(ws, ['uninstall']);
    expect(res.code).toBe(0);
    expect(fs.existsSync(ws.settingsPath)).toBe(false);
  });

  it('is idempotent', async () => {
    const ws = makeWorkspace('matcher-groups.json');
    await cli(ws, ['install']);
    await cli(ws, ['uninstall']);
    const bytes = fs.readFileSync(ws.settingsPath);
    const backups = backupsOf(ws.settingsPath);
    await cli(ws, ['uninstall']);
    expect(fs.readFileSync(ws.settingsPath).equals(bytes)).toBe(true);
    expect(backupsOf(ws.settingsPath)).toEqual(backups);
  });

  it('--dry-run writes nothing', async () => {
    const ws = makeWorkspace('stale-awaiting-entry.json');
    const bytes = fs.readFileSync(ws.settingsPath);
    const res = await cli(ws, ['uninstall', '--dry-run', '--purge']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('removed');
    expect(res.stdout).toContain('Dry run');
    expect(fs.readFileSync(ws.settingsPath).equals(bytes)).toBe(true);
    expect(backupsOf(ws.settingsPath)).toEqual([]);
  });

  it('--purge deletes only our files in <dataDir>/hook', async () => {
    const ws = makeWorkspace();
    await cli(ws, ['install']);
    const hookDir = path.join(ws.dataDir, 'hook');
    fs.writeFileSync(path.join(ws.dataDir, 'server.json'), '{}');
    await cli(ws, ['uninstall', '--purge']);
    expect(fs.existsSync(hookDir)).toBe(false);
    expect(fs.existsSync(path.join(ws.dataDir, 'server.json'))).toBe(true);
  });

  it('--purge keeps the hook dir if the user put other files in it', async () => {
    const ws = makeWorkspace();
    await cli(ws, ['install']);
    const other = path.join(ws.dataDir, 'hook', 'notes.txt');
    fs.writeFileSync(other, 'mine');
    await cli(ws, ['uninstall', '--purge']);
    expect(fs.readdirSync(path.join(ws.dataDir, 'hook'))).toEqual(['notes.txt']);
  });
});
