// Pure debug-view state: merging snapshots and updates, filters and formatting (plan 01 §3.9).
// No React, no DOM, so it is unit-tested under plain-Node Vitest. Shows timestamps and measured
// durations only, never an estimate (H5).
import type { HookEventName } from '@awaiting/core';
import type {
  DebugEventRow,
  DebugPrivacyStatus,
  DebugServerStatus,
  DebugSnapshot,
  DebugTurnRow,
  DebugUpdate,
} from '../../../shared/debug-types';

/** Rows kept in memory per list; the oldest are dropped first. */
export const MAX_ROWS = 1000;

export interface DebugState {
  /** Newest first. */
  readonly events: readonly DebugEventRow[];
  /** Newest first (by start time). */
  readonly turns: readonly DebugTurnRow[];
  readonly server: DebugServerStatus;
  readonly privacy: DebugPrivacyStatus;
}

export const EMPTY_STATE: DebugState = Object.freeze({
  events: [],
  turns: [],
  server: { listening: false, port: null },
  privacy: { storeRawPrompt: false },
});

const byEventNewest = (a: DebugEventRow, b: DebugEventRow): number =>
  b.receivedAt - a.receivedAt || b.id - a.id;

const byTurnNewest = (a: DebugTurnRow, b: DebugTurnRow): number =>
  b.startedAt - a.startedAt ||
  (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0) ||
  b.seq - a.seq;

export const turnKey = (t: Pick<DebugTurnRow, 'sessionId' | 'seq'>): string =>
  `${t.sessionId}\u0000${String(t.seq)}`;

/** Union by event id (incoming wins), newest first, capped at `cap`. */
export function mergeEvents(
  current: readonly DebugEventRow[],
  incoming: readonly DebugEventRow[],
  cap: number = MAX_ROWS,
): DebugEventRow[] {
  if (incoming.length === 0) return current.slice(0, cap);
  const byId = new Map<number, DebugEventRow>();
  for (const row of current) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(byEventNewest).slice(0, Math.max(0, cap));
}

/** Union by (sessionId, seq) (incoming replaces), newest first, capped at `cap`. */
export function mergeTurns(
  current: readonly DebugTurnRow[],
  incoming: readonly DebugTurnRow[],
  cap: number = MAX_ROWS,
): DebugTurnRow[] {
  if (incoming.length === 0) return current.slice(0, cap);
  const byKey = new Map<string, DebugTurnRow>();
  for (const row of current) byKey.set(turnKey(row), row);
  for (const row of incoming) byKey.set(turnKey(row), row);
  return [...byKey.values()].sort(byTurnNewest).slice(0, Math.max(0, cap));
}

/** Replace everything with a snapshot (rows merged with nothing, so they are sorted and capped). */
export function fromSnapshot(snapshot: DebugSnapshot): DebugState {
  return {
    events: mergeEvents([], snapshot.events),
    turns: mergeTurns([], snapshot.turns),
    server: snapshot.server,
    privacy: snapshot.privacy,
  };
}

export function applyUpdate(state: DebugState, update: DebugUpdate): DebugState {
  if (update.events.length === 0 && update.turns.length === 0) return state;
  return {
    ...state,
    events: mergeEvents(state.events, update.events),
    turns: mergeTurns(state.turns, update.turns),
  };
}

export interface EventFilter {
  /** Event names to show. */
  readonly eventNames: ReadonlySet<HookEventName>;
  /** Only this session, or all when `null`. */
  readonly sessionId: string | null;
  /** Case-insensitive substring over tool name and notification type; blank matches all. */
  readonly text: string;
}

export function filterEvents(rows: readonly DebugEventRow[], filter: EventFilter): DebugEventRow[] {
  const needle = filter.text.trim().toLowerCase();
  return rows.filter((row) => {
    if (!filter.eventNames.has(row.eventName)) return false;
    if (filter.sessionId !== null && row.sessionId !== filter.sessionId) return false;
    if (needle === '') return true;
    return (
      (row.toolName?.toLowerCase().includes(needle) ?? false) ||
      (row.notificationType?.toLowerCase().includes(needle) ?? false)
    );
  });
}

/** Distinct session ids across events and turns, sorted. */
export function sessionIds(
  events: readonly DebugEventRow[],
  turns: readonly DebugTurnRow[] = [],
): string[] {
  const ids = new Set<string>();
  for (const e of events) ids.add(e.sessionId);
  for (const t of turns) ids.add(t.sessionId);
  return [...ids].sort();
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Local wall-clock time `HH:MM:SS.mmm`. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** A measured (past) duration: "850 ms", "45 s", "2 min 05 s", "1 h 02 min". */
export function formatMeasuredDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)} min ${pad(totalSeconds % 60)} s`;
  return `${String(Math.floor(totalMinutes / 60))} h ${pad(totalMinutes % 60)} min`;
}

/** Turn timing text: measured wall time when closed, "running since HH:MM:SS.mmm" when open. */
export function turnTiming(turn: DebugTurnRow): string {
  if (turn.status === 'running' || turn.endedAt === null) {
    return `running since ${formatClock(turn.startedAt)}`;
  }
  return formatMeasuredDuration(turn.endedAt - turn.startedAt);
}

/** A short, non-identifying display form of a session id. */
export function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}…`;
}
