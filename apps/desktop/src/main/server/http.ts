// Loopback HTTP event server (plan 01 §3.5). node:http + node:crypto only, no Electron, so it
// runs under plain-Node Vitest. Binds 127.0.0.1 only (hard rule 2); never throws on bad input.
//
// The raw request body (including any `UserPromptSubmit.prompt`) exists only inside the request
// handler. `parseHookEvent` turns it into features and drops the prompt unless `keepRawPrompt()`
// is true; only the resulting `NormalizedEvent` leaves this module. Bodies are never logged.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { parseHookEvent, type NormalizedEvent } from '@awaiting/core';
import { LOOPBACK_HOST, isAllowedHost, isAuthorized, isJsonContentType } from './auth';
import { DOCTOR_PING_EVENT, NONCE_RE } from './doctor-ping';

/** Must equal `HOOK_VERSION` in hooks/awaiting-hook.js (checked by http.test.ts). */
export const HOOK_VERSION = 1;

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export const DEFAULT_TIMEOUTS = {
  requestMs: 3_000,
  headersMs: 2_000,
  keepAliveMs: 1_000,
} as const;

export const MAX_HEADERS_COUNT = 32;

export interface ServerTimeouts {
  requestMs?: number;
  headersMs?: number;
  keepAliveMs?: number;
}

export interface EventServerOptions {
  /** Bearer token clients must present (64 hex; see `generateToken`). */
  token: string;
  /** Port to bind on 127.0.0.1; default 0 (ephemeral, D1.5). */
  port?: number;
  /** Request bodies above this size get 413; default 8 MiB (D1.15). */
  maxBodyBytes?: number;
  timeouts?: ServerTimeouts;
  /** Called once per accepted event, after the 202 has been written. Errors are caught and counted. */
  onEvent: (ev: NormalizedEvent) => void | Promise<void>;
  /** Records a doctor round-trip nonce (never stored). Without it, ping bodies get 400. */
  onDoctorPing?: (nonce: string) => void;
  /** True if a doctor nonce was seen. Without it, `GET /doctor/ping/<nonce>` is always 404. */
  hasDoctorPing?: (nonce: string) => boolean;
  /** Read per request: keep `UserPromptSubmit.prompt` in `promptText` (`privacy.storeRawPrompt`). */
  keepRawPrompt: () => boolean;
  /** Unexpected server-level errors (never request bodies). Default: ignored. */
  onError?: (err: unknown) => void;
}

export interface EventServerStats {
  /** Events answered 202 and handed to `onEvent`. */
  accepted: number;
  /** Requests answered with 4xx/5xx. */
  rejected: number;
  /** `onEvent` calls that threw or rejected. */
  onEventErrors: number;
  /** Doctor pings recorded. */
  doctorPings: number;
}

export interface EventServer {
  port: number;
  /** Always `127.0.0.1`. */
  address: string;
  stats: () => EventServerStats;
  /** Stops listening and drops open connections. Idempotent. */
  close: () => Promise<void>;
}

type Route = 'events' | 'health' | 'ping';

const PING_PATH_RE = /^\/doctor\/ping\/([^/]*)$/;

function routeOf(pathname: string): { route: Route; nonce?: string } | null {
  if (pathname === '/events') return { route: 'events' };
  if (pathname === '/health') return { route: 'health' };
  const m = PING_PATH_RE.exec(pathname);
  const nonce = m?.[1];
  if (nonce !== undefined && NONCE_RE.test(nonce)) return { route: 'ping', nonce };
  return null;
}

