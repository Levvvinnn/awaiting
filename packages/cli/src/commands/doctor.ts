// `awaiting doctor` (plan 01 §3.10): read-only checks. Never writes a file. Its only side effects
// are `node --version`, the loopback probe and one spawn of the installed hook with a ping event.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getLoopback } from '../doctor/probe';
import {
  CLI_HOOK_VERSION,
  HOOK_EVENT_NAMES,
  HOOK_SCRIPT_BASENAME,
  MIN_CLAUDE_CODE,
  MIN_NODE_MAJOR,
  desiredHandler,
  type HookForm,
} from '../events';
import { dataDirFor, type Env } from '../paths';
import type { CommandContext } from '../run';
import { readSettings } from '../settings/io';
import { basename, isOurs, isPlainObject, jsonEqual, type JsonObject } from '../settings/merge';

type Level = 'ok' | 'warn' | 'FAIL' | 'skip';
type Line = { level: Level; message: string; fix?: string };

const HEALTH_TIMEOUT_MS = 1000;
const PING_POLL_MS = 1500;
const PING_INTERVAL_MS = 100;
const HOOK_SPAWN_TIMEOUT_MS = 5000;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const HOOK_VERSION_RE = /^const HOOK_VERSION = (\d+);\s*$/m;

class Report {
  readonly lines: Line[] = [];
  constructor(private readonly out: CommandContext['stdout']) {}
  add(level: Level, message: string, fix?: string): void {
    const line: Line = fix === undefined ? { level, message } : { level, message, fix };
    this.lines.push(line);
    this.out.write(`${level.padEnd(5)} ${message}\n`);
    if (fix !== undefined) this.out.write(`      fix: ${fix}\n`);
  }
  get failed(): boolean {
    return this.lines.some((l) => l.level === 'FAIL');
  }
}

function toProcessEnv(env: Env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function checkNode(env: Env, r: Report): void {
  const res = spawnSync('node', ['--version'], {
    env: toProcessEnv(env),
    timeout: 5000,
    encoding: 'utf8',
    windowsHide: true,
  });
  const fix = `install Node.js >= ${MIN_NODE_MAJOR} and make sure \`node\` is on PATH (Claude Code runs the hook with it)`;
  if (res.error !== undefined || res.status !== 0) {
    r.add('FAIL', '`node` not found on PATH', fix);
    return;
  }
  const version = res.stdout.trim();
  const major = Number(/^v(\d+)\./.exec(version)?.[1] ?? NaN);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    r.add('FAIL', `node ${version} on PATH is older than ${MIN_NODE_MAJOR}`, fix);
    return;
  }
  r.add('ok', `node ${version} on PATH`);
}

/** Path our handler references and its form, or null if it can't be read back. */
export function handlerTarget(handler: JsonObject): { path: string; form: HookForm } | null {
  const args = handler['args'];
  if (Array.isArray(args)) {
    const p = args.find(
      (a): a is string =>
        typeof a === 'string' && basename(a).toLowerCase() === HOOK_SCRIPT_BASENAME,
    );
    return p === undefined ? null : { path: p, form: 'exec' };
  }
  const command = handler['command'];
  if (typeof command !== 'string') return null;
  const quoted = /"([^"]*awaiting-hook\.js)"/i.exec(command);
  if (quoted?.[1] !== undefined) return { path: quoted[1], form: 'shell' };
  const bare = /(\S*awaiting-hook\.js)(?=$|\s)/i.exec(command);
  return bare?.[1] !== undefined ? { path: bare[1], form: 'shell' } : null;
}

function installFix(ctx: CommandContext): string {
  return `run \`awaiting install --settings "${ctx.settingsPath}"\``;
}

