import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_EVENT_NAMES } from '../src/events';
import { REAL_HOOK, fakeHookSource, runCli } from './harness';
import { startFakeApp, type FakeApp } from './fake-app-server';
import { makeWorkspace, snapshot } from './semantic';

const apps: FakeApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function app(opts?: Parameters<typeof startFakeApp>[0]): Promise<FakeApp> {
  const a = await startFakeApp(opts);
  apps.push(a);
  return a;
}

/** Workspace with a real install (hook copied from `source`). */
async function installed(source = REAL_HOOK, fixture = 'unrelated-hooks.json') {
  const ws = makeWorkspace(fixture);
  const res = await runCli(['install', '--settings', ws.settingsPath], {
    dataDir: ws.dataDir,
    hookSource: source,
  });
  expect(res.code).toBe(0);
  return ws;
}

async function doctor(
  ws: ReturnType<typeof makeWorkspace>,
  env?: Record<string, string | undefined>,
) {
  return runCli(
    ['doctor', '--settings', ws.settingsPath],
    env ? { dataDir: ws.dataDir, env } : { dataDir: ws.dataDir },
  );
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid ?? 999_999;
}

function rewriteSettings(
  file: string,
  edit: (v: { hooks: Record<string, { hooks: unknown[] }[]> }) => void,
) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    hooks: Record<string, { hooks: unknown[] }[]>;
  };
  edit(v);
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

const hasRealHook = fs.existsSync(REAL_HOOK);

describe('doctor: healthy', () => {
  it.skipIf(!hasRealHook)(
    'exits 0 with a fake app server and the real hook (round trip)',
    async () => {
      const ws = await installed();
      const a = await app();
      a.writeServerJson(ws.dataDir);
      const res = await doctor(ws);
      expect(res.stderr).toBe('');
      expect(res.stdout).not.toMatch(/^FAIL/m);
      expect(res.stdout).toMatch(/^ok {4}node v\d+/m);
      expect(res.stdout).toContain(
        `all ${HOOK_EVENT_NAMES.length} hook events installed exactly once`,
      );
      expect(res.stdout).toContain('round trip: the hook delivered a test event');
      expect(res.stdout).toContain('Claude Code version: not checked');
      expect(res.code).toBe(0);
      // the ping went through the real hook: Bearer auth, session_id present, received_at added
      const ping = a.events.find(
        (e) => (e as { hook_event_name?: string }).hook_event_name === 'AwaitingDoctorPing',
      ) as Record<string, unknown> | undefined;
      expect(typeof ping?.['session_id']).toBe('string');
      expect(typeof ping?.['received_at']).toBe('number');
    },
  );

  it.skipIf(!hasRealHook)('never writes: settings dir and data dir are unchanged', async () => {
    const ws = await installed();
    const a = await app();
    a.writeServerJson(ws.dataDir);
    const settingsDir = path.dirname(ws.settingsPath);
    const before = [snapshot(settingsDir), snapshot(ws.dataDir)];
    const bytes = fs.readFileSync(ws.settingsPath);
    expect((await doctor(ws)).code).toBe(0);
    // also a failing run
    fs.rmSync(path.join(ws.dataDir, 'server.json'));
    const beforeFail = [snapshot(settingsDir), snapshot(ws.dataDir)];
    expect((await doctor(ws)).code).toBe(1);
    expect([snapshot(settingsDir), snapshot(ws.dataDir)]).toEqual(beforeFail);
    expect(beforeFail[0]).toEqual(before[0]);
    expect(fs.readFileSync(ws.settingsPath).equals(bytes)).toBe(true);
  });
});

