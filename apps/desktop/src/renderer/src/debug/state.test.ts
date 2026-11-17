import { HOOK_EVENT_NAMES, type HookEventName } from '@awaiting/core';
import { describe, expect, it } from 'vitest';
import type { DebugEventRow, DebugTurnRow } from '../../../shared/debug-types';
import { isDebugSnapshot } from '../../../shared/debug-types';
import { MOCK_SNAPSHOT } from './mock';
import {
  EMPTY_STATE,
  MAX_ROWS,
  applyUpdate,
  filterEvents,
  formatClock,
  formatMeasuredDuration,
  fromSnapshot,
  mergeEvents,
  mergeTurns,
  sessionIds,
  turnTiming,
} from './state';

const T0 = 1_763_380_000_000;

function evRow(id: number, extra: Partial<DebugEventRow> = {}): DebugEventRow {
  return {
    id,
    receivedAt: T0 + id,
    eventName: 'PreToolUse',
    sessionId: 's1',
    turnSeq: 1,
    toolName: 'Bash',
    notificationType: null,
    agentType: null,
    ...extra,
  };
}

function turnRow(seq: number, extra: Partial<DebugTurnRow> = {}): DebugTurnRow {
  return {
    sessionId: 's1',
    seq,
    status: 'running',
    startedAt: T0 + seq * 1000,
    endedAt: null,
    endReason: null,
    eventCount: 1,
    ...extra,
  };
}

