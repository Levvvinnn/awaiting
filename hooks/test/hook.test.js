'use strict';
// Spawns the real hook script and checks it is harmless in every case (CLAUDE.md rule 1,
// docs/plans/01-hook-pipeline.md §6.1): exit 0, nothing on stdout or stderr, bounded time.
// Every case uses a temp AWAITING_HOME and a temp HOME/USERPROFILE; the real ~/.awaiting and
// ~/.claude are never touched.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const HOOK = path.resolve(__dirname, '..', 'awaiting-hook.js');
const FAKE_SERVER = path.join(__dirname, 'fake-server.js');
const HANG_BOUND_MS = 600;
const TOKEN = 'ab'.repeat(32);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-hook-test-'));
let dirCounter = 0;

function freshDir() {
  dirCounter += 1;
  const dir = path.join(tmpRoot, String(dirCounter));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeServerJson(dataDir, fields) {
  fs.mkdirSync(dataDir, { recursive: true });
  const info = { version: 1, port: 1, token: TOKEN, pid: process.pid, startedAt: Date.now() };
  fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ ...info, ...fields }));
}

/**
 * Starts hooks/test/fake-server.js in a child process (separate event loop, killed on close).
 * @param {'ok' | 'error' | 'hang'} [mode]
 */
function startFakeServer(mode = 'ok') {
  const child = fork(FAKE_SERVER, [mode, '5000'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let nextId = 0;
  /** @type {Map<number, (reqs: any[]) => void>} */
  const pending = new Map();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (msg) => {
      if (msg.type === 'listening') {
        resolve({
          port: msg.port,
          /** @returns {Promise<{ method: string, url: string, headers: Record<string, string>, body: string }[]>} */
          requests: () =>
            new Promise((done) => {
              nextId += 1;
              pending.set(nextId, done);
              child.send({ type: 'requests', id: nextId });
            }),
          close: () =>
            new Promise((done) => {
              if (child.exitCode !== null || child.signalCode !== null) return done();
              child.once('exit', () => done());
              child.kill();
            }),
        });
      } else if (msg.type === 'requests') {
        const done = pending.get(msg.id);
        pending.delete(msg.id);
        if (done) done(msg.requests);
      }
    });
  });
}

const VALID_EVENT = {
  session_id: 'abc123',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp/project',
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: '/tmp/project/file.txt', content: 'file content' },
  tool_response: { filePath: '/tmp/project/file.txt', success: true },
  tool_use_id: 'toolu_01ABC123',
};
const VALID_INPUT = JSON.stringify(VALID_EVENT);

/**
 * @param {{ awaitingHome?: string | null, home?: string, input?: string | Buffer, keepStdinOpen?: boolean }} opts
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, ms: number }>}
 */
function runHook(opts) {
  const home = opts.home ?? freshDir();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.AWAITING_HOME;
  if (opts.awaitingHome !== null && opts.awaitingHome !== undefined) {
    env.AWAITING_HOME = opts.awaitingHome;
  }
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    // The hook may exit before reading stdin (that is the point of several cases).
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr, ms: performance.now() - t0 });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    if (!opts.keepStdinOpen) child.stdin.end();
  });
}

