// Status codes for every plan 01 §3.5 check, 202-before-onEvent ordering, robustness against
// garbage, and the hook <-> server contract (the real hooks/awaiting-hook.js against this server).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NormalizedEvent } from '@awaiting/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken } from './auth';
import { createDoctorPingStore } from './doctor-ping';
import {
  DEFAULT_MAX_BODY_BYTES,
  HOOK_VERSION,
  startEventServer,
  type EventServer,
  type EventServerOptions,
} from './http';
import { readServerInfo, startAwaitingServer } from './index';

const HOOK_PATH = resolve(__dirname, '../../../../../hooks/awaiting-hook.js');

type Reply = { status: number; headers: Record<string, unknown>; body: string };

type ReqOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  /** Header names to omit from the defaults. */
  omit?: string[];
  body?: string | Buffer;
  /** Send the body chunked (no content-length). */
  chunked?: boolean;
};

let server: EventServer;
let token: string;
let events: NormalizedEvent[];
let keepRaw: boolean;
let pings: ReturnType<typeof createDoctorPingStore>;

async function start(overrides: Partial<EventServerOptions> = {}): Promise<EventServer> {
  token = generateToken();
  events = [];
  keepRaw = false;
  pings = createDoctorPingStore({ now: () => Date.now() });
  server = await startEventServer({
    token,
    onEvent: (ev) => {
      events.push(ev);
    },
    onDoctorPing: (n) => pings.add(n),
    hasDoctorPing: (n) => pings.has(n),
    keepRawPrompt: () => keepRaw,
    ...overrides,
  });
  return server;
}

function send(opts: ReqOptions = {}): Promise<Reply> {
  const method = opts.method ?? 'POST';
  const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(method === 'POST' && { 'content-type': 'application/json' }),
    ...(body !== undefined && !opts.chunked && { 'content-length': String(body.length) }),
    ...opts.headers,
  };
  for (const k of opts.omit ?? []) delete headers[k];
  return new Promise((res, rej) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: opts.path ?? '/events',
        agent: false,
        headers,
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () =>
          res({
            status: r.statusCode ?? 0,
            headers: r.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        r.on('error', rej);
      },
    );
    req.on('error', rej);
    req.end(body);
  });
}

const now = Date.now();
function event(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd: '/home/user/project',
    received_at: now,
    ...fields,
  });
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await tick(10);
  }
}

