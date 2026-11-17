import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TURN_CONFIG,
  parseHookEvent,
  type NormalizedEvent,
  type TurnConfig,
} from '@awaiting/core';
import {
  DOC_EXAMPLES,
  VARIANTS,
  cloneFixture,
  type HookPayloadFixture,
} from '@awaiting/core/fixtures';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDebugUpdate, MAX_UPDATE_ROWS, type DebugUpdate } from '../../shared/debug-types';
import { openStore } from '../store/open';
import { createRepo, type Repo } from '../store/repo';
import { Ingestor, MAX_FUTURE_SKEW_MS, type IngestorOptions } from './ingestor';

// Replays of doc-modelled fixture sequences through the real pipeline: reorder buffer →
// core.stepTurn → repo on a temp file DB (better-sqlite3 under plain Node).

const T0 = 1_800_000_000_000;
const SID = 'sess-replay';
const MIN = 60_000;

interface TurnDbRow {
  seq: number;
  status: string;
  end_reason: string | null;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
  reopened_count: number;
  event_count: number;
  tool_count: number;
  train_exclude: number;
  stop_error: string | null;
}

/** Parses a fixture with overrides, exactly as the server would. */
function fx(
  payload: HookPayloadFixture,
  at: number,
  over: Readonly<Record<string, unknown>> = {},
): NormalizedEvent {
  const res = parseHookEvent(cloneFixture(payload, { session_id: SID, received_at: at, ...over }), {
    keepRawPrompt: false,
  });
  if (!res.ok) throw new Error(`fixture did not parse: ${res.error}`);
  return res.event;
}

const prompt = (at: number, over: Record<string, unknown> = {}) =>
  fx(DOC_EXAMPLES.UserPromptSubmit, at, over);
const pre = (at: number, id: string) => fx(DOC_EXAMPLES.PreToolUse, at, { tool_use_id: id });
const post = (at: number, id: string) => fx(DOC_EXAMPLES.PostToolUse, at, { tool_use_id: id });
const stop = (at: number) => fx(DOC_EXAMPLES.Stop, at, { stop_hook_active: false });

let dir: string;
let dbFile: string;
let db: Database.Database;
let repo: Repo;
let clock: number;
let updates: DebugUpdate[];
const now = () => clock;

function open(): void {
  db = openStore(dbFile);
  repo = createRepo(db, now);
}

function makeIngestor(cfg: TurnConfig = DEFAULT_TURN_CONFIG, opts: IngestorOptions = {}) {
  return new Ingestor(repo, cfg, now, (u) => updates.push(u), opts);
}

/** Enqueues each event at its own receivedAt, then drains past the reorder window. */
function replay(ing: Ingestor, events: readonly NormalizedEvent[]): void {
  for (const e of events) {
    clock = Math.max(clock, e.receivedAt);
    ing.enqueue(e);
    ing.tick();
  }
  clock += 1_000;
  ing.tick();
  expect(ing.pendingCount).toBe(0);
}

const turns = (): TurnDbRow[] =>
  db
    .prepare<[string], TurnDbRow>(
      `SELECT seq, status, end_reason, started_at, ended_at, last_event_at, reopened_count,
              event_count, tool_count, train_exclude, stop_error
       FROM turns WHERE session_id = ? ORDER BY seq`,
    )
    .all(SID);