function assertHarmless(r) {
  assert.equal(r.signal, null, 'hook was killed by a signal');
  assert.equal(r.code, 0, 'hook must exit 0');
  assert.equal(r.stdout, '', 'hook must write nothing to stdout');
  assert.equal(r.stderr, '', 'hook must write nothing to stderr');
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('hook against a running server', () => {
  /** @type {Awaited<ReturnType<typeof startFakeServer>>} */
  let server;
  before(async () => {
    server = await startFakeServer('ok');
  });
  after(() => server.close());

  function dataDirWithServer() {
    const dataDir = freshDir();
    writeServerJson(dataDir, { port: server.port });
    return dataDir;
  }

  /** Runs the hook and returns only the requests it caused. */
  async function runCounting(opts) {
    const before = (await server.requests()).length;
    const r = await runHook(opts);
    const reqs = (await server.requests()).slice(before);
    return { r, reqs };
  }

  test('(7) valid event: exactly one POST /events with token, without tool_response', async () => {
    const dataDir = dataDirWithServer();
    const t0 = Date.now();
    const { r, reqs } = await runCounting({ awaitingHome: dataDir, input: VALID_INPUT });
    const t1 = Date.now();
    assertHarmless(r);

    assert.equal(reqs.length, 1);
    const [req] = reqs;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/events');
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.host, `127.0.0.1:${server.port}`);
    assert.equal(req.headers['x-awaiting-hook'], '1');
    assert.equal(Number(req.headers['content-length']), Buffer.byteLength(req.body));

    const body = JSON.parse(req.body);
    assert.equal(typeof body.received_at, 'number');
    assert.ok(body.received_at >= t0 && body.received_at <= t1, 'received_at within run window');
    const expected = { ...VALID_EVENT, received_at: body.received_at };
    delete expected.tool_response;
    assert.deepEqual(body, expected);
  });

  test('valid event with a leading UTF-8 BOM is still delivered (PowerShell pipes)', async () => {
    const dataDir = dataDirWithServer();
    const { r, reqs } = await runCounting({ awaitingHome: dataDir, input: '\uFEFF' + VALID_INPUT });
    assertHarmless(r);
    assert.equal(reqs.length, 1);
    assert.equal(JSON.parse(reqs[0].body).session_id, VALID_EVENT.session_id);
  });

  test('received_at from the input is overwritten', async () => {
    const dataDir = dataDirWithServer();
    const input = JSON.stringify({ ...VALID_EVENT, received_at: 1 });
    const { r, reqs } = await runCounting({ awaitingHome: dataDir, input });
    assertHarmless(r);
    assert.equal(reqs.length, 1);
    assert.ok(JSON.parse(reqs[0].body).received_at > 1);
  });

  test('(5) empty stdin: no request', async () => {
    const { r, reqs } = await runCounting({ awaitingHome: dataDirWithServer(), input: '' });
    assertHarmless(r);
    assert.equal(reqs.length, 0);
  });

  test('(6) garbage stdin: no request', async () => {
    const input = '{"session_id": nope \u0000';
    const { r, reqs } = await runCounting({ awaitingHome: dataDirWithServer(), input });
    assertHarmless(r);
    assert.equal(reqs.length, 0);
  });

  test('(12) JSON array: no request', async () => {
    const input = JSON.stringify([VALID_EVENT]);
    const { r, reqs } = await runCounting({ awaitingHome: dataDirWithServer(), input });
    assertHarmless(r);
    assert.equal(reqs.length, 0);
  });

  test('non-object JSON and missing required fields: no request', async () => {
    const dataDir = dataDirWithServer();
    const inputs = [
      'null',
      '42',
      '"PostToolUse"',
      JSON.stringify({ session_id: 'abc123' }),
      JSON.stringify({ hook_event_name: 'Stop' }),
      JSON.stringify({ hook_event_name: 7, session_id: 'abc123' }),
    ];
    for (const input of inputs) {
      const { r, reqs } = await runCounting({ awaitingHome: dataDir, input });
      assertHarmless(r);
      assert.equal(reqs.length, 0, input);
    }
  });

  test('(8) stdin left open: exits within the bound and sends nothing', async () => {
    const { r, reqs } = await runCounting({
      awaitingHome: dataDirWithServer(),
      input: '{"session_id":',
      keepStdinOpen: true,
    });
    assertHarmless(r);
    assert.ok(r.ms <= HANG_BOUND_MS, `took ${Math.round(r.ms)} ms (bound ${HANG_BOUND_MS} ms)`);
    assert.equal(reqs.length, 0);
  });

  test('(11) stdin over 16 MiB: no request', async () => {
    const input = Buffer.alloc(16 * 1024 * 1024 + 1024, 0x20);
    const { r, reqs } = await runCounting({ awaitingHome: dataDirWithServer(), input });
    assertHarmless(r);
    assert.equal(reqs.length, 0);
  });

  test('(10) dead pid in server.json: no request', async () => {
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const deadPid = dead.pid;
    await new Promise((resolve) => dead.on('close', resolve));
    const dataDir = freshDir();
    writeServerJson(dataDir, { port: server.port, pid: deadPid });
    const { r, reqs } = await runCounting({ awaitingHome: dataDir, input: VALID_INPUT });
    assertHarmless(r);
    assert.equal(reqs.length, 0);
  });

  test('(9) malformed server.json: no request', async () => {
    const pid = process.pid;
    const port = server.port;
    const variants = [
      '',
      '{not json',
      '[]',
      'null',
      JSON.stringify({ version: 1, port: 0, token: TOKEN, pid }),
      JSON.stringify({ version: 1, port: 70000, token: TOKEN, pid }),
      JSON.stringify({ version: 1, port: String(port), token: TOKEN, pid }),
      JSON.stringify({ version: 1, port, token: 'short', pid }),
      JSON.stringify({ version: 1, port, token: 'AB'.repeat(32), pid }),
      JSON.stringify({ version: 1, port, token: TOKEN }),
      JSON.stringify({ version: 1, port, token: TOKEN, pid: -1 }),
    ];
    for (const content of variants) {
      const dataDir = freshDir();
      fs.writeFileSync(path.join(dataDir, 'server.json'), content);
      const { r, reqs } = await runCounting({ awaitingHome: dataDir, input: VALID_INPUT });
      assertHarmless(r);
      assert.equal(reqs.length, 0, content);
    }
  });

  test('data dir defaults to <home>/.awaiting when AWAITING_HOME is unset, empty or blank', async () => {
    for (const awaitingHome of [null, '', '  ']) {
      const home = freshDir();
      writeServerJson(path.join(home, '.awaiting'), { port: server.port });
      const { r, reqs } = await runCounting({ awaitingHome, home, input: VALID_INPUT });
      assertHarmless(r);
      assert.equal(reqs.length, 1, `AWAITING_HOME=${JSON.stringify(awaitingHome)}`);
    }
  });

  test('AWAITING_HOME wins over <home>/.awaiting', async () => {
    const home = freshDir();
    const dataDir = freshDir();
    writeServerJson(path.join(home, '.awaiting'), { port: server.port, token: 'cd'.repeat(32) });
    writeServerJson(dataDir, { port: server.port });
    const { r, reqs } = await runCounting({ awaitingHome: dataDir, home, input: VALID_INPUT });
    assertHarmless(r);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].headers.authorization, `Bearer ${TOKEN}`);
  });
});