describe('startEventServer: checks in order (plan 01 §3.5)', () => {
  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await server.close();
  });

  it('binds 127.0.0.1 on an ephemeral port', () => {
    expect(server.address).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
  });

  it.each([
    ['another host', 'evil.example:80'],
    ['localhost', 'localhost:PORT'],
    ['wrong port', '127.0.0.1:1'],
    ['bare ip', '127.0.0.1'],
  ])('403 for a Host header of %s (DNS rebinding)', async (_name, host) => {
    const r = await send({
      headers: { host: host.replace('PORT', String(server.port)) },
      body: event(),
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'forbidden_host' });
    expect(events).toHaveLength(0);
  });

  it('403 when an Origin header is present, even with a valid token', async () => {
    const r = await send({ headers: { origin: 'http://127.0.0.1:3000' }, body: event() });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'forbidden_origin' });
    const nullOrigin = await send({ headers: { origin: 'null' }, body: event() });
    expect(nullOrigin.status).toBe(403);
  });

  it('host check comes before the route check', async () => {
    const r = await send({ path: '/nope', headers: { host: 'evil.example' } });
    expect(r.status).toBe(403);
  });

  it.each(['/', '/event', '/events/', '/healthz', '/doctor/ping', '/doctor/ping/xyz'])(
    '404 for unknown path %s',
    async (path) => {
      const r = await send({ method: 'GET', path });
      expect(r.status).toBe(404);
    },
  );

  it('404 for a ping nonce in the wrong format (uppercase / too short)', async () => {
    expect((await send({ method: 'GET', path: `/doctor/ping/${'AB'.repeat(16)}` })).status).toBe(
      404,
    );
    expect((await send({ method: 'GET', path: '/doctor/ping/abc' })).status).toBe(404);
  });

  it('405 with Allow for the wrong method', async () => {
    const getEvents = await send({ method: 'GET', path: '/events' });
    expect(getEvents.status).toBe(405);
    expect(getEvents.headers['allow']).toBe('POST');
    const postHealth = await send({ method: 'POST', path: '/health', body: '{}' });
    expect(postHealth.status).toBe(405);
    expect(postHealth.headers['allow']).toBe('GET');
    const putEvents = await send({ method: 'PUT', path: '/events', body: event() });
    expect(putEvents.status).toBe(405);
  });

  it('route check comes before auth (unknown path without token is 404)', async () => {
    const r = await send({ method: 'GET', path: '/nope', omit: ['authorization'] });
    expect(r.status).toBe(404);
  });

  it.each([
    ['missing', undefined],
    ['wrong token', `Bearer ${'0'.repeat(64)}`],
    ['shorter token', 'Bearer abc'],
    ['longer token', `Bearer ${'a'.repeat(65)}`],
    ['basic scheme', 'Basic dXNlcjpwYXNz'],
    ['no scheme', 'TOKEN'],
  ])('401 for %s authorization', async (_name, value) => {
    const auth = value?.replace('TOKEN', token);
    const r = await send({
      body: event(),
      ...(auth === undefined ? { omit: ['authorization'] } : { headers: { authorization: auth } }),
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: 'unauthorized' });
    expect(events).toHaveLength(0);
  });

  it('401 on GET /health and /doctor/ping without the token', async () => {
    expect((await send({ method: 'GET', path: '/health', omit: ['authorization'] })).status).toBe(
      401,
    );
    const ping = `/doctor/ping/${randomBytes(16).toString('hex')}`;
    expect((await send({ method: 'GET', path: ping, omit: ['authorization'] })).status).toBe(401);
  });

  it('accepts a case-insensitive Bearer scheme', async () => {
    const r = await send({ headers: { authorization: `bearer ${token}` }, body: event() });
    expect(r.status).toBe(202);
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['form', 'application/x-www-form-urlencoded'],
    ['json-ish', 'application/jsonx'],
  ])('415 for content-type %s', async (_name, ct) => {
    const r = await send({ headers: { 'content-type': ct }, body: event() });
    expect(r.status).toBe(415);
  });

  it('415 for a missing content-type', async () => {
    const r = await send({ omit: ['content-type'], body: event() });
    expect(r.status).toBe(415);
  });

  it('accepts application/json with parameters and odd case', async () => {
    const r = await send({
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
      body: event(),
    });
    expect(r.status).toBe(202);
  });

  it('400 invalid_json for unparsable bodies', async () => {
    for (const body of ['', 'not json', '{"a":', '\u0000\u0001']) {
      const r = await send({ body });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: 'invalid_json' });
    }
    expect(events).toHaveLength(0);
  });

  it.each([
    ['array', '[]', 'not_an_object'],
    ['null', 'null', 'not_an_object'],
    ['number', '42', 'not_an_object'],
    ['unknown event', event({ hook_event_name: 'Bogus' }), 'unknown_hook_event_name'],
    ['missing session', event({ session_id: undefined }), 'invalid_session_id'],
    ['missing received_at', event({ received_at: undefined }), 'invalid_received_at'],
    [
      'prompt not a string',
      event({ hook_event_name: 'UserPromptSubmit', prompt: 5 }),
      'missing_prompt',
    ],
  ])('400 with the parser error code for %s', async (_name, body, code) => {
    const r = await send({ body });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: code });
    expect(events).toHaveLength(0);
  });

  it('202 with an empty body for a valid event, then onEvent once with the normalized event', async () => {
    const r = await send({ body: event() });
    expect(r.status).toBe(202);
    expect(r.body).toBe('');
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      eventName: 'SessionStart',
      sessionId: 'sess-1',
      receivedAt: now,
      source: 'startup',
    });
    expect(server.stats()).toMatchObject({ accepted: 1, onEventErrors: 0 });
  });

  it('ignores the query string when routing', async () => {
    const r = await send({ path: '/events?x=1', body: event() });
    expect(r.status).toBe(202);
  });

  it('GET /health answers 200 with app, ok and hookVersion', async () => {
    const r = await send({ method: 'GET', path: '/health' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ app: 'awaiting', ok: true, hookVersion: HOOK_VERSION });
  });

  it('HOOK_VERSION matches the hook script', () => {
    const src = readFileSync(HOOK_PATH, 'utf8');
    const m = /^const HOOK_VERSION = (\d+);$/m.exec(src);
    expect(m?.[1]).toBe(String(HOOK_VERSION));
  });
});

