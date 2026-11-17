/** Milliseconds elapsed from `startedAtMs` to `nowMs` (epoch ms, UTC), clamped to >= 0. */
export function elapsedMs(startedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) {
    throw new RangeError(
      `elapsedMs: expected finite epoch ms, got startedAtMs=${startedAtMs}, nowMs=${nowMs}`,
    );
  }
  return Math.max(0, nowMs - startedAtMs);
}