describe('hook without a usable server', () => {
  test('(1) no server.json: exits 0 at once', async () => {
    assertHarmless(await runHook({ awaitingHome: freshDir(), input: VALID_INPUT }));
  });

  test('(1b) data dir does not exist', async () => {
    const dataDir = path.join(freshDir(), 'missing');
    assertHarmless(await runHook({ awaitingHome: dataDir, input: VALID_INPUT }));
  });

  test('(2) server down (port of a closed server)', async () => {
    const s = await startFakeServer('ok');
    const port = s.port;
    await s.close();
    const dataDir = freshDir();
    writeServerJson(dataDir, { port });
    const r = await runHook({ awaitingHome: dataDir, input: VALID_INPUT });
    assertHarmless(r);
    assert.ok(r.ms <= HANG_BOUND_MS, `took ${Math.round(r.ms)} ms`);
  });

  test('(3) server hangs 5 s: finishes within 600 ms from spawn (max of 3 runs)', async (t) => {
    const s = await startFakeServer('hang');
    try {
      const dataDir = freshDir();
      writeServerJson(dataDir, { port: s.port });
      const times = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await runHook({ awaitingHome: dataDir, input: VALID_INPUT });
        assertHarmless(r);
        times.push(r.ms);
      }
      assert.equal((await s.requests()).length, 3, 'the request was sent before giving up');
      const max = Math.max(...times);
      const runs = times.map(Math.round).join(', ');
      t.diagnostic(`hang runs (ms): ${runs}`);
      assert.ok(max <= HANG_BOUND_MS, `max ${Math.round(max)} ms > ${HANG_BOUND_MS} (${runs})`);
    } finally {
      await s.close();
    }
  });

  test('(4) 500 response', async () => {
    const s = await startFakeServer('error');
    try {
      const dataDir = freshDir();
      writeServerJson(dataDir, { port: s.port });
      assertHarmless(await runHook({ awaitingHome: dataDir, input: VALID_INPUT }));
      assert.equal((await s.requests()).length, 1);
    } finally {
      await s.close();
    }
  });
});

