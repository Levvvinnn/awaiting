import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_EVENTS,
  MAX_UPDATE_ROWS,
  isDebugEventRow,
  isDebugSnapshot,
  isDebugTurnRow,
  isDebugUpdate,
  type DebugEventRow,
  type DebugSnapshot,
  type DebugTurnRow,
} from './debug-types';

const EVENT: DebugEventRow = {
  id: 1,
  receivedAt: 1_763_380_000_000,
  eventName: 'PreToolUse',
  sessionId: 'sess-1',
  turnSeq: 1,
  toolName: 'Bash',
  notificationType: null,
  agentType: null,
};

const RUNNING: DebugTurnRow = {
  sessionId: 'sess-1',
  seq: 1,
  status: 'running',
  startedAt: 1_763_380_000_000,
  endedAt: null,
  endReason: null,
  eventCount: 3,
};

const DONE: DebugTurnRow = {
  ...RUNNING,
  seq: 2,
  status: 'done',
  endedAt: 1_763_380_060_000,
  endReason: 'stop',
};

const SNAPSHOT: DebugSnapshot = {
  events: [EVENT],
  turns: [RUNNING, DONE],
  server: { listening: true, port: 49152 },
  privacy: { storeRawPrompt: false },
};

const without = (o: object, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...o };
  delete copy[key];
  return copy;
};

describe('isDebugEventRow', () => {
  it('accepts a valid row and an orphan row', () => {
    expect(isDebugEventRow(EVENT)).toBe(true);
    expect(isDebugEventRow({ ...EVENT, turnSeq: null, toolName: null })).toBe(true);
  });

  it.each(Object.keys(EVENT))('rejects a row missing %s', (key) => {
    expect(isDebugEventRow(without(EVENT, key))).toBe(false);
  });

  it('rejects extra fields (e.g. smuggled text)', () => {
    expect(isDebugEventRow({ ...EVENT, prompt: 'hello' })).toBe(false);
  });

  it.each([
    ['id', 0],
    ['id', 1.5],
    ['id', '1'],
    ['receivedAt', Number.NaN],
    ['receivedAt', -1],
    ['eventName', 'MadeUpEvent'],
    ['sessionId', ''],
    ['sessionId', 42],
    ['sessionId', 'x'.repeat(2000)],
    ['turnSeq', 0],
    ['toolName', 5],
    ['notificationType', {}],
    ['agentType', undefined],
  ])('rejects %s = %j', (key, value) => {
    expect(isDebugEventRow({ ...EVENT, [key]: value })).toBe(false);
  });

  it('rejects non-plain objects', () => {
    expect(isDebugEventRow(null)).toBe(false);
    expect(isDebugEventRow([EVENT])).toBe(false);
    class Row {
      constructor() {
        Object.assign(this, EVENT);
      }
    }
    expect(isDebugEventRow(new Row())).toBe(false);
  });
});

describe('isDebugTurnRow', () => {
  it('accepts running and closed turns', () => {
    expect(isDebugTurnRow(RUNNING)).toBe(true);
    expect(isDebugTurnRow(DONE)).toBe(true);
  });

  it.each(Object.keys(RUNNING))('rejects a turn missing %s', (key) => {
    expect(isDebugTurnRow(without(RUNNING, key))).toBe(false);
  });

  it('rejects extra fields, unknown status or reason, and inconsistent ends', () => {
    expect(isDebugTurnRow({ ...DONE, estimateMs: 1 })).toBe(false);
    expect(isDebugTurnRow({ ...RUNNING, status: 'paused' })).toBe(false);
    expect(isDebugTurnRow({ ...DONE, endReason: 'because' })).toBe(false);
    expect(isDebugTurnRow({ ...RUNNING, endedAt: 5 })).toBe(false);
    expect(isDebugTurnRow({ ...DONE, endedAt: null })).toBe(false);
    expect(isDebugTurnRow({ ...DONE, endReason: null })).toBe(false);
    expect(isDebugTurnRow({ ...RUNNING, eventCount: -1 })).toBe(false);
  });
});

describe('isDebugUpdate', () => {
  it('accepts valid and empty updates', () => {
    expect(isDebugUpdate({ events: [EVENT], turns: [DONE] })).toBe(true);
    expect(isDebugUpdate({ events: [], turns: [] })).toBe(true);
  });

  it('rejects missing, extra or wrong-typed fields and bad rows', () => {
    expect(isDebugUpdate({ events: [] })).toBe(false);
    expect(isDebugUpdate({ events: [], turns: [], server: SNAPSHOT.server })).toBe(false);
    expect(isDebugUpdate({ events: {}, turns: [] })).toBe(false);
    expect(isDebugUpdate({ events: [{ ...EVENT, id: -1 }], turns: [] })).toBe(false);
  });

  it('rejects batches over the row cap', () => {
    const events = Array.from({ length: MAX_UPDATE_ROWS + 1 }, (_, i) => ({ ...EVENT, id: i + 1 }));
    expect(isDebugUpdate({ events, turns: [] })).toBe(false);
    expect(isDebugUpdate({ events: events.slice(1), turns: [] })).toBe(true);
  });
});

describe('isDebugSnapshot', () => {
  it('accepts a valid snapshot, including a stopped server', () => {
    expect(isDebugSnapshot(SNAPSHOT)).toBe(true);
    expect(isDebugSnapshot({ ...SNAPSHOT, server: { listening: false, port: null } })).toBe(true);
  });

  it.each(Object.keys(SNAPSHOT))('rejects a snapshot missing %s', (key) => {
    expect(isDebugSnapshot(without(SNAPSHOT, key))).toBe(false);
  });

  it('rejects extra fields anywhere, bad ports and bad privacy flags', () => {
    expect(isDebugSnapshot({ ...SNAPSHOT, token: 'abc' })).toBe(false);
    expect(isDebugSnapshot({ ...SNAPSHOT, server: { listening: true, port: 1, token: 'x' } })).toBe(
      false,
    );
    expect(isDebugSnapshot({ ...SNAPSHOT, server: { listening: true, port: 70000 } })).toBe(false);
    expect(isDebugSnapshot({ ...SNAPSHOT, server: { listening: 'yes', port: 1 } })).toBe(false);
    expect(isDebugSnapshot({ ...SNAPSHOT, privacy: { storeRawPrompt: 'off' } })).toBe(false);
    expect(isDebugSnapshot({ ...SNAPSHOT, privacy: {} })).toBe(false);
  });

  it('rejects more than MAX_SNAPSHOT_EVENTS events', () => {
    const events = Array.from({ length: MAX_SNAPSHOT_EVENTS + 1 }, (_, i) => ({
      ...EVENT,
      id: i + 1,
    }));
    expect(isDebugSnapshot({ ...SNAPSHOT, events })).toBe(false);
  });
});
