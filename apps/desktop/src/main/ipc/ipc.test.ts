import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SNAPSHOT_EVENTS,
  MAX_SNAPSHOT_TURNS,
  MAX_UPDATE_ROWS,
  isDebugSnapshot,
  isDebugUpdate,
  type DebugEventRow,
  type DebugTurnRow,
  type DebugUpdate,
} from '../../shared/debug-types';
import { DEBUG_PUSH_INTERVAL_MS, MAX_BUFFERED_ROWS, createUpdateBatcher } from './debug-batch';
import {
  SERVER_NOT_LISTENING,
  SNAPSHOT_TURN_WINDOW_MS,
  buildDebugSnapshot,
} from './debug-snapshot';
import { isMainWindowSender } from './sender';

const T0 = 1_763_380_000_000;

const ev = (id: number, over: Partial<DebugEventRow> = {}): DebugEventRow => ({
  id,
  receivedAt: T0 + id,
  eventName: 'PreToolUse',
  sessionId: 's1',
  turnSeq: 1,
  toolName: 'Bash',
  notificationType: null,
  agentType: null,
  ...over,
});

const turn = (seq: number, over: Partial<DebugTurnRow> = {}): DebugTurnRow => ({
  sessionId: 's1',
  seq,
  status: 'running',
  startedAt: T0 + seq,
  endedAt: null,
  endReason: null,
  eventCount: 1,
  ...over,
});