const eventTurnSeqs = (): { event_name: string; seq: number | null }[] =>
  db
    .prepare<[string], { event_name: string; seq: number | null }>(
      `SELECT e.event_name, t.seq FROM events e LEFT JOIN turns t ON t.id = e.turn_id
       WHERE e.session_id = ? ORDER BY e.id`,
    )
    .all(SID);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awaiting-ingestor-'));
  dbFile = join(dir, 'awaiting.db');
  clock = T0;
  updates = [];
  open();
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fixture replays', () => {
  it('normal turn: SessionStart, prompt, tool, Stop → done/stop', () => {
    const ing = makeIngestor();
    replay(ing, [
      fx(DOC_EXAMPLES.SessionStart, T0),
      prompt(T0 + 1_000),
      pre(T0 + 2_000, 'tool-a'),
      post(T0 + 3_000, 'tool-a'),
      stop(T0 + 11_000),
    ]);

    expect(turns()).toEqual([
      expect.objectContaining({
        seq: 1,
        status: 'done',
        end_reason: 'stop',
        started_at: T0 + 1_000,
        ended_at: T0 + 11_000,
        last_event_at: T0 + 11_000,
        reopened_count: 0,
        event_count: 4,
        tool_count: 1,
        train_exclude: 0,
      }),
    ]);
    expect(eventTurnSeqs()).toEqual([
      { event_name: 'SessionStart', seq: null },
      { event_name: 'UserPromptSubmit', seq: 1 },
      { event_name: 'PreToolUse', seq: 1 },
      { event_name: 'PostToolUse', seq: 1 },
      { event_name: 'Stop', seq: 1 },
    ]);
    expect(ing.sessionState(SID)?.current).toMatchObject({ status: 'done', inflightTools: [] });
    expect(ing.stats()).toEqual({ applied: 5, failed: 0, sweptClosed: 0 });
  });

  it('StopFailure → error/stop_failure with the error code', () => {
    const ing = makeIngestor();
    replay(ing, [
      prompt(T0),
      pre(T0 + 1_000, 'tool-a'),
      fx(VARIANTS.postToolUseFailureNpmTest, T0 + 4_000, { tool_use_id: 'tool-a' }),
      fx(DOC_EXAMPLES.StopFailure, T0 + 6_000),
    ]);
    expect(turns()).toEqual([
      expect.objectContaining({
        seq: 1,
        status: 'error',
        end_reason: 'stop_failure',
        ended_at: T0 + 6_000,
        stop_error: 'server_error',
        train_exclude: 0,
      }),
    ]);
  });

  it('interrupted by the next prompt: closes at the last activity, train-excluded', () => {
    const ing = makeIngestor();
    replay(ing, [
      prompt(T0),
      pre(T0 + 2_000, 'tool-a'),
      fx(VARIANTS.userPromptSubmitPasted, T0 + 30_000),
      stop(T0 + 40_000),
    ]);
    expect(turns()).toEqual([
      expect.objectContaining({
        seq: 1,
        status: 'interrupted',
        end_reason: 'next_prompt',
        started_at: T0,
        ended_at: T0 + 2_000,
        train_exclude: 1,
        event_count: 2,
      }),
      expect.objectContaining({
        seq: 2,
        status: 'done',
        end_reason: 'stop',
        started_at: T0 + 30_000,
        ended_at: T0 + 40_000,
        train_exclude: 0,
      }),
    ]);
  });

  it('interrupted by a tool interrupt (Esc) → interrupted/tool_interrupt', () => {
    const ing = makeIngestor();
    replay(ing, [
      prompt(T0),
      pre(T0 + 1_000, 'tool-a'),
      fx(VARIANTS.postToolUseFailureInterrupt, T0 + 5_000, { tool_use_id: 'tool-a' }),
    ]);
    expect(turns()).toEqual([
      expect.objectContaining({
        status: 'interrupted',
        end_reason: 'tool_interrupt',
        ended_at: T0 + 5_000,
        train_exclude: 1,
      }),
    ]);
  });

  it('stop-hook continuation: Stop, then Stop again → one done turn, reopened once', () => {
    const ing = makeIngestor();
    replay(ing, [prompt(T0), stop(T0 + 5_000), fx(DOC_EXAMPLES.Stop, T0 + 9_000)]);
    expect(turns()).toEqual([
      expect.objectContaining({
        seq: 1,
        status: 'done',
        end_reason: 'stop',
        ended_at: T0 + 9_000,
        reopened_count: 1,
        event_count: 3,
      }),
    ]);
  });

  it('activity after Stop reopens; the next Stop closes again', () => {
    const ing = makeIngestor();
    replay(ing, [
      prompt(T0),
      stop(T0 + 5_000),
      pre(T0 + 6_000, 'tool-b'),
      post(T0 + 7_000, 'tool-b'),
      stop(T0 + 12_000),
    ]);
    expect(turns()).toEqual([
      expect.objectContaining({
        status: 'done',
        ended_at: T0 + 12_000,
        reopened_count: 1,
        event_count: 5,
      }),
    ]);
  });

  it('a closed turn does not reopen after SessionEnd', () => {
    const ing = makeIngestor();
    replay(ing, [
      prompt(T0),
      stop(T0 + 5_000),
      fx(DOC_EXAMPLES.SessionEnd, T0 + 6_000),
      fx(DOC_EXAMPLES.Stop, T0 + 7_000),
    ]);
    expect(turns()).toEqual([
      expect.objectContaining({ status: 'done', ended_at: T0 + 5_000, reopened_count: 0 }),
    ]);
    expect(eventTurnSeqs().at(-1)).toEqual({ event_name: 'Stop', seq: null });
  });
});