/** Checks 2–3. Returns the hook paths our handlers reference (for check 4). */
function checkSettings(ctx: CommandContext, r: Report): string[] | null {
  const read = readSettings(ctx.settingsPath);
  if (read.kind === 'missing') {
    r.add('FAIL', `settings file ${ctx.settingsPath} does not exist`, installFix(ctx));
    return null;
  }
  if (read.kind === 'malformed') {
    r.add(
      'FAIL',
      `settings file ${ctx.settingsPath} is malformed: ${read.error}`,
      'fix the JSON by hand (awaiting never rewrites a malformed file)',
    );
    return null;
  }
  r.add('ok', `settings file ${ctx.settingsPath} parses`);
  if (read.value['disableAllHooks'] === true) {
    r.add(
      'warn',
      '"disableAllHooks": true is set, so Claude Code runs no hooks',
      'remove "disableAllHooks" from settings.json to let awaiting receive events',
    );
  }

  const hooks = isPlainObject(read.value['hooks']) ? read.value['hooks'] : {};
  const paths: string[] = [];
  const problems: string[] = [];
  for (const event of HOOK_EVENT_NAMES) {
    const groups = hooks[event];
    const ours: JsonObject[] = [];
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (!isPlainObject(g) || !Array.isArray(g['hooks'])) continue;
        for (const h of g['hooks'] as unknown[]) if (isOurs(h)) ours.push(h as JsonObject);
      }
    }
    if (ours.length === 0) {
      problems.push(`${event}: missing`);
      continue;
    }
    if (ours.length > 1) problems.push(`${event}: duplicated (${ours.length} entries)`);
    for (const h of ours) {
      const target = handlerTarget(h);
      if (target === null) {
        problems.push(`${event}: hook path can't be read from the entry`);
        continue;
      }
      paths.push(target.path);
      if (!jsonEqual(h, desiredHandler(event, target.path, target.form))) {
        problems.push(`${event}: entry differs from what install writes`);
      }
    }
  }
  if (problems.length === 0) {
    r.add('ok', `all ${HOOK_EVENT_NAMES.length} hook events installed exactly once`);
  } else {
    for (const p of problems) r.add('FAIL', `hook entry ${p}`, installFix(ctx));
  }
  return paths;
}

/** Check 4. Returns the usable hook path, or null. */
function checkHookScript(paths: string[], ctx: CommandContext, r: Report): string | null {
  const distinct = [...new Set(paths)];
  if (distinct.length === 0) return null;
  if (distinct.length > 1) {
    r.add('FAIL', `hook entries point to ${distinct.length} different paths`, installFix(ctx));
    return null;
  }
  const hookPath = distinct[0] ?? '';
  if (!path.isAbsolute(hookPath)) {
    r.add('FAIL', `hook path ${hookPath} is not absolute`, installFix(ctx));
    return null;
  }
  let source: string;
  try {
    source = fs.readFileSync(hookPath, 'utf8');
  } catch {
    r.add('FAIL', `hook script ${hookPath} is missing or unreadable`, installFix(ctx));
    return null;
  }
  const version = Number(HOOK_VERSION_RE.exec(source)?.[1] ?? NaN);
  if (version !== CLI_HOOK_VERSION) {
    r.add(
      'FAIL',
      `hook script ${hookPath} has HOOK_VERSION ${Number.isNaN(version) ? 'unknown' : version}, expected ${CLI_HOOK_VERSION}`,
      installFix(ctx),
    );
    return null;
  }
  let pkgType: unknown;
  try {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(path.dirname(hookPath), 'package.json'), 'utf8'),
    );
    pkgType = isPlainObject(pkg) ? pkg['type'] : undefined;
  } catch {
    pkgType = undefined;
  }
  if (pkgType !== 'commonjs') {
    r.add('FAIL', `no package.json with "type": "commonjs" next to ${hookPath}`, installFix(ctx));
    return null;
  }
  r.add('ok', `hook script ${hookPath} (HOOK_VERSION ${version})`);
  return hookPath;
}

type ServerInfo = { port: number; token: string; pid: number };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Check 5. */
function checkServerFile(dataDir: string, r: Report): ServerInfo | null {
  const file = path.join(dataDir, 'server.json');
  const fix = 'start the awaiting app';
  let info: unknown;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    r.add('FAIL', missing ? `${file} not found (app not running)` : `${file} is invalid`, fix);
    return null;
  }
  if (!isPlainObject(info)) {
    r.add('FAIL', `${file} is invalid`, fix);
    return null;
  }
  const { port, token, pid } = info;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof token !== 'string' ||
    !TOKEN_RE.test(token) ||
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    r.add('FAIL', `${file} has an invalid port, token or pid`, fix);
    return null;
  }
  if (!pidAlive(pid)) {
    r.add('FAIL', `${file} is stale: process ${pid} is not running`, fix);
    return null;
  }
  r.add('ok', `server.json: port ${port}, pid ${pid}`);
  return { port, token, pid };
}