/** Manual timer: `fire()` runs the scheduled callback. */
function manualTimer() {
  let pending: (() => void) | null = null;
  let delay: number | null = null;
  return {
    setTimer: (fn: () => void, ms: number) => {
      pending = fn;
      delay = ms;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get scheduled() {
      return pending !== null;
    },
    get delay() {
      return delay;
    },
  };
}

describe('createUpdateBatcher', () => {
  it('coalesces pushes into one send after at most 100 ms', () => {
    const t = manualTimer();
    const sent: DebugUpdate[] = [];
    const b = createUpdateBatcher({ send: (u) => sent.push(u) > 0, ...t });
    b.push({ events: [ev(1)], turns: [turn(1)] });
    b.push({ events: [ev(2)], turns: [] });
    expect(sent).toHaveLength(0);
    expect(t.delay).toBeLessThanOrEqual(DEBUG_PUSH_INTERVAL_MS);
    t.fire();
    expect(sent).toEqual([{ events: [ev(1), ev(2)], turns: [turn(1)] }]);
    expect(t.scheduled).toBe(false);
  });

  it('never schedules longer than 100 ms even if asked to', () => {
    const t = manualTimer();
    const b = createUpdateBatcher({ send: () => true, intervalMs: 5_000, ...t });
    b.push({ events: [ev(1)], turns: [] });
    expect(t.delay).toBe(DEBUG_PUSH_INTERVAL_MS);
  });

  it('keeps only the latest row per turn', () => {
    const t = manualTimer();
    const sent: DebugUpdate[] = [];
    const b = createUpdateBatcher({ send: (u) => sent.push(u) > 0, ...t });
    b.push({ events: [], turns: [turn(1), turn(2)] });
    const closed = turn(1, { status: 'done', endedAt: T0 + 9, endReason: 'stop', eventCount: 3 });
    b.push({ events: [], turns: [closed] });
    t.fire();
    expect(sent[0]?.turns).toEqual([turn(2), closed]);
  });

  it('splits into chunks of at most MAX_UPDATE_ROWS and every chunk validates', () => {
    const t = manualTimer();
    const sent: DebugUpdate[] = [];
    const b = createUpdateBatcher({ send: (u) => sent.push(u) > 0, ...t });
    const n = MAX_UPDATE_ROWS * 2 + 5;
    b.push({ events: Array.from({ length: n }, (_, i) => ev(i + 1)), turns: [] });
    t.fire();
    expect(sent.map((u) => u.events.length)).toEqual([MAX_UPDATE_ROWS, MAX_UPDATE_ROWS, 5]);
    expect(sent.every((u) => isDebugUpdate(u))).toBe(true);
    expect(b.stats().sentChunks).toBe(3);
  });

  it('drops (and counts) chunks that fail the shared validator', () => {
    const t = manualTimer();
    const send = vi.fn(() => true);
    const onInvalid = vi.fn();
    const b = createUpdateBatcher({ send, onInvalid, ...t });
    const bad = { ...ev(1), extra: 'x' } as unknown as DebugEventRow;
    b.push({ events: [bad], turns: [] });
    t.fire();
    expect(send).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledWith(1);
    expect(b.stats().invalidChunks).toBe(1);
  });

  it('bounds the backlog, dropping the oldest rows', () => {
    const t = manualTimer();
    const sent: DebugUpdate[] = [];
    const b = createUpdateBatcher({ send: (u) => sent.push(u) > 0, ...t });
    for (let i = 1; i <= MAX_BUFFERED_ROWS + 10; i++) b.push({ events: [ev(i)], turns: [] });
    t.fire();
    const ids = sent.flatMap((u) => u.events.map((e) => e.id));
    expect(ids).toHaveLength(MAX_BUFFERED_ROWS);
    expect(ids[0]).toBe(11);
    expect(b.stats().droppedRows).toBe(10);
  });

  it('ignores empty updates, and flush/dispose behave', () => {
    const t = manualTimer();
    const send = vi.fn(() => true);
    const b = createUpdateBatcher({ send, ...t });
    b.push({ events: [], turns: [] });
    expect(t.scheduled).toBe(false);
    b.push({ events: [ev(1)], turns: [] });
    b.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.scheduled).toBe(false);
    b.push({ events: [ev(2)], turns: [] });
    b.dispose();
    t.fire();
    b.push({ events: [ev(3)], turns: [] });
    b.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('isMainWindowSender', () => {
  const mainFrame = { name: 'main-frame' };
  const mainContents = { mainFrame };
  const main = { isDestroyed: () => false, webContents: mainContents };

  it('accepts the top frame of the main window', () => {
    expect(isMainWindowSender({ sender: mainContents, senderFrame: mainFrame }, main)).toBe(true);
  });

  it('refuses another window (e.g. the avatar)', () => {
    const avatarFrame = {};
    const avatar = { mainFrame: avatarFrame };
    expect(isMainWindowSender({ sender: avatar, senderFrame: avatarFrame }, main)).toBe(false);
  });

  it('refuses a subframe, a missing frame, and a missing or destroyed main window', () => {
    expect(isMainWindowSender({ sender: mainContents, senderFrame: {} }, main)).toBe(false);
    expect(isMainWindowSender({ sender: mainContents, senderFrame: null }, main)).toBe(false);
    expect(isMainWindowSender({ sender: mainContents, senderFrame: mainFrame }, undefined)).toBe(
      false,
    );
    const destroyed = { isDestroyed: () => true, webContents: mainContents };
    expect(isMainWindowSender({ sender: mainContents, senderFrame: mainFrame }, destroyed)).toBe(
      false,
    );
  });
});

describe('buildDebugSnapshot', () => {
  const repo = (
    events: DebugEventRow[],
    turns: DebugTurnRow[],
    storeRawPrompt = false,
    seen: { since?: number; limit?: number } = {},
  ) => ({
    recentEvents: (limit: number) => {
      seen.limit = limit;
      return events.slice(0, limit);
    },
    currentTurns: (since: number) => {
      seen.since = since;
      return turns;
    },
    getSetting: (() => storeRawPrompt) as never,
  });

  it('builds a valid snapshot with server status and privacy setting', () => {
    const seen: { since?: number; limit?: number } = {};
    const snap = buildDebugSnapshot({
      repo: repo([ev(2), ev(1)], [turn(1)], false, seen),
      server: () => ({ listening: true, port: 51234 }),
      now: () => T0 + SNAPSHOT_TURN_WINDOW_MS,
    });
    expect(isDebugSnapshot(snap)).toBe(true);
    expect(snap.server).toEqual({ listening: true, port: 51234 });
    expect(snap.privacy).toEqual({ storeRawPrompt: false });
    expect(seen).toEqual({ limit: MAX_SNAPSHOT_EVENTS, since: T0 });
  });

  it('reports a server that is not listening', () => {
    const snap = buildDebugSnapshot({
      repo: repo([], [], true),
      server: () => SERVER_NOT_LISTENING,
      now: () => T0,
    });
    expect(snap.server).toEqual({ listening: false, port: null });
    expect(snap.privacy.storeRawPrompt).toBe(true);
  });

  it('caps turns at MAX_SNAPSHOT_TURNS', () => {
    const many = Array.from({ length: MAX_SNAPSHOT_TURNS + 3 }, (_, i) => turn(i + 1));
    const snap = buildDebugSnapshot({
      repo: repo([], many),
      server: () => SERVER_NOT_LISTENING,
      now: () => T0,
    });
    expect(snap.turns).toHaveLength(MAX_SNAPSHOT_TURNS);
  });

  it('throws instead of returning an invalid snapshot', () => {
    const bad = { ...ev(1), eventName: 'NotAHook' } as unknown as DebugEventRow;
    expect(() =>
      buildDebugSnapshot({
        repo: repo([bad], []),
        server: () => SERVER_NOT_LISTENING,
        now: () => T0,
      }),
    ).toThrow(/validation/);
  });
});
