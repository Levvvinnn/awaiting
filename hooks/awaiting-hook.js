'use strict';
// awaiting hook: forwards one Claude Code hook event (JSON on stdin) to the local awaiting app.
//
// Contract (CLAUDE.md rule 1, docs/plans/01-hook-pipeline.md §3.3):
// - zero dependencies, only node: builtins, CommonJS, Node >= 20, ES2022 syntax;
// - always exits 0, never writes to stdout or stderr (hook docs #exit-code-0, #exit-code-output);
// - hard exit 300 ms after start, request timeout 250 ms (Node startup adds ~100-200 ms; total must stay < 600 ms);
// - only talks to 127.0.0.1 on the port published in <dataDir>/server.json.

const HOOK_VERSION = 1;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HARD_DEADLINE_MS = 300;
const REQUEST_TIMEOUT_MS = 250;
const MAX_STDIN_BYTES = 16 * 1024 * 1024;
const TOKEN_RE = /^[0-9a-f]{64}$/;

function exit0() {
  try {
    process.exitCode = 0;
    process.exit(0);
  } catch {
    // Nothing else we can do; the deadline timer or the event loop ending still exits 0.
  }
}

/**
 * Same contract as packages/core/src/paths.ts resolveDataDir (pure string logic; the caller
 * resolves the result to an absolute path). Keep the two in sync; hooks/test/hook.test.js and
 * packages/core/src/paths.test.ts share one contract table.
 * @param {{ awaitingHome: string | undefined, homeDir: string, sep: '/' | '\\' }} input
 * @returns {string}
 */
function resolveDataDir(input) {
  const { awaitingHome, homeDir, sep } = input;
  if (awaitingHome !== undefined && awaitingHome.trim() !== '') return awaitingHome;
  if (homeDir.trim() === '') throw new RangeError('resolveDataDir: homeDir is empty');
  // On Windows both separators are valid, so strip trailing runs of either.
  const trailing = sep === '\\' ? /[\\/]+$/ : /\/+$/;
  return homeDir.replace(trailing, '') + sep + '.awaiting';
}

/** @returns {{ port: number, token: string } | null} */
function readServerInfo(dataDir) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return null;
  const { port, token, pid } = info;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the process exists but belongs to someone else: still alive.
    if (!err || err.code !== 'EPERM') return null;
  }
  return { port, token };
}

function send(server, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    method: 'POST',
    path: '/events',
    agent: false,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      authorization: 'Bearer ' + server.token,
      'x-awaiting-hook': String(HOOK_VERSION),
    },
  });
  req.on('response', (res) => {
    res.on('end', exit0);
    res.on('error', exit0);
    res.on('aborted', exit0);
    res.resume();
  });
  req.on('timeout', () => {
    req.destroy();
    exit0();
  });
  req.on('error', exit0);
  req.end(body);
}

function onInput(raw, server) {
  if (raw.length === 0) return exit0();
  let payload;
  try {
    // Strip a leading UTF-8 BOM (e.g. PowerShell 5.1 pipes add one).
    payload = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return exit0();
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return exit0();
  if (typeof payload.hook_event_name !== 'string' || typeof payload.session_id !== 'string') {
    return exit0();
  }
  delete payload.tool_response;
  // Stamp with the process start time, not "now": Node startup jitter (~50-150 ms) would
  // otherwise reorder parallel hook events in the server's reorder buffer.
  payload.received_at = Math.round(performance.timeOrigin);
  send(server, payload);
}

function run() {
  // Silence both output streams before anything else can write (hook docs #exit-code-0).
  process.stdout.write = process.stderr.write = () => true;
  process.noDeprecation = true;
  process.on('uncaughtException', exit0);
  process.on('unhandledRejection', exit0);
  setTimeout(exit0, HARD_DEADLINE_MS);

  try {
    const dataDir = path.resolve(
      resolveDataDir({
        awaitingHome: process.env.AWAITING_HOME,
        homeDir: os.homedir(),
        sep: path.sep === '\\' ? '\\' : '/',
      }),
    );
    const server = readServerInfo(dataDir);
    if (server === null) return exit0();

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      try {
        size += chunk.length;
        if (size > MAX_STDIN_BYTES) return exit0();
        chunks.push(chunk);
      } catch {
        exit0();
      }
    });
    process.stdin.on('end', () => {
      try {
        onInput(Buffer.concat(chunks), server);
      } catch {
        exit0();
      }
    });
    process.stdin.on('error', exit0);
  } catch {
    exit0();
  }
}

if (require.main === module) {
  run();
}

module.exports = { HOOK_VERSION, resolveDataDir };
