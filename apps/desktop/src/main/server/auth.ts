// Request authentication for the loopback event server (plan 01 §3.5, D1.6).
// Pure functions over header values plus node:crypto; no I/O.
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** The only address the server ever binds to (CLAUDE.md hard rule 2). */
export const LOOPBACK_HOST = '127.0.0.1';

/** Token format shared with `server.json` and the hook (`TOKEN_RE` in hooks/awaiting-hook.js). */
export const TOKEN_RE = /^[0-9a-f]{64}$/;

/** A fresh 256-bit token as 64 lowercase hex characters; new on every app start (D1.6). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * DNS-rebinding guard: the `Host` header must name the loopback address and our port exactly.
 * Node's http client omits `:80` for port 80, so that one case also accepts the bare host.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const value = host.trim().toLowerCase();
  if (value === `${LOOPBACK_HOST}:${port}`) return true;
  return port === 80 && value === LOOPBACK_HOST;
}

/**
 * `Authorization: Bearer <token>` check in constant time. Buffers are compared only when their
 * lengths match (timingSafeEqual requires it); a length mismatch reveals nothing beyond the
 * fixed, public token length.
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  const presented = match?.[1];
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True if a `Content-Type` header is `application/json`, ignoring case and parameters. */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}