describe('reorder buffer', () => {
  it('holds events for the window and applies out-of-order arrivals in receivedAt order', () => {
    const ing = makeIngestor();
    clock = T0 + 210;
    // Parallel async hooks: Stop's POST lands first, the prompt's last.
    ing.enqueue(stop(T0 + 200));
    ing.enqueue(pre(T0 + 100, 'tool-a'));
    ing.enqueue(prompt(T0));

    clock = T0 + 240;
    expect(ing.tick()).toBe(0);
    expect(turns()).toEqual([]);

    clock = T0 + 260; // only the prompt is 250 ms old
    expect(ing.tick()).toBe(1);
    expect(turns()).toEqual([expect.objectContaining({ status: 'running' })]);

    clock = T0 + 450;
    expect(ing.tick()).toBe(2);
    expect(ing.pendingCount).toBe(0);
    expect(turns()).toEqual([
      expect.objectContaining({
        status: 'done',
        end_reason: 'stop',
        started_at: T0,
        ended_at: T0 + 200,
        reopened_count: 0,
      }),
    ]);
    expect(eventTurnSeqs().map((e) => e.event_name)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'Stop',
    ]);
  });

  it('breaks receivedAt ties by arrival order', () => {
    const ing = makeIngestor();
    clock = T0;
    ing.enqueue(prompt(T0));
    ing.enqueue(stop(T0));
    clock = T0 + 300;
    ing.tick();
    expect(eventTurnSeqs()).toEqual([
      { event_name: 'UserPromptSubmit', seq: 1 },
      { event_name: 'Stop', seq: 1 },
    ]);
    expect(turns()[0]).toMatchObject({ status: 'done' });
  });

  it('does not hold an event stamped in the future longer than the window', () => {
    const ing = makeIngestor();
    clock = T0;
    ing.enqueue(prompt(T0 + 10 * MIN));
    clock = T0 + MAX_FUTURE_SKEW_MS + 249;
    expect(ing.tick()).toBe(0);
    clock = T0 + MAX_FUTURE_SKEW_MS + 250;
    expect(ing.tick()).toBe(1);
    expect(turns()[0]).toMatchObject({ started_at: T0 + 10 * MIN });
  });

  it('flush() applies everything pending regardless of the window', () => {
    const ing = makeIngestor();
    clock = T0;
    ing.enqueue(stop(T0 + 5));
    ing.enqueue(prompt(T0));
    expect(ing.flush()).toBe(2);
    expect(turns()[0]).toMatchObject({ status: 'done' });
  });

  it('forces an in-order flush when the buffer exceeds maxPending', () => {
    const ing = makeIngestor(DEFAULT_TURN_CONFIG, { maxPending: 2 });
    clock = T0;
    ing.enqueue(prompt(T0));
    ing.enqueue(pre(T0 + 1, 'a'));
    expect(ing.pendingCount).toBe(2);
    ing.enqueue(post(T0 + 2, 'a'));
    expect(ing.pendingCount).toBe(0);
    expect(turns()[0]).toMatchObject({ event_count: 3 });
  });
});

