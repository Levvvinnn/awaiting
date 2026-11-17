// Event pipeline (plan 01 §3.7, §3.8, §3.11): reorder buffer → core.stepTurn → repo, plus the
// inactivity sweep. Turn decisions come from @awaiting/core; this module only sequences them,
// keeps the per-session state in memory and reports what changed. No Electron import, and the
// clock is injected so tests are deterministic.
import {
  DEFAULT_REORDER_WINDOW_MS,
  stepTurn,
  sweepInactive,
  takeReady,
  type NormalizedEvent,
  type Pending,
  type SessionTurnState,
  type TurnConfig,
} from '@awaiting/core';
import {
  MAX_UPDATE_ROWS,
  type DebugEventRow,
  type DebugTurnRow,
  type DebugUpdate,
} from '../../shared/debug-types';
import type { Repo } from '../store/repo';

/** Recommended `tick()` period (plan 01 §3.11). */
export const TICK_INTERVAL_MS = 100;
/** Recommended `sweep()` period (plan 01 §3.11). */
export const SWEEP_INTERVAL_MS = 30_000;
/** Buffer bound: beyond this, everything pending is applied at once (in order) instead of waiting. */
export const DEFAULT_MAX_PENDING = 10_000;
/** Largest `receivedAt` lead over `now()` honoured by the reorder buffer. */
export const MAX_FUTURE_SKEW_MS = 1_000;

export interface IngestorOptions {
  /** Reorder window in ms (default `DEFAULT_REORDER_WINDOW_MS`, 250). */
  readonly reorderWindowMs?: number;
  /** Maximum buffered events before a forced in-order flush (default `DEFAULT_MAX_PENDING`). */
  readonly maxPending?: number;
  /** Called with errors from the repo or `onChange`. Never receives event bodies. */
  readonly onError?: (err: unknown) => void;
}

/** Counters for diagnostics (no event content). */
export interface IngestorStats {
  readonly applied: number;
  readonly failed: number;
  readonly sweptClosed: number;
}

type Cfg = TurnConfig | (() => TurnConfig);

export class Ingestor {
  private readonly states = new Map<string, SessionTurnState>();
  private pending: Pending<NormalizedEvent>[] = [];
  private arrival = 0;
  private readonly windowMs: number;
  private readonly maxPending: number;
  private readonly onError: (err: unknown) => void;
  private applied = 0;
  private failed = 0;
  private sweptClosed = 0;

  /**
   * Restores per-session turn state from the store (`repo.loadSessionStates()`) immediately.
   * `cfg` may be a getter so settings changes apply to the next sweep.
   */
  constructor(
    private readonly repo: Repo,
    private readonly cfg: Cfg,
    private readonly now: () => number,
    private readonly onChange: (u: DebugUpdate) => void,
    options: IngestorOptions = {},
  ) {
    this.windowMs = options.reorderWindowMs ?? DEFAULT_REORDER_WINDOW_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.onError = options.onError ?? (() => undefined);
    for (const s of repo.loadSessionStates()) this.states.set(s.sessionId, s);
  }

  /**
   * Buffers a parsed event. It is applied by a later `tick()` once it is `reorderWindowMs` old.
   * A `receivedAt` more than `MAX_FUTURE_SKEW_MS` ahead of `now()` (clock skew) is clamped for
   * buffering, so it cannot be held indefinitely; the stored event keeps its own `receivedAt`.
   */
  enqueue(ev: NormalizedEvent): void {
    const key = Math.min(ev.receivedAt, this.now() + MAX_FUTURE_SKEW_MS);
    this.pending.push({ item: ev, receivedAt: key, arrival: this.arrival++ });
    if (this.pending.length > this.maxPending) this.flush();
  }

  /** Applies every event whose reorder window has passed, in `(receivedAt, arrival)` order. Returns the count applied. */
  tick(): number {
    if (this.pending.length === 0) return 0;
    const { ready, rest } = takeReady(this.pending, this.now(), this.windowMs);
    this.pending = rest;
    return this.applyAll(ready);
  }

  /** Applies everything buffered regardless of the window (shutdown, overflow). Returns the count applied. */
  flush(): number {
    const { ready } = takeReady(this.pending, Number.POSITIVE_INFINITY, this.windowMs);
    this.pending = [];
    return this.applyAll(ready);
  }

  /**
   * Closes silent open turns as `interrupted/inactivity` (`core.sweepInactive` at `now()`).
   * Releases ready events first; sessions that still have buffered events are skipped, since
   * they are active. Returns the number of turns closed.
   */
  sweep(): number {
    this.tick();
    const nowMs = this.now();
    const cfg = this.config();
    const busy = new Set(this.pending.map((p) => p.item.sessionId));
    const turns: DebugTurnRow[] = [];
    let closed = 0;
    for (const [sessionId, state] of this.states) {
      if (busy.has(sessionId)) continue;
      const step = sweepInactive(state, nowMs, cfg);
      if (step.effects.length === 0) continue;
      try {
        turns.push(...this.repo.applySweep(sessionId, step));
      } catch (err) {
        this.failed++;
        this.report(err);
        continue;
      }
      this.states.set(sessionId, step.state);
      closed++;
    }
    this.sweptClosed += closed;
    this.emit([], turns);
    return closed;
  }

  /** Number of events waiting in the reorder buffer. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Current in-memory turn state of a session (read-only snapshot). */
  sessionState(sessionId: string): SessionTurnState | undefined {
    return this.states.get(sessionId);
  }

  stats(): IngestorStats {
    return { applied: this.applied, failed: this.failed, sweptClosed: this.sweptClosed };
  }

  private config(): TurnConfig {
    return typeof this.cfg === 'function' ? this.cfg() : this.cfg;
  }

  private applyAll(events: readonly NormalizedEvent[]): number {
    if (events.length === 0) return 0;
    const cfg = this.config();
    const rows: DebugEventRow[] = [];
    const turns: DebugTurnRow[] = [];
    let n = 0;
    for (const ev of events) {
      const step = stepTurn(this.states.get(ev.sessionId) ?? null, ev, cfg);
      try {
        const res = this.repo.applyEvent(ev, step);
        if (res.event !== null) rows.push(res.event);
        turns.push(...res.turns);
      } catch (err) {
        // The transaction rolled back; keep the previous state so memory matches the DB.
        this.failed++;
        this.report(err);
        continue;
      }
      this.states.set(ev.sessionId, step.state);
      n++;
    }
    this.applied += n;
    this.emit(rows, turns);
    return n;
  }

  /** Sends changes in chunks of at most `MAX_UPDATE_ROWS` events and turns; turns keep only their latest row. */
  private emit(events: readonly DebugEventRow[], turns: readonly DebugTurnRow[]): void {
    const latest = new Map<string, DebugTurnRow>();
    for (const t of turns) {
      const k = `${t.sessionId}\u0000${t.seq}`;
      latest.delete(k);
      latest.set(k, t);
    }
    const uniqueTurns = [...latest.values()];
    const chunks = Math.ceil(Math.max(events.length, uniqueTurns.length) / MAX_UPDATE_ROWS);
    for (let i = 0; i < chunks; i++) {
      const from = i * MAX_UPDATE_ROWS;
      const update: DebugUpdate = {
        events: events.slice(from, from + MAX_UPDATE_ROWS),
        turns: uniqueTurns.slice(from, from + MAX_UPDATE_ROWS),
      };
      try {
        this.onChange(update);
      } catch (err) {
        this.report(err);
      }
    }
  }

  private report(err: unknown): void {
    try {
      this.onError(err);
    } catch {
      // A failing error reporter must not break ingestion.
    }
  }
}
