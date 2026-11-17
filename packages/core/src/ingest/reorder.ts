// Reorder buffer for events from parallel async hook processes (plan 01 §3.7, D1.20).

/** Default hold time before an event is released, absorbing races between parallel async hooks. */
export const DEFAULT_REORDER_WINDOW_MS = 250;

/** An event waiting in the reorder buffer. */
export type Pending<T> = {
  readonly item: T;
  /** Hook-side `received_at`, epoch ms. */
  readonly receivedAt: number;
  /** Monotonic arrival counter at the server (tie-breaker for equal `receivedAt`). */
  readonly arrival: number;
};

/** Result of `takeReady`. */
export type TakeReadyResult<T> = {
  /** Released items, sorted by `(receivedAt, arrival)`. */
  readonly ready: T[];
  /** Still-held entries, in their input order. */
  readonly rest: Pending<T>[];
};

/** Releases entries with `nowMs − receivedAt ≥ windowMs`, sorted by `(receivedAt, arrival)`; the rest stay pending. */
export function takeReady<T>(
  pending: readonly Pending<T>[],
  nowMs: number,
  windowMs: number = DEFAULT_REORDER_WINDOW_MS,
): TakeReadyResult<T> {
  const ready: Pending<T>[] = [];
  const rest: Pending<T>[] = [];
  for (const p of pending) {
    if (nowMs - p.receivedAt >= windowMs) ready.push(p);
    else rest.push(p);
  }
  ready.sort((a, b) => a.receivedAt - b.receivedAt || a.arrival - b.arrival);
  return { ready: ready.map((p) => p.item), rest };
}