/** Check 6. */
async function checkHealth(server: ServerInfo, r: Report): Promise<boolean> {
  const res = await getLoopback(server.port, '/health', server.token, HEALTH_TIMEOUT_MS);
  const fix = 'restart the awaiting app';
  if (!res.ok) {
    r.add('FAIL', `GET /health on 127.0.0.1:${server.port} failed: ${res.error}`, fix);
    return false;
  }
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = null;
  }
  if (res.status !== 200 || !isPlainObject(body) || body['app'] !== 'awaiting') {
    r.add('FAIL', `GET /health on 127.0.0.1:${server.port} returned ${res.status}`, fix);
    return false;
  }
  r.add('ok', `awaiting app answers on 127.0.0.1:${server.port}`);
  if (body['hookVersion'] !== CLI_HOOK_VERSION) {
    r.add(
      'warn',
      `app expects hook version ${String(body['hookVersion'])}, CLI has ${CLI_HOOK_VERSION}`,
    );
  }
  return true;
}

type SpawnResult = { code: number | null; stdout: string; stderr: string; error?: string };

function spawnHook(hookPath: string, input: string, env: Env): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Same command and args Claude Code runs (exec form): `node <hookPath>`.
    const child = spawn('node', [hookPath], {
      env: toProcessEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      done({
        code: null,
        stdout,
        stderr,
        error: `still running after ${HOOK_SPAWN_TIMEOUT_MS} ms`,
      });
    }, HOOK_SPAWN_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.stdin.on('error', () => {});
    child.on('error', (err) => done({ code: null, stdout, stderr, error: err.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Check 7: synthetic AwaitingDoctorPing through the installed hook (D1.22). */
async function checkRoundTrip(
  hookPath: string,
  server: ServerInfo,
  env: Env,
  r: Report,
): Promise<void> {
  const nonce = randomBytes(16).toString('hex');
  const input = JSON.stringify({
    hook_event_name: 'AwaitingDoctorPing',
    session_id: `awaiting-doctor-${nonce}`,
    nonce,
  });
  const res = await spawnHook(hookPath, input, env);
  if (res.error !== undefined || res.code !== 0 || res.stdout !== '' || res.stderr !== '') {
    r.add(
      'FAIL',
      `hook run failed (exit ${String(res.code)}${res.error !== undefined ? `, ${res.error}` : ''}` +
        `, stdout ${res.stdout.length} bytes, stderr ${res.stderr.length} bytes)`,
      'reinstall with `awaiting install` and check that `node` runs the script',
    );
    return;
  }
  const deadline = Date.now() + PING_POLL_MS;
  for (;;) {
    const ping = await getLoopback(
      server.port,
      `/doctor/ping/${nonce}`,
      server.token,
      HEALTH_TIMEOUT_MS,
    );
    if (ping.ok && ping.status === 200) {
      r.add('ok', 'round trip: the hook delivered a test event to the app');
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(PING_INTERVAL_MS);
  }
  r.add(
    'FAIL',
    `round trip: the app did not receive the test event within ${PING_POLL_MS} ms`,
    'restart the awaiting app; if it persists, check AWAITING_HOME is the same for the app and Claude Code',
  );
}

export async function doctor(ctx: CommandContext): Promise<number> {
  const r = new Report(ctx.stdout);
  const dataDir = dataDirFor(ctx.env, ctx.homedir);

  checkNode(ctx.env, r);
  const paths = checkSettings(ctx, r);
  const hookPath = paths === null ? null : checkHookScript(paths, ctx, r);
  const server = checkServerFile(dataDir, r);
  const healthy = server !== null && (await checkHealth(server, r));
  if (server !== null && healthy && hookPath !== null) {
    await checkRoundTrip(hookPath, server, ctx.env, r);
  } else {
    r.add('skip', 'round trip (needs a valid install and a running app)');
  }
  ctx.stdout.write(
    `info  Claude Code version: not checked (doctor never runs claude); supported >= ${MIN_CLAUDE_CODE}\n`,
  );
  return r.failed ? 1 : 0;
}
