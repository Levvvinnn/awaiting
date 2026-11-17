// In-memory store for `awaiting doctor` round-trip nonces (plan 01 §3.5, D1.22).
// Nonces are never written anywhere: they live here for at most `ttlMs`, capped at `max` entries.

/** A doctor nonce: 16 random bytes as 32 lowercase hex characters. */
export const NONCE_RE = /^[0-9a-f]{32}$/;

/** The synthetic event name `awaiting doctor` sends through the real hook. */
export const DOCTOR_PING_EVENT = 'AwaitingDoctorPing';

export const DOCTOR_PING_TTL_MS = 60_000;
export const DOCTOR_PING_MAX = 16;

export interface DoctorPingStore {
  /** Record a nonce as seen now. Invalid nonces are ignored. */
  add(nonce: string): void;
  /** True if the nonce was seen within the TTL. */
  has(nonce: string): boolean;
  /** Number of live entries (for tests). */
  size(): number;
}

export interface DoctorPingStoreOptions {
  now: () => number;
  ttlMs?: number;
  max?: number;
}

export function createDoctorPingStore(opts: DoctorPingStoreOptions): DoctorPingStore {
  const ttlMs = opts.ttlMs ?? DOCTOR_PING_TTL_MS;
  const max = opts.max ?? DOCTOR_PING_MAX;
  // Map keeps insertion order, so the first key is always the oldest.
  const seen = new Map<string, number>();

  const prune = (now: number): void => {
    for (const [nonce, at] of seen) {
      if (now - at < ttlMs) break;
      seen.delete(nonce);
    }
  };

  return {
    add(nonce) {
      if (!NONCE_RE.test(nonce)) return;
      const now = opts.now();
      prune(now);
      seen.delete(nonce);
      seen.set(nonce, now);
      while (seen.size > max) {
        const oldest = seen.keys().next();
        if (oldest.done === true) break;
        seen.delete(oldest.value);
      }
    },
    has(nonce) {
      prune(opts.now());
      return seen.has(nonce);
    },
    size() {
      prune(opts.now());
      return seen.size;
    },
  };
}