const METHOD: Record<Route, string> = { events: 'POST', health: 'GET', ping: 'GET' };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Starts the event server on 127.0.0.1. Rejects if the port cannot be bound. */
export function startEventServer(opts: EventServerOptions): Promise<EventServer> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const stats: EventServerStats = { accepted: 0, rejected: 0, onEventErrors: 0, doctorPings: 0 };
  let boundPort = 0;

  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // A failing error reporter must not take the server down.
    }
  };

  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): void => {
    if (res.headersSent) {
      req.socket.destroy();
      return;
    }
    if (status >= 400) stats.rejected++;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string | number> = {
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Error replies close the connection so an unread request body can't linger.
    if (status >= 400) headers['connection'] = 'close';
    res.writeHead(status, headers);
    res.end(payload);
    if (status >= 400 && !req.complete) {
      // Stop reading an oversized or unwanted body; destroy once the reply is flushed.
      req.pause();
      res.once('finish', () => req.socket.destroy());
    }
  };

  const fail = (req: IncomingMessage, res: ServerResponse, status: number, error: string): void =>
    send(req, res, status, { error });

  const dispatch = (ev: NormalizedEvent): void => {
    try {
      const result = opts.onEvent(ev);
      // Typed void | Promise, but guard on a real thenable in case a caller returns something else.
      if (result instanceof Promise) {
        result.then(undefined, (err: unknown) => {
          stats.onEventErrors++;
          reportError(err);
        });
      }
    } catch (err) {
      stats.onEventErrors++;
      reportError(err);
    }
  };

  /** 202 with an empty body first; `onEvent` runs only after the response has been flushed. */
  const accept = (req: IncomingMessage, res: ServerResponse, ev: NormalizedEvent): void => {
    stats.accepted++;
    let done = false;
    const run = (): void => {
      if (done) return;
      done = true;
      setImmediate(() => dispatch(ev));
    };
    // 'finish' = handed to the OS; 'close' covers a client that vanished before that.
    res.once('finish', run);
    res.once('close', run);
    send(req, res, 202);
  };

  const handleBody = (req: IncomingMessage, res: ServerResponse, raw: Buffer): void => {
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      fail(req, res, 400, 'invalid_json');
      return;
    }
    if (isPlainObject(body) && body['hook_event_name'] === DOCTOR_PING_EVENT) {
      const nonce = body['nonce'];
      if (opts.onDoctorPing !== undefined && typeof nonce === 'string' && NONCE_RE.test(nonce)) {
        opts.onDoctorPing(nonce);
        stats.doctorPings++;
        send(req, res, 202);
        return;
      }
    }
    const parsed = parseHookEvent(body, { keepRawPrompt: opts.keepRawPrompt() === true });
    if (!parsed.ok) {
      fail(req, res, 400, parsed.error);
      return;
    }
    accept(req, res, parsed.event);
  };

  const readBody = (req: IncomingMessage, res: ServerResponse): void => {
    const declared = headerValue(req.headers['content-length']);
    if (declared !== undefined && Number(declared) > maxBodyBytes) {
      fail(req, res, 413, 'body_too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (fn: () => void): void => {
      if (finished) return;
      finished = true;
      try {
        fn();
      } catch (err) {
        reportError(err);
        fail(req, res, 500, 'internal_error');
      }
    };
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        chunks.length = 0;
        finish(() => fail(req, res, 413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(() => handleBody(req, res, Buffer.concat(chunks, size))));
    req.on('error', () => {
      finished = true;
      req.socket.destroy();
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAllowedHost(req.headers.host, boundPort)) {
      fail(req, res, 403, 'forbidden_host');
      return;
    }
    if (req.headers.origin !== undefined) {
      fail(req, res, 403, 'forbidden_origin');
      return;
    }
    const url = req.url ?? '';
    const pathname = url.split('?', 1)[0] ?? '';
    const match = routeOf(pathname);
    if (match === null) {
      fail(req, res, 404, 'not_found');
      return;
    }
    const allowed = METHOD[match.route];
    if (req.method !== allowed) {
      send(req, res, 405, { error: 'method_not_allowed' }, { allow: allowed });
      return;
    }
    if (!isAuthorized(headerValue(req.headers.authorization), opts.token)) {
      fail(req, res, 401, 'unauthorized');
      return;
    }
    switch (match.route) {
      case 'health':
        send(req, res, 200, { app: 'awaiting', ok: true, hookVersion: HOOK_VERSION });
        return;
      case 'ping': {
        const seen = match.nonce !== undefined && opts.hasDoctorPing?.(match.nonce) === true;
        if (seen) send(req, res, 200, { ok: true });
        else fail(req, res, 404, 'not_found');
        return;
      }
      case 'events':
        if (!isJsonContentType(req.headers['content-type'])) {
          fail(req, res, 415, 'unsupported_media_type');
          return;
        }
        readBody(req, res);
        return;
    }
  };

  const server: Server = createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: timeouts.requestMs },
    (req, res) => {
      try {
        handle(req, res);
      } catch (err) {
        reportError(err);
        try {
          fail(req, res, 500, 'internal_error');
        } catch {
          req.socket.destroy();
        }
      }
    },
  );
  server.headersTimeout = timeouts.headersMs;
  server.keepAliveTimeout = timeouts.keepAliveMs;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.on('clientError', (_err, socket: Socket) => socket.destroy());
  server.on('error', reportError);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  return new Promise<EventServer>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once('error', onListenError);
    server.listen({ host: LOOPBACK_HOST, port: opts.port ?? 0, exclusive: true }, () => {
      server.off('error', onListenError);
      const addr = server.address() as AddressInfo;
      boundPort = addr.port;
      resolve({
        port: addr.port,
        address: addr.address,
        stats: () => ({ ...stats }),
        close,
      });
    });
  });
}
