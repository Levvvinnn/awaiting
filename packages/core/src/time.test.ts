import { describe, expect, it } from 'vitest';
import { elapsedMs } from './time.js';
import { elapsedMs as elapsedMsFromIndex } from './index.js';

describe('elapsedMs', () => {
  it('returns the difference for a normal interval', () => {
    expect(elapsedMs(1_000, 4_500)).toBe(3_500);
  });

  it('returns 0 when start and now are equal', () => {
    expect(elapsedMs(1_700_000_000_000, 1_700_000_000_000)).toBe(0);
  });

  it('clamps clock skew (now before start) to 0', () => {
    expect(elapsedMs(5_000, 4_000)).toBe(0);
  });

  it.each([
    ['NaN start', Number.NaN, 1_000],
    ['NaN now', 1_000, Number.NaN],
    ['Infinity start', Number.POSITIVE_INFINITY, 1_000],
    ['-Infinity now', 1_000, Number.NEGATIVE_INFINITY],
  ])('throws RangeError on non-finite input (%s)', (_label, start, now) => {
    expect(() => elapsedMs(start, now)).toThrow(RangeError);
  });

  it('is never negative across a grid of inputs', () => {
    const points = [0, 1, 999, 1_000, 60_000, 1_700_000_000_000];
    for (const start of points) {
      for (const now of points) {
        expect(elapsedMs(start, now)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is re-exported from the package entry point', () => {
    expect(elapsedMsFromIndex).toBe(elapsedMs);
  });
});