describe('restart', () => {
  it('close, reopen, loadSessionStates, then sweep closes a stale turn at its last activity', () => {
    let ing = makeIngestor();
    replay(ing, [prompt(T0), pre(T0 + 1_000, 'tool-a'), post(T0 + 2_000, 'tool-a')]);
    expect(turns()[0]).toMatchObject({ status: 'running', last_event_at: T0 + 2_000 });
    db.close();

    open();
    ing = makeIngestor();
    expect(ing.sessionState(SID)?.current).toMatchObject({
      seq: 1,
      status: 'running',
      lastEventAt: T0 + 2_000,
      inflightTools: [],
    });

    clock = T0 + 2_000 + 10 * MIN - 1;
    expect(ing.sweep()).toBe(0);
    expect(turns()[0]).toMatchObject({ status: 'running' });

    updates = [];
    clock = T0 + 2_000 + 10 * MIN;
    expect(ing.sweep()).toBe(1);
    expect(turns()).toEqual([
      expect.objectContaining({
        status: 'interrupted',
        end_reason: 'inactivity',
        ended_at: T0 + 2_000,
        train_exclude: 1,
      }),
    ]);
    expect(updates).toEqual([
      {
        events: [],
        turns: [
          expect.objectContaining({ seq: 1, status: 'interrupted', endReason: 'inactivity' }),
        ],
      },
    ]);
    expect(ing.stats().sweptClosed).toBe(1);

    // Late activity on the same turn reopens it (inactivity is reopenable).
    replay(ing, [post(clock + 1, 'late')]);
    expect(turns()[0]).toMatchObject({ status: 'running', reopened_count: 1, train_exclude: 1 });
  });

  it('restores in-flight tools so the long threshold applies after restart', () => {
    let ing = makeIngestor();
    replay(ing, [prompt(T0), pre(T0 + 1_000, 'tool-slow')]);
    db.close();

    open();
    ing = makeIngestor();
    expect(ing.sessionState(SID)?.current?.inflightTools).toEqual(['tool-slow']);
    clock = T0 + 1_000 + 30 * MIN;
    expect(ing.sweep()).toBe(0);
    clock = T0 + 1_000 + 60 * MIN;
    expect(ing.sweep()).toBe(1);
    expect(turns()[0]).toMatchObject({ status: 'interrupted', end_reason: 'inactivity' });
  });

  it('a stopped turn reopens on a continuation after restart, but not after SessionEnd until resume', () => {
    let ing = makeIngestor();
    replay(ing, [prompt(T0), stop(T0 + 5_000)]);
    db.close();

    open();
    ing = makeIngestor();
    replay(ing, [fx(DOC_EXAMPLES.Stop, T0 + 8_000)]);
    expect(turns()[0]).toMatchObject({ status: 'done', ended_at: T0 + 8_000, reopened_count: 1 });

    replay(ing, [fx(DOC_EXAMPLES.SessionEnd, T0 + 9_000)]);
    db.close();

    open();
    ing = makeIngestor();
    expect(ing.sessionState(SID)?.ended).toBe(true);
    replay(ing, [pre(T0 + 10_000, 'after-end')]);
    expect(turns()[0]).toMatchObject({ status: 'done', reopened_count: 1 });

    replay(ing, [fx(VARIANTS.sessionStartResume, T0 + 11_000), pre(T0 + 12_000, 'resumed')]);
    expect(turns()[0]).toMatchObject({ status: 'running', reopened_count: 2 });
  });

  it('continues seq numbering after restart', () => {
    let ing = makeIngestor();
    replay(ing, [prompt(T0), stop(T0 + 1_000)]);
    db.close();
    open();
    ing = makeIngestor();
    replay(ing, [prompt(T0 + 2_000)]);
    expect(turns().map((t) => t.seq)).toEqual([1, 2]);
  });
});

