// `<dataDir>/server.json`: how the hook and `awaiting doctor` find the running app (plan 01 §3.2).
// Shape matches what hooks/awaiting-hook.js `readServerInfo` validates: integer port 1–65535,
// 64-hex token, positive integer pid. Written atomically (tmp + rename), mode 0600 on POSIX.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { TOKEN_RE } from './auth';

export const SERVER_FILE_NAME = 'server.json';
export const SERVER_INFO_VERSION = 1;

/** Contents of `server.json`. */
export interface ServerInfo {
  version: typeof SERVER_INFO_VERSION;
  port: number;
  /** 64 lowercase hex characters (256 bits). */
  token: string;
  /** The app's process id; the hook skips the request if this pid is not alive. */
  pid: number;
  /** Epoch ms when the server started. */
  startedAt: number;
}

export function serverInfoPath(dataDir: string): string {
  return join(dataDir, SERVER_FILE_NAME);
}

/** Same checks as the hook and doctor; returns `null` for anything they would reject. */
export function isValidServerInfo(value: unknown): value is ServerInfo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const { port, token, pid, startedAt } = v;
  return (
    v['version'] === SERVER_INFO_VERSION &&
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    typeof token === 'string' &&
    TOKEN_RE.test(token) &&
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof startedAt === 'number' &&
    Number.isFinite(startedAt)
  );
}

/** Reads and validates `server.json`; `null` if missing, unreadable or invalid. Never throws. */
export function readServerInfo(dataDir: string): ServerInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(serverInfoPath(dataDir), 'utf8'));
    return isValidServerInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

/** Windows can refuse to replace a file another process has open (e.g. a hook reading it). */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || attempt >= RENAME_ATTEMPTS) throw err;
      if (!RENAME_RETRY_CODES.has(code)) throw err;
      // Short synchronous back-off; this runs once at startup.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * attempt);
    }
  }
}

/**
 * Atomically writes `server.json`: a fresh tmp file in the same directory (created with mode
 * 0600, `wx` so it is never shared), fsync, chmod 0600 against a permissive umask, then rename.
 * The data directory is created with mode 0700 if missing. Throws on invalid info or I/O failure;
 * a failed write leaves no tmp file and does not touch an existing `server.json`.
 */
export function writeServerInfo(dataDir: string, info: ServerInfo): void {
  if (!isValidServerInfo(info)) throw new TypeError('writeServerInfo: invalid server info');
  // Fixed key order and only the known keys, whatever else the caller's object carries.
  const content: ServerInfo = {
    version: info.version,
    port: info.port,
    token: info.token,
    pid: info.pid,
    startedAt: info.startedAt,
  };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = serverInfoPath(dataDir);
  const tmp = join(
    dataDir,
    `.${SERVER_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | null = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(content)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameWithRetry(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already failing; the original error is what matters.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The tmp file may already be gone (rename succeeded partially or never created).
    }
    throw err;
  }
}

/**
 * Deletes `server.json` only if it names `pid` (so a second app instance's file survives).
 * Returns true if the file was removed. Never throws.
 */
export function removeServerInfo(dataDir: string, pid: number): boolean {
  const current = readServerInfo(dataDir);
  if (current === null || current.pid !== pid) return false;
  try {
    unlinkSync(serverInfoPath(dataDir));
    return true;
  } catch {
    return false;
  }
}
