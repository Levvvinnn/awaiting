// Debug-update batching for the main window (plan 01 §3.9). No Electron import: the sender and
// the timer are injected, so this is unit-tested under plain-Node Vitest.
//
// Updates from the ingestor are coalesced for at most `intervalMs` (≤ 100 ms), then sent in
// chunks of at most `MAX_UPDATE_ROWS` events and turns. Every chunk is checked with the shared
// `isDebugUpdate` validator before it leaves main; an invalid chunk is dropped and counted.
import {
  MAX_UPDATE_ROWS,
  isDebugUpdate,
  type DebugEventRow,
  type DebugTurnRow,
  type DebugUpdate,
} from '../../shared/debug-types';

/** Maximum coalescing delay (plan 01 §3.9: batched ≤ 100 ms). */
export const DEBUG_PUSH_INTERVAL_MS = 100;
/**
 * Rows kept while waiting (per list). The renderer keeps 1000 rows, and anything older than
 * that is covered by the snapshot, so a longer backlog is dropped oldest-first.
 */
export const MAX_BUFFERED_ROWS = 1000;

export interface UpdateBatcherOptions {
  /** Delivers one validated chunk. Returns false if nobody could receive it (it is not retried). */
  readonly send: (update: DebugUpdate) => boolean;
  readonly intervalMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called with a count when chunks fail validation (never with row content). */
  readonly onInvalid?: (droppedChunks: number) => void;
}

export interface UpdateBatcherStats {
  readonly sentChunks: number;
  readonly invalidChunks: number;
  readonly droppedRows: number;
}

export interface UpdateBatcher {
  push(update: DebugUpdate): void;
  /** Sends everything buffered now. */
  flush(): void;
  /** Cancels the timer and discards the buffer. Later pushes are ignored. */
  dispose(): void;
  stats(): UpdateBatcherStats;
}

const turnKey = (t: DebugTurnRow): string => `${t.sessionId}\u0000${String(t.seq)}`;

export function createUpdateBatcher(opts: UpdateBatcherOptions): UpdateBatcher {
  const intervalMs = Math.min(opts.intervalMs ?? DEBUG_PUSH_INTERVAL_MS, DEBUG_PUSH_INTERVAL_MS);
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    });
  const clearTimer =
    opts.clearTimer ??
    ((h: unknown): void => {
      clearTimeout(h as NodeJS.Timeout);
    });

  let events: DebugEventRow[] = [];
  // Insertion-ordered; a later row for the same turn replaces the earlier one and moves to the end.
  let turns = new Map<string, DebugTurnRow>();
  let timer: unknown = null;
  let disposed = false;
  let sentChunks = 0;
  let invalidChunks = 0;
  let droppedRows = 0;

  const flush = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (events.length === 0 && turns.size === 0) return;
    const ev = events;
    const tu = [...turns.values()];
    events = [];
    turns = new Map();

    const chunks = Math.ceil(Math.max(ev.length, tu.length) / MAX_UPDATE_ROWS);
    let invalid = 0;
    for (let i = 0; i < chunks; i++) {
      const from = i * MAX_UPDATE_ROWS;
      const chunk: DebugUpdate = {
        events: ev.slice(from, from + MAX_UPDATE_ROWS),
        turns: tu.slice(from, from + MAX_UPDATE_ROWS),
      };
      if (!isDebugUpdate(chunk)) {
        invalid++;
        continue;
      }
      if (opts.send(chunk)) sentChunks++;
    }
    if (invalid > 0) {
      invalidChunks += invalid;
      opts.onInvalid?.(invalid);
    }
  };

  return {
    push(update) {
      if (disposed) return;
      if (update.events.length === 0 && update.turns.length === 0) return;
      events.push(...update.events);
      if (events.length > MAX_BUFFERED_ROWS) {
        droppedRows += events.length - MAX_BUFFERED_ROWS;
        events = events.slice(events.length - MAX_BUFFERED_ROWS);
      }
      for (const t of update.turns) {
        const k = turnKey(t);
        turns.delete(k);
        turns.set(k, t);
      }
      while (turns.size > MAX_BUFFERED_ROWS) {
        const oldest = turns.keys().next().value;
        if (oldest === undefined) break;
        turns.delete(oldest);
        droppedRows++;
      }
      timer ??= setTimer(flush, intervalMs);
    },
    flush() {
      if (!disposed) flush();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      events = [];
      turns = new Map();
    },
    stats() {
      return { sentChunks, invalidChunks, droppedRows };
    },
  };
}