describe('body size limit (413)', () => {
  beforeEach(async () => {
    await start({ maxBodyBytes: 1024 });
  });
  afterEach(async () => {
    await server.close();
  });

  it('413 when content-length declares more than maxBodyBytes', async () => {
    const r = await send({ body: event({ pad: 'x'.repeat(2048) }) });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'body_too_large' });
    expect(events).toHaveLength(0);
  });

  it('413 when a chunked body grows past maxBodyBytes', async () => {
    const r = await send({ chunked: true, body: event({ pad: 'x'.repeat(2048) }) });
    expect(r.status).toBe(413);
    expect(events).toHaveLength(0);
  });

  it('accepts a body exactly at the limit', async () => {
    const base = event({ pad: '' });
    const body = event({ pad: 'x'.repeat(1024 - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(body)).toBe(1024);
    expect((await send({ body })).status).toBe(202);
  });

  it('keeps serving after a 413', async () => {
    await send({ body: event({ pad: 'x'.repeat(4096) }) });
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('defaults to 8 MiB', async () => {
    await server.close();
    await start();
    expect(DEFAULT_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
    // One byte over the default. The server replies 413 and then destroys the socket while the
    // client is still writing, so on some platforms the client sees a reset before the reply.
    const big = event({ pad: 'x'.repeat(DEFAULT_MAX_BODY_BYTES) });
    const r = await send({ body: big }).catch((err: NodeJS.ErrnoException) => err.code);
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(typeof r === 'object' ? r.status : r);
    await tick(30);
    expect(events).toHaveLength(0);
    expect(server.stats().rejected).toBe(1);
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
  });
});

describe('doctor ping (D1.22)', () => {
  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await server.close();
  });

  it('records the nonce (202), answers 200 on GET, never calls onEvent', async () => {
    const nonce = randomBytes(16).toString('hex');
    const path = `/doctor/ping/${nonce}`;
    expect((await send({ method: 'GET', path })).status).toBe(404);
    const r = await send({
      body: JSON.stringify({
        hook_event_name: 'AwaitingDoctorPing',
        session_id: `awaiting-doctor-${nonce}`,
        nonce,
        received_at: now,
      }),
    });
    expect(r.status).toBe(202);
    expect(r.body).toBe('');
    expect((await send({ method: 'GET', path })).status).toBe(200);
    await tick(30);
    expect(events).toHaveLength(0);
    expect(server.stats()).toMatchObject({ doctorPings: 1, accepted: 0 });
  });

  it('a ping with a malformed nonce falls through to the parser (400)', async () => {
    const r = await send({
      body: JSON.stringify({
        hook_event_name: 'AwaitingDoctorPing',
        session_id: 's',
        nonce: 'zz',
        received_at: now,
      }),
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'unknown_hook_event_name' });
    expect(pings.size()).toBe(0);
  });

  it('without ping callbacks: ping body is 400, GET is 404', async () => {
    await server.close();
    token = generateToken();
    server = await startEventServer({ token, onEvent: () => {}, keepRawPrompt: () => false });
    const nonce = randomBytes(16).toString('hex');
    const r = await send({
      body: JSON.stringify({ hook_event_name: 'AwaitingDoctorPing', session_id: 's', nonce }),
    });
    expect(r.status).toBe(400);
    expect((await send({ method: 'GET', path: `/doctor/ping/${nonce}` })).status).toBe(404);
  });
});

describe('raw prompt handling (H3)', () => {
  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await server.close();
  });

  const sentinel = (): string => `AWT_SENTINEL_${randomBytes(8).toString('hex')}`;
  const promptBody = (s: string): string =>
    event({
      hook_event_name: 'UserPromptSubmit',
      prompt: `${s} please fix\n<pasted_content id="1">\n${s}\n</pasted_content id="1">\nmid ${s} text`,
      prompt_id: 'p-1',
    });

  it('drops the raw prompt by default: the sentinel never reaches onEvent', async () => {
    const s = sentinel();
    expect((await send({ body: promptBody(s) })).status).toBe(202);
    await waitFor(() => events.length === 1);
    const ev = events[0];
    expect(ev?.promptText).toBeNull();
    expect(ev?.prompt).not.toBeNull();
    expect(JSON.stringify(ev)).not.toContain(s);
    expect(JSON.stringify(ev)).not.toContain('AWT_SENTINEL');
  });

  it('keeps the prompt only when keepRawPrompt() is true, read per request', async () => {
    const s1 = sentinel();
    keepRaw = true;
    await send({ body: promptBody(s1) });
    const s2 = sentinel();
    keepRaw = false;
    await send({ body: promptBody(s2) });
    await waitFor(() => events.length === 2);
    expect(events[0]?.promptText).toContain(s1);
    expect(JSON.stringify(events[1])).not.toContain(s2);
  });

  it('a 400 response never echoes the body', async () => {
    const s = sentinel();
    const r = await send({ body: event({ hook_event_name: s, prompt: s }) });
    expect(r.status).toBe(400);
    expect(r.body).not.toContain(s);
  });
});

