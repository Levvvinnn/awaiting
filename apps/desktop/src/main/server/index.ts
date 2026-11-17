// Public entry of the loopback event server (plan 01 §3.5). No Electron imports: the app's main
// process passes the data dir, the event callback and the raw-prompt setting in.
import type { NormalizedEvent } from '@awaiting/core';
import { generateToken } from './auth';
import { createDoctorPingStore } from './doctor-ping';
import { startEventServer, type EventServer, type EventServerStats } from './http';
import { SERVER_INFO_VERSION, removeServerInfo, writeServerInfo } from './runtime-file';

export {
  LOOPBACK_HOST,
  TOKEN_RE,
  generateToken,
  isAllowedHost,
  isAuthorized,
  isJsonContentType,
} from './auth';
export {
  DOCTOR_PING_EVENT,
  DOCTOR_PING_MAX,
  DOCTOR_PING_TTL_MS,
  NONCE_RE,
  createDoctorPingStore,
  type DoctorPingStore,
  type DoctorPingStoreOptions,
} from './doctor-ping';
export {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUTS,
  HOOK_VERSION,
  MAX_HEADERS_COUNT,
  startEventServer,
  type EventServer,
  type EventServerOptions,
  type EventServerStats,
  type ServerTimeouts,
} from './http';
export {
  SERVER_FILE_NAME,
  SERVER_INFO_VERSION,
  isValidServerInfo,
  readServerInfo,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
  type ServerInfo,
} from './runtime-file';

export interface AwaitingServerOptions {
  /** Absolute data directory (`appDataDir()`); `server.json` is written here. */
  dataDir: string;
  /** Receives each validated, sanitized event after its 202 has been sent. */
  onEvent: (ev: NormalizedEvent) => void | Promise<void>;
  /** Read per request; return the `privacy.storeRawPrompt` setting (default off). */
  keepRawPrompt: () => boolean;
  /** Clock for `startedAt` and doctor-ping TTLs; default `Date.now`. */
  now?: () => number;
  /** Fixed port (tests / D1.5 reversal); default 0 = ephemeral. */
  port?: number;
  /** Process id written to `server.json`; default `process.pid`. */
  pid?: number;
  maxBodyBytes?: number;
  /** Unexpected server-level errors (never request bodies). */
  onError?: (err: unknown) => void;
}

export interface AwaitingServer {
  port: number;
  /** Always `127.0.0.1`. */
  address: string;
  /** This run's bearer token (also in `server.json`). */
  token: string;
  stats: () => EventServerStats;
  /** Stops the server and deletes `server.json` if it still names our pid. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Generates a fresh token, starts the server on 127.0.0.1 and publishes `server.json`
 * (`{ version, port, token, pid, startedAt }`, atomic, 0600). If publishing fails the server is
 * closed again and the error is rethrown.
 */
export async function startAwaitingServer(opts: AwaitingServerOptions): Promise<AwaitingServer> {
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const token = generateToken();
  const pings = createDoctorPingStore({ now });

  const server: EventServer = await startEventServer({
    token,
    ...(opts.port !== undefined && { port: opts.port }),
    ...(opts.maxBodyBytes !== undefined && { maxBodyBytes: opts.maxBodyBytes }),
    ...(opts.onError !== undefined && { onError: opts.onError }),
    onEvent: opts.onEvent,
    onDoctorPing: (nonce) => pings.add(nonce),
    hasDoctorPing: (nonce) => pings.has(nonce),
    keepRawPrompt: opts.keepRawPrompt,
  });

  try {
    writeServerInfo(opts.dataDir, {
      version: SERVER_INFO_VERSION,
      port: server.port,
      token,
      pid,
      startedAt: now(),
    });
  } catch (err) {
    await server.close();
    throw err;
  }

  let closing: Promise<void> | null = null;
  return {
    port: server.port,
    address: server.address,
    token,
    stats: server.stats,
    close: () => {
      closing ??= (async () => {
        removeServerInfo(opts.dataDir, pid);
        await server.close();
      })();
      return closing;
    },
  };
}
