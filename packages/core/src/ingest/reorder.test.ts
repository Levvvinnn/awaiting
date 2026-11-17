import { describe, expect, it } from 'vitest';
import { DEFAULT_REORDER_WINDOW_MS, takeReady, type Pending } from './reorder.js';

const p = (item: string, receivedAt: number, arrival: number): Pending<string> => ({
  item,
  receivedAt,
  arrival,
});

describe('takeReady', () => {
  it('defaults to a 250 ms window', () => {
    expect(DEFAULT_REORDER_WINDOW_MS).toBe(250);
    expect(takeReady([p('a', 1000, 0)], 1249).ready).toEqual([]);
    expect(takeReady([p('a', 1000, 0)], 1250).ready).toEqual(['a']);
  });

  it('returns nothing for an empty buffer', () => {
    expect(takeReady([], 10_000)).toEqual({ ready: [], rest: [] });
  });

  it('window boundary: released at exactly windowMs, held 1 ms before', () => {
    const pending = [p('a', 1000, 0)];
    expect(takeReady(pending, 1099, 100)).toEqual({ ready: [], rest: pending });
    expect(takeReady(pending, 1100, 100)).toEqual({ ready: ['a'], rest: [] });
  });

  it('sorts released events by receivedAt even if they arrived out of order', () => {
    const pending = [p('late-stamp', 1050, 0), p('early-stamp', 1000, 1), p('mid', 1020, 2)];
    expect(takeReady(pending, 2000).ready).toEqual(['early-stamp', 'mid', 'late-stamp']);
  });

  it('a tie on receivedAt keeps arrival order', () => {
    const pending = [p('second', 1000, 7), p('first', 1000, 3), p('third', 1000, 9)];
    expect(takeReady(pending, 2000).ready).toEqual(['first', 'second', 'third']);
  });

  it('a late event (old receivedAt) is released at once', () => {
    const pending = [p('fresh', 5000, 0), p('late', 1000, 1)];
    const { ready, rest } = takeReady(pending, 5010);
    expect(ready).toEqual(['late']);
    expect(rest).toEqual([pending[0]]);
  });

  it('keeps held entries in input order and splits correctly', () => {
    const pending = [p('h1', 900, 0), p('r1', 100, 1), p('h2', 950, 2), p('r2', 50, 3)];
    const { ready, rest } = takeReady(pending, 1000, 200);
    expect(ready).toEqual(['r2', 'r1']);
    expect(rest.map((x) => x.item)).toEqual(['h1', 'h2']);
  });

  it('window 0 releases everything not in the future', () => {
    const pending = [p('now', 1000, 0), p('future', 1001, 1)];
    expect(takeReady(pending, 1000, 0).ready).toEqual(['now']);
  });

  it('does not mutate the input', () => {
    const pending = Object.freeze([p('b', 20, 1), p('a', 10, 0)]);
    takeReady(pending, 1000);
    expect(pending.map((x) => x.item)).toEqual(['b', 'a']);
  });

  it('ready ∪ rest is the input (property)', () => {
    const pending: Pending<string>[] = [];
    for (let i = 0; i < 50; i++) pending.push(p(`e${i}`, (i * 37) % 500, i));
    for (const now of [0, 100, 250, 499, 750, 1000]) {
      const { ready, rest } = takeReady(pending, now, 250);
      expect(ready.length + rest.length).toBe(pending.length);
      const all = new Set([...ready, ...rest.map((x) => x.item)]);
      expect(all.size).toBe(pending.length);
      for (const r of rest) expect(now - r.receivedAt).toBeLessThan(250);
    }
  });
});
