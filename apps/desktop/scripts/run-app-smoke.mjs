// Full-app smoke test: launch the built app (out/) with AWAITING_SMOKE=1 and a temp AWAITING_HOME,
// then drive it end to end. See src/main/smoke.ts for the in-app half.
//
// 1. Wait for the app's AWAITING_SMOKE_READY line (windows + bridge + server checked in-app).
// 2. From outside: the server address is 127.0.0.1 and <temp>/server.json exists, is valid and
//    names that port and the app's pid.
// 3. Spawn the real hook (hooks/awaiting-hook.js) twice, UserPromptSubmit then Stop. Each run must
//    exit 0 with empty stdout and stderr.
// 4. Require exit 0 plus an AWAITING_SMOKE_OK line (the app saw the turn close as done/stop, the
//    renderer got a push), then server.json must be gone and awaiting.db must exist.
// The real ~/.awaiting and ~/.claude are never touched.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 5_000;
const SESSION_ID = 'awaiting-smoke-session'; // = SMOKE_SESSION_ID in src/main/smoke.ts
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = resolve(appDir, '../../hooks/awaiting-hook.js');
const electronPath = /** @type {string} */ (createRequire(import.meta.url)('electron'));

const home = mkdtempSync(join(tmpdir(), 'awaiting-smoke-'));
const serverJson = join(home, 'server.json');

const env = { ...process.env, AWAITING_SMOKE: '1', AWAITING_HOME: home };
// Never inherit these: the smoke must run the real app against the production build.
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const hookEnv = { ...env };
delete hookEnv.AWAITING_SMOKE;

function cleanup() {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.error(`smoke:app warning: could not remove ${home}:`, error);
  }
}

/** @param {string} message */
function failNow(message) {
  console.error(`smoke:app FAIL ${message}`);
  child.kill();
  cleanup();
  process.exit(1);
}

/** @param {number} port @param {number} pid */
function checkServerJson(port, pid) {
  if (!existsSync(serverJson)) return `server.json missing in ${home}`;
  /** @type {any} */
  let info;
  try {
    info = JSON.parse(readFileSync(serverJson, 'utf8'));
  } catch {
    return 'server.json is not JSON';
  }
  if (info.port !== port) return `server.json port ${info.port} != ${port}`;
  if (info.pid !== pid) return `server.json pid ${info.pid} != app pid ${pid}`;
  if (typeof info.token !== 'string' || !/^[0-9a-f]{64}$/.test(info.token)) {
    return 'server.json token malformed';
  }
  return null;
}

/** Run the real hook once with `payload` on stdin. @param {Record<string, unknown>} payload */
function runHook(payload) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    env: hookEnv,
    timeout: HOOK_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (r.error) return `hook could not run: ${r.error.message}`;
  if (r.status !== 0) return `hook exited ${r.status}`;
  if (r.stdout !== '' || r.stderr !== '') return 'hook wrote output';
  return null;
}

const base = {
  session_id: SESSION_ID,
  transcript_path: join(home, 'transcript.jsonl'),
  cwd: home,
  permission_mode: 'default',
};

function drive(ready) {
  if (ready.address !== '127.0.0.1') return failNow(`server address ${ready.address}`);
  const bad = checkServerJson(ready.port, child.pid);
  if (bad !== null) return failNow(bad);
  const steps = [
    { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'smoke test prompt' },
    { ...base, hook_event_name: 'Stop', stop_hook_active: false },
  ];
  for (const payload of steps) {
    const err = runHook(payload);
    if (err !== null) return failNow(`${payload.hook_event_name}: ${err}`);
  }
  console.log('smoke:app hook events delivered');
}

const child = spawn(electronPath, [appDir], {
  cwd: appDir,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let stdout = '';
let buffered = '';
let readySeen = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (!readySeen && line.startsWith('AWAITING_SMOKE_READY ')) {
      readySeen = true;
      try {
        drive(JSON.parse(line.slice('AWAITING_SMOKE_READY '.length)));
      } catch (error) {
        failNow(`bad READY line: ${String(error)}`);
      }
    }
  }
});

const timer = setTimeout(() => {
  failNow(`timed out after ${TIMEOUT_MS} ms`);
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error('smoke:app FAIL could not start Electron:', error);
  cleanup();
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const ok = stdout.split(/\r?\n/).some((line) => line.startsWith('AWAITING_SMOKE_OK'));
  const problems = [];
  if (code !== 0 || !ok) problems.push(`exit=${code} signal=${signal} okLine=${ok}`);
  if (!readySeen) problems.push('no READY line');
  if (existsSync(serverJson)) problems.push('server.json left behind after quit');
  if (!existsSync(join(home, 'awaiting.db'))) problems.push(`awaiting.db not created in ${home}`);
  cleanup();
  if (problems.length === 0) {
    console.log('smoke:app ok');
    process.exit(0);
  }
  console.error(`smoke:app FAIL ${problems.join('; ')}`);
  process.exit(1);
});