describe('doctor: FAIL paths exit 1 with a fix: line', () => {
  const expectFail = (res: { code: number; stdout: string }, pattern: RegExp) => {
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(pattern);
    expect(res.stdout).toMatch(/^ {6}fix: /m);
  };

  it('node missing from PATH', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    const emptyBin = path.join(ws.root, 'empty-bin');
    fs.mkdirSync(emptyBin);
    const env: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) if (k.toLowerCase() === 'path') env[k] = undefined;
    env['PATH'] = emptyBin;
    const res = await doctor(ws, env);
    expectFail(res, /^FAIL {2}`node` not found on PATH/m);
  });

  it('settings file missing', async () => {
    const ws = makeWorkspace();
    expectFail(await doctor(ws), /^FAIL .*does not exist/m);
  });

  it('settings file malformed', async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(ws.settingsPath, '{"hooks": [}');
    expectFail(await doctor(ws), /^FAIL .*malformed/m);
  });

  it('missing events', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    rewriteSettings(ws.settingsPath, (v) => {
      delete v.hooks['Stop'];
      delete v.hooks['SessionEnd'];
    });
    const res = await doctor(ws);
    expectFail(res, /^FAIL {2}hook entry Stop: missing/m);
    expect(res.stdout).toMatch(/^FAIL {2}hook entry SessionEnd: missing/m);
  });

  it('duplicated entry', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    rewriteSettings(ws.settingsPath, (v) => {
      const g = v.hooks['Stop']?.at(-1);
      if (g) v.hooks['Stop']?.push(structuredClone(g));
    });
    expectFail(await doctor(ws), /^FAIL {2}hook entry Stop: duplicated \(2 entries\)/m);
  });

  it('entry shape differs (e.g. async removed)', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    rewriteSettings(ws.settingsPath, (v) => {
      const h = v.hooks['PreToolUse']?.at(-1)?.hooks[0] as Record<string, unknown>;
      delete h['async'];
    });
    expectFail(await doctor(ws), /^FAIL {2}hook entry PreToolUse: entry differs/m);
  });

  it('bad hook script path', async () => {
    const ws = makeWorkspace();
    const src = fakeHookSource(ws.root);
    await runCli(['install', '--settings', ws.settingsPath, '--hook-path', src], {
      dataDir: ws.dataDir,
    });
    fs.rmSync(src);
    expectFail(await doctor(ws), /^FAIL {2}hook script .* is missing or unreadable/m);
  });

  it('hook version mismatch', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root, 7));
    expectFail(await doctor(ws), /HOOK_VERSION 7, expected 1/);
  });

  it('missing commonjs package.json next to the hook', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    fs.rmSync(path.join(ws.dataDir, 'hook', 'package.json'));
    expectFail(await doctor(ws), /commonjs/);
  });

  it('no server.json (app not running)', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    const res = await doctor(ws);
    expectFail(res, /^FAIL .*server\.json not found/m);
    expect(res.stdout).toContain('fix: start the awaiting app');
  });

  it('stale server.json (dead pid)', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    const a = await app();
    a.writeServerJson(ws.dataDir, deadPid());
    expectFail(await doctor(ws), /^FAIL .*stale: process \d+ is not running/m);
  });

  it('dead server (live pid, nothing listening)', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    const a = await app();
    a.writeServerJson(ws.dataDir);
    await a.close();
    apps.splice(apps.indexOf(a), 1);
    expectFail(await doctor(ws), /^FAIL {2}GET \/health on 127\.0\.0\.1:\d+ failed/m);
  });

  it('server answers /health with an error', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    const a = await app({ health: 'error' });
    a.writeServerJson(ws.dataDir);
    expectFail(await doctor(ws), /returned 500/);
  });

  it.skipIf(!hasRealHook)('round trip: app never sees the ping', async () => {
    const ws = await installed();
    const a = await app({ recordPings: false });
    a.writeServerJson(ws.dataDir);
    expectFail(await doctor(ws), /^FAIL {2}round trip: the app did not receive/m);
  });

  it('disableAllHooks only warns', async () => {
    const ws = await installed(fakeHookSource(makeWorkspace().root));
    const v = JSON.parse(fs.readFileSync(ws.settingsPath, 'utf8')) as Record<string, unknown>;
    v['disableAllHooks'] = true;
    fs.writeFileSync(ws.settingsPath, JSON.stringify(v));
    const res = await doctor(ws);
    expect(res.stdout).toMatch(/^warn {2}"disableAllHooks": true/m);
  });
});