describe('sweep', () => {
  it('uses the cfg getter at sweep time', () => {
    let cfg: TurnConfig = DEFAULT_TURN_CONFIG;
    const ing = new Ingestor(
      repo,
      () => cfg,
      now,
      (u) => updates.push(u),
    );
    replay(ing, [prompt(T0)]);
    clock = T0 + MIN;
    expect(ing.sweep()).toBe(0);
    cfg = { inactivityMs: MIN, longInactivityMs: 2 * MIN };
    expect(ing.sweep()).toBe(1);
  });

  it('skips sessions that still have buffered events', () => {
    const ing = makeIngestor();
    replay(ing, [prompt(T0)]);
    clock = T0 + 10 * MIN;
    ing.enqueue(pre(clock, 'fresh'));
    expect(ing.sweep()).toBe(0);
    clock += 300;
    ing.tick();
    expect(turns()[0]).toMatchObject({ status: 'running', reopened_count: 0 });
  });
});

describe('onChange and errors', () => {
  it('emits one validated update per tick with new events and the latest turn rows', () => {
    const ing = makeIngestor();
    clock = T0;
    ing.enqueue(prompt(T0));
    ing.enqueue(pre(T0 + 1, 'a'));
    ing.enqueue(stop(T0 + 2));
    clock = T0 + 300;
    ing.tick();
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(isDebugUpdate(u)).toBe(true);
    expect(u?.events.map((e) => [e.eventName, e.turnSeq])).toEqual([
      ['UserPromptSubmit', 1],
      ['PreToolUse', 1],
      ['Stop', 1],
    ]);
    expect(u?.turns).toEqual([
      expect.objectContaining({ seq: 1, status: 'done', endReason: 'stop', eventCount: 3 }),
    ]);
  });

  it('chunks large batches to MAX_UPDATE_ROWS', () => {
    const ing = makeIngestor();
    clock = T0;
    ing.enqueue(prompt(T0));
    for (let i = 1; i <= 450; i++) ing.enqueue(pre(T0 + i, `t${i}`));
    ing.flush();
    expect(updates.map((u) => u.events.length)).toEqual([MAX_UPDATE_ROWS, MAX_UPDATE_ROWS, 51]);
    expect(updates.every(isDebugUpdate)).toBe(true);
  });

  it('a repo failure rolls back that event only and keeps memory in sync with the DB', () => {
    const errors: unknown[] = [];
    let failNext = false;
    const flaky: Repo = {
      ...repo,
      applyEvent(ev, step) {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        return repo.applyEvent(ev, step);
      },
    };
    const ing = new Ingestor(flaky, DEFAULT_TURN_CONFIG, now, (u) => updates.push(u), {
      onError: (e) => errors.push(e),
    });
    replay(ing, [prompt(T0)]);
    failNext = true;
    replay(ing, [stop(T0 + 1_000)]);
    expect(errors).toHaveLength(1);
    expect(ing.sessionState(SID)?.current?.status).toBe('running');
    expect(turns()[0]).toMatchObject({ status: 'running' });

    replay(ing, [stop(T0 + 2_000)]);
    expect(turns()[0]).toMatchObject({ status: 'done', reopened_count: 0 });
    expect(ing.stats()).toMatchObject({ applied: 2, failed: 1 });
  });

  it('a throwing onChange does not stop ingestion', () => {
    const errors: unknown[] = [];
    const ing = new Ingestor(
      repo,
      DEFAULT_TURN_CONFIG,
      now,
      () => {
        throw new Error('renderer gone');
      },
      { onError: (e) => errors.push(e) },
    );
    replay(ing, [prompt(T0), stop(T0 + 1_000)]);
    expect(turns()[0]).toMatchObject({ status: 'done' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