describe('static guarantees', () => {
  const src = fs.readFileSync(HOOK, 'utf8');

  test('hooks/package.json has no dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    for (const key of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'bundledDependencies',
      'bundleDependencies',
    ]) {
      assert.equal(pkg[key], undefined, `${key} must be absent`);
    }
    assert.equal(pkg.type, 'commonjs');
  });

  test('every require() in the hook is a node: builtin', () => {
    const calls = [...src.matchAll(/\brequire\s*\(\s*(['"`])([^'"`]*)\1\s*\)/g)].map((m) => m[2]);
    assert.ok(calls.length > 0);
    for (const spec of calls) assert.match(spec, /^node:/);
    // No dynamic require() or import() either.
    assert.equal((src.match(/\brequire\s*\(/g) ?? []).length, calls.length);
    assert.doesNotMatch(src, /\bimport\s*\(/);
  });

  test('HOOK_VERSION sits on one line so doctor can read it', () => {
    assert.match(src, /^const HOOK_VERSION = 1;$/m);
  });
});

/**
 * Evaluates the hook source in a sandbox with a stub `require` and a fake `module`, so
 * `require.main !== module` and run() never executes; returns the hook's exports.
 * (A plain require() of a sibling file is rejected by the hooks/ zero-dependency lint rule.)
 */
function loadHookExports() {
  const sandboxModule = { exports: {} };
  const stubRequire = Object.assign(() => ({}), { main: undefined });
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(HOOK, 'utf8')}\n})`,
    { filename: HOOK },
  );
  wrapper(sandboxModule.exports, stubRequire, sandboxModule, HOOK, path.dirname(HOOK));
  return sandboxModule.exports;
}

// Contract table: identical to CONTRACT in packages/core/src/paths.test.ts. resolveDataDir is
// pure string logic; callers path.resolve the result. Keep both tables in sync.
/** @type {[label: string, input: { awaitingHome: string | undefined, homeDir: string, sep: '/' | '\\' }, expected: string][]} */
const CONTRACT = [
  [
    'POSIX default',
    { awaitingHome: undefined, homeDir: '/home/alice', sep: '/' },
    '/home/alice/.awaiting',
  ],
  [
    'POSIX empty override',
    { awaitingHome: '', homeDir: '/home/alice', sep: '/' },
    '/home/alice/.awaiting',
  ],
  [
    'POSIX blank override',
    { awaitingHome: '  \t', homeDir: '/home/alice', sep: '/' },
    '/home/alice/.awaiting',
  ],
  ['POSIX override', { awaitingHome: '/tmp/aw', homeDir: '/home/alice', sep: '/' }, '/tmp/aw'],
  [
    'POSIX relative override kept verbatim',
    { awaitingHome: 'rel/dir', homeDir: '/home/alice', sep: '/' },
    'rel/dir',
  ],
  [
    'POSIX override with spaces kept verbatim',
    { awaitingHome: ' /tmp/a b ', homeDir: '/h', sep: '/' },
    ' /tmp/a b ',
  ],
  [
    'POSIX trailing slash on home',
    { awaitingHome: undefined, homeDir: '/home/alice/', sep: '/' },
    '/home/alice/.awaiting',
  ],
  ['POSIX root home', { awaitingHome: undefined, homeDir: '/', sep: '/' }, '/.awaiting'],
  [
    'POSIX backslash in home is not a separator',
    { awaitingHome: undefined, homeDir: '/home/a\\', sep: '/' },
    '/home/a\\/.awaiting',
  ],
  [
    'Windows default',
    { awaitingHome: undefined, homeDir: 'C:\\Users\\alice', sep: '\\' },
    'C:\\Users\\alice\\.awaiting',
  ],
  [
    'Windows empty override',
    { awaitingHome: '', homeDir: 'C:\\Users\\alice', sep: '\\' },
    'C:\\Users\\alice\\.awaiting',
  ],
  [
    'Windows override',
    { awaitingHome: 'D:\\aw', homeDir: 'C:\\Users\\alice', sep: '\\' },
    'D:\\aw',
  ],
  [
    'Windows trailing backslash',
    { awaitingHome: undefined, homeDir: 'C:\\Users\\alice\\', sep: '\\' },
    'C:\\Users\\alice\\.awaiting',
  ],
  [
    'Windows trailing forward slash',
    { awaitingHome: undefined, homeDir: 'C:/Users/alice/', sep: '\\' },
    'C:/Users/alice\\.awaiting',
  ],
  ['Windows drive root', { awaitingHome: undefined, homeDir: 'C:\\', sep: '\\' }, 'C:\\.awaiting'],
  [
    'Windows UNC home',
    { awaitingHome: undefined, homeDir: '\\\\srv\\home\\alice', sep: '\\' },
    '\\\\srv\\home\\alice\\.awaiting',
  ],
];

describe('resolveDataDir contract (matches packages/core/src/paths.test.ts)', () => {
  const hook = loadHookExports();

  test('exports HOOK_VERSION 1 and resolveDataDir', () => {
    assert.equal(hook.HOOK_VERSION, 1);
    assert.equal(typeof hook.resolveDataDir, 'function');
  });

  for (const [label, input, expected] of CONTRACT) {
    test(label, () => {
      assert.equal(hook.resolveDataDir(input), expected);
    });
  }

  test('throws RangeError on a blank homeDir without an override (caught by the hook)', () => {
    for (const homeDir of ['', '   ']) {
      assert.throws(() => hook.resolveDataDir({ awaitingHome: undefined, homeDir, sep: '/' }), {
        name: 'RangeError',
      });
    }
    assert.equal(hook.resolveDataDir({ awaitingHome: '/x', homeDir: '', sep: '/' }), '/x');
  });
});