describe('onEvent isolation', () => {
  afterEach(async () => {
    await server.close();
  });

  it('202 arrives even when onEvent throws; errors are counted and the server keeps going', async () => {
    const errors: unknown[] = [];
    await start({
      onEvent: () => {
        throw new Error('boom');
      },
      onError: (e) => errors.push(e),
    });
    expect((await send({ body: event() })).status).toBe(202);
    expect((await send({ body: event() })).status).toBe(202);
    await waitFor(() => server.stats().onEventErrors === 2);
    expect(errors).toHaveLength(2);
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('a rejecting async onEvent is caught and counted', async () => {
    await start({ onEvent: () => Promise.reject(new Error('async boom')) });
    expect((await send({ body: event() })).status).toBe(202);
    await waitFor(() => server.stats().onEventErrors === 1);
  });

  it('keepRawPrompt() throwing gives 500, not a crash', async () => {
    await start({
      keepRawPrompt: () => {
        throw new Error('settings broken');
      },
    });
    const r = await send({ body: event() });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'internal_error' });
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('the response is flushed before onEvent runs (a blocking onEvent does not delay the 202)', async () => {
    const BLOCK_MS = 1500;
    await start({
      onEvent: () => {
        const until = Date.now() + BLOCK_MS;
        while (Date.now() < until) {
          // Busy-wait: blocks this process's event loop entirely.
        }
      },
    });
    // The client runs in another process, so it can only see the 202 early if the server flushed
    // it before entering onEvent.
    const client = `
      const http = require('node:http');
      const body = ${JSON.stringify(event())};
      const t0 = Date.now();
      const req = http.request({ host: '127.0.0.1', port: ${server.port}, method: 'POST', path: '/events', agent: false,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ${token}', 'content-length': Buffer.byteLength(body) } },
        (res) => { process.stdout.write(JSON.stringify({ status: res.statusCode, ms: Date.now() - t0 })); res.resume(); res.on('end', () => process.exit(0)); });
      req.on('error', (e) => { process.stdout.write(JSON.stringify({ error: e.message })); process.exit(1); });
      req.end(body);
    `;
    const out = await new Promise<string>((res, rej) => {
      const child = spawn(process.execPath, ['-e', client], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.on('error', rej);
      child.on('close', () => res(stdout));
    });
    const result = JSON.parse(out) as { status?: number; ms?: number; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(202);
    expect(result.ms).toBeLessThan(BLOCK_MS - 500);
  }, 15_000);
});

describe('robustness against garbage sockets', () => {
  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await server.close();
  });

  const raw = (data: string | Buffer, opts: { end?: boolean } = {}): Promise<string> =>
    new Promise((res) => {
      const sock = connect(server.port, '127.0.0.1');
      let got = '';
      sock.on('data', (c: Buffer) => (got += c.toString('latin1')));
      sock.on('error', () => res(got));
      sock.on('close', () => res(got));
      sock.setTimeout(3000, () => sock.destroy());
      sock.write(data);
      if (opts.end === true) sock.end();
    });

  it('survives non-HTTP bytes, binary noise, truncated requests and oversized headers', async () => {
    await raw('GARBAGE\r\n\r\n');
    await raw(randomBytes(4096));
    await raw('POST /events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Le', { end: true });
    await raw(
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX: ${'a'.repeat(32_000)}\r\n\r\n`,
    );
    await raw(
      `POST /events HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 10\r\nContent-Length: 20\r\n\r\n`,
    );
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
    expect((await send({ body: event() })).status).toBe(202);
  });

  it('a client that disconnects mid-body does not crash the server', async () => {
    const head =
      `POST /events HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${token}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"session_id":';
    await new Promise<void>((res) => {
      const sock = connect(server.port, '127.0.0.1', () => {
        sock.write(head, () => {
          sock.destroy();
          res();
        });
      });
      sock.on('error', () => res());
    });
    await tick(50);
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it('more than maxHeadersCount headers is rejected by the parser (400), not a crash', async () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 100; i++) headers[`x-h${i}`] = String(i);
    const r = await send({ method: 'GET', path: '/health', headers }).catch(() => null);
    if (r !== null) expect(r.status).toBe(400);
    expect(events).toHaveLength(0);
    expect((await send({ method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('close() is idempotent and drops keep-alive connections', async () => {
    await send({ method: 'GET', path: '/health' });
    await Promise.all([server.close(), server.close()]);
    await expect(send({ method: 'GET', path: '/health' })).rejects.toThrow();
  });
});

describe('hook contract: the real hooks/awaiting-hook.js against startAwaitingServer', () => {
  let dataDir: string;
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const runHook = (
    input: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((res, rej) => {
      const child = spawn(process.execPath, [HOOK_PATH], {
        env: { ...process.env, AWAITING_HOME: dataDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', rej);
      child.on('close', (code) => res({ code, stdout, stderr }));
      child.stdin.end(input);
    });

  it('the hook finds server.json, authenticates, and its event reaches onEvent; ping round-trips', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'awaiting-server-'));
    const received: NormalizedEvent[] = [];
    const app = await startAwaitingServer({
      dataDir,
      onEvent: (ev) => {
        received.push(ev);
      },
      keepRawPrompt: () => false,
    });
    try {
      expect(readServerInfo(dataDir)).toMatchObject({
        version: 1,
        port: app.port,
        token: app.token,
        pid: process.pid,
      });
      const r = await runHook(
        JSON.stringify({
          session_id: 'hook-sess',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'AWT_SENTINEL_contract hello',
          cwd: '/tmp',
          tool_response: { big: 'x' },
        }),
      );
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
      await waitFor(() => received.length === 1);
      expect(received[0]).toMatchObject({ eventName: 'UserPromptSubmit', sessionId: 'hook-sess' });
      expect(JSON.stringify(received[0])).not.toContain('AWT_SENTINEL');

      const nonce = randomBytes(16).toString('hex');
      const p = await runHook(
        JSON.stringify({
          hook_event_name: 'AwaitingDoctorPing',
          session_id: `awaiting-doctor-${nonce}`,
          nonce,
        }),
      );
      expect(p).toEqual({ code: 0, stdout: '', stderr: '' });
      await waitFor(() => app.stats().doctorPings === 1);
      expect(received).toHaveLength(1);
    } finally {
      await app.close();
    }
    expect(readServerInfo(dataDir)).toBeNull();
  }, 15_000);
});