describe('mergeEvents', () => {
  it('dedupes by id (incoming wins) and sorts newest first', () => {
    const merged = mergeEvents([evRow(1), evRow(2)], [evRow(3), evRow(2, { toolName: 'Read' })]);
    expect(merged.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(merged[1]?.toolName).toBe('Read');
  });

  it('orders by receivedAt, then id, so late-arriving events land in place', () => {
    const late = evRow(10, { receivedAt: T0 + 1.5 });
    expect(mergeEvents([evRow(1), evRow(2)], [late]).map((r) => r.id)).toEqual([2, 10, 1]);
  });

  it(`caps at ${String(MAX_ROWS)} rows, dropping the oldest`, () => {
    const many = Array.from({ length: MAX_ROWS }, (_, i) => evRow(i + 1));
    const merged = mergeEvents(many, [evRow(MAX_ROWS + 1), evRow(MAX_ROWS + 2)]);
    expect(merged).toHaveLength(MAX_ROWS);
    expect(merged[0]?.id).toBe(MAX_ROWS + 2);
    expect(merged.at(-1)?.id).toBe(3);
  });

  it('does not mutate its inputs', () => {
    const current = Object.freeze([evRow(1)]);
    const incoming = Object.freeze([evRow(2)]);
    mergeEvents(current, incoming);
    expect(current.map((r) => r.id)).toEqual([1]);
  });
});

describe('mergeTurns', () => {
  it('replaces a turn by (sessionId, seq) and keeps other sessions apart', () => {
    const closed = turnRow(1, { status: 'done', endedAt: T0 + 9000, endReason: 'stop' });
    const other = turnRow(1, { sessionId: 's2', startedAt: T0 });
    const merged = mergeTurns([turnRow(1), turnRow(2)], [closed, other]);
    expect(merged).toHaveLength(3);
    expect(merged.find((t) => t.sessionId === 's1' && t.seq === 1)?.status).toBe('done');
    expect(merged.map((t) => `${t.sessionId}#${String(t.seq)}`)).toEqual(['s1#2', 's1#1', 's2#1']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => turnRow(i + 1));
    expect(mergeTurns([], many)).toHaveLength(MAX_ROWS);
  });
});

describe('fromSnapshot / applyUpdate', () => {
  it('builds state from a snapshot and merges updates', () => {
    const state = fromSnapshot({
      events: [evRow(1)],
      turns: [turnRow(1)],
      server: { listening: true, port: 5000 },
      privacy: { storeRawPrompt: false },
    });
    const next = applyUpdate(state, {
      events: [evRow(2)],
      turns: [turnRow(1, { status: 'done', endedAt: T0 + 5000, endReason: 'stop' })],
    });
    expect(next.events.map((r) => r.id)).toEqual([2, 1]);
    expect(next.turns[0]?.status).toBe('done');
    expect(next.server).toEqual({ listening: true, port: 5000 });
  });

  it('returns the same state object for an empty update', () => {
    expect(applyUpdate(EMPTY_STATE, { events: [], turns: [] })).toBe(EMPTY_STATE);
  });
});

describe('filterEvents', () => {
  const rows = [
    evRow(1, { eventName: 'PreToolUse', toolName: 'Bash' }),
    evRow(2, { eventName: 'Notification', toolName: null, notificationType: 'idle_prompt' }),
    evRow(3, { eventName: 'PreToolUse', toolName: 'Read', sessionId: 's2' }),
    evRow(4, { eventName: 'Stop', toolName: null }),
  ];
  const all = new Set<HookEventName>(HOOK_EVENT_NAMES);

  it('passes everything with all names, no session and no text', () => {
    expect(filterEvents(rows, { eventNames: all, sessionId: null, text: '' })).toHaveLength(4);
  });

  it('filters by event name', () => {
    const only = new Set<HookEventName>(['Stop']);
    expect(
      filterEvents(rows, { eventNames: only, sessionId: null, text: '' }).map((r) => r.id),
    ).toEqual([4]);
    expect(filterEvents(rows, { eventNames: new Set(), sessionId: null, text: '' })).toEqual([]);
  });

  it('filters by session', () => {
    expect(
      filterEvents(rows, { eventNames: all, sessionId: 's2', text: '' }).map((r) => r.id),
    ).toEqual([3]);
  });

  it('matches text case-insensitively against tool name and notification type only', () => {
    const ids = (text: string) =>
      filterEvents(rows, { eventNames: all, sessionId: null, text }).map((r) => r.id);
    expect(ids('bash')).toEqual([1]);
    expect(ids('  IDLE ')).toEqual([2]);
    expect(ids('s2')).toEqual([]); // session ids are not searched
    expect(ids('Stop')).toEqual([]); // event names are filtered by checkbox, not text
  });

  it('combines all filters', () => {
    const tools = new Set<HookEventName>(['PreToolUse']);
    expect(filterEvents(rows, { eventNames: tools, sessionId: 's1', text: 'read' })).toEqual([]);
  });
});

describe('sessionIds', () => {
  it('lists distinct sessions from events and turns, sorted', () => {
    expect(
      sessionIds(
        [evRow(1, { sessionId: 'b' }), evRow(2, { sessionId: 'a' })],
        [turnRow(1, { sessionId: 'c' }), turnRow(2, { sessionId: 'a' })],
      ),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('formatting (measured values only)', () => {
  it('formats local clock time as HH:MM:SS.mmm', () => {
    expect(formatClock(new Date(2026, 10, 17, 9, 5, 3, 7).getTime())).toBe('09:05:03.007');
    expect(formatClock(new Date(2026, 10, 17, 23, 59, 59, 999).getTime())).toBe('23:59:59.999');
  });

  it.each([
    [0, '0 ms'],
    [850, '850 ms'],
    [45_000, '45 s'],
    [59_999, '59 s'],
    [125_000, '2 min 05 s'],
    [3_599_000, '59 min 59 s'],
    [3_720_000, '1 h 02 min'],
    [-1, '—'],
    [Number.NaN, '—'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatMeasuredDuration(ms)).toBe(text);
  });

  it('shows measured wall time for closed turns and "running since" for open ones', () => {
    const start = new Date(2026, 10, 17, 10, 0, 0, 0).getTime();
    expect(turnTiming(turnRow(1, { startedAt: start }))).toBe('running since 10:00:00.000');
    expect(
      turnTiming(
        turnRow(1, {
          startedAt: start,
          status: 'done',
          endedAt: start + 125_000,
          endReason: 'stop',
        }),
      ),
    ).toBe('2 min 05 s');
  });
});

describe('mock snapshot', () => {
  it('passes the same validator the preload applies to real payloads', () => {
    expect(isDebugSnapshot(MOCK_SNAPSHOT)).toBe(true);
  });
});
