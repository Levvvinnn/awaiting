import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookEventName, NormalizedEvent, TurnEffect, TurnStepResult } from '@awaiting/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDataDir, dbPath, ensureDataDir } from '../paths';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations';
import { SchemaTooNewError, openStore, schemaVersion } from './open';
import { SETTING_DEFAULTS, createRepo, type Repo } from './repo';

// Hand-built events and step results: the store persists whatever the core machine returns,
// so these tests do not depend on stepTurn (replays of real sequences live in the ingestor tests).

const T0 = 1_763_380_000_000;
const SID = 'sess-1';

function ev(eventName: HookEventName, receivedAt: number, extra: Partial<NormalizedEvent> = {}) {
  const base: NormalizedEvent = {
    eventName,
    sessionId: SID,
    receivedAt,
    promptId: null,
    agentId: null,
    agentType: null,
    cwd: null,
    permissionMode: null,
    effortLevel: null,
    toolName: null,
    toolUseId: null,
    notificationType: null,
    durationMs: null,
    isInterrupt: null,
    stopHookActive: null,
    source: null,
    reason: null,
    error: null,
    prompt: null,
    promptText: null,
    data: {},
  };
  return { ...base, ...extra };
}

const PROMPT = {
  length: 12,
  wordCount: 3,
  lineCount: 1,
  pastedBlocks: 0,
  codeFences: 0,
  isSlashCommand: false,
  firstWord: 'please',
};

function step(attachSeq: number | null, ...effects: TurnEffect[]): TurnStepResult {
  // The store never reads `state`; a minimal value keeps the type honest.
  return {
    state: { sessionId: SID, lastSeq: 0, current: null, ended: false, knownSubagents: [] },
    effects,
    attachSeq,
  };
}

let dir: string;
let file: string;
const dbs: Database.Database[] = [];

function open(): { db: Database.Database; repo: Repo } {
  const db = openStore(file);
  dbs.push(db);
  let clock = T0 + 1_000_000;
  return { db, repo: createRepo(db, () => clock++) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awaiting-store-'));
  file = join(dir, 'awaiting.db');
});

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('paths', () => {
  it('uses AWAITING_HOME when set, else <home>/.awaiting, always absolute', () => {
    expect(appDataDir({ env: { AWAITING_HOME: dir }, homeDir: '/nowhere' })).toBe(dir);
    const fallback = appDataDir({ env: { AWAITING_HOME: '  ' }, homeDir: dir });
    expect(fallback).toBe(join(dir, '.awaiting'));
    expect(dbPath(fallback)).toBe(join(dir, '.awaiting', 'awaiting.db'));
  });

  it('creates the data directory', () => {
    const target = join(dir, 'a', 'b');
    ensureDataDir(target);
    ensureDataDir(target); // idempotent
    const db = openStore(dbPath(target));
    dbs.push(db);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });
});

describe('openStore', () => {
  it('migrates an empty file to the latest version with the M1 tables', () => {
    const { db } = open();
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(1);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['events', 'sessions', 'settings', 'turns']);
  });

  it('sets WAL, foreign keys, busy timeout and synchronous=NORMAL', () => {
    const { db } = open();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(2000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });

  it('is idempotent on reopen and keeps data', () => {
    const first = open();
    first.repo.setSetting('turns.inactivityMs', 1234);
    first.db.close();
    const second = open();
    expect(schemaVersion(second.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(second.repo.getSetting('turns.inactivityMs')).toBe(1234);
  });

  it('applies only newer migrations, each in its own transaction', () => {
    const { db } = open();
    db.close();
    const extra = [...MIGRATIONS, { version: 2, sql: 'CREATE TABLE extra(x INTEGER);' }];
    const db2 = openStore(file, { migrations: extra });
    dbs.push(db2);
    expect(schemaVersion(db2)).toBe(2);
    expect(() => db2.prepare('SELECT x FROM extra').all()).not.toThrow();
  });

  it('rolls back a failing migration and leaves user_version unchanged', () => {
    const { db } = open();
    db.close();
    const broken = [
      ...MIGRATIONS,
      { version: 2, sql: 'CREATE TABLE half(x INTEGER); THIS IS NOT SQL;' },
    ];
    expect(() => openStore(file, { migrations: broken })).toThrow();
    const raw = new Database(file, { readonly: true });
    dbs.push(raw);
    expect(schemaVersion(raw)).toBe(1);
    const half = raw
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'")
      .get() as { n: number };
    expect(half.n).toBe(0);
  });

  it('refuses a too-new user_version without writing to the file', () => {
    const raw = new Database(file);
    raw.pragma('user_version = 99');
    raw.close();

    let error: unknown;
    try {
      openStore(file);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SchemaTooNewError);
    expect((error as SchemaTooNewError).found).toBe(99);
    expect((error as SchemaTooNewError).supported).toBe(LATEST_SCHEMA_VERSION);

    const check = new Database(file, { readonly: true });
    dbs.push(check);
    expect(schemaVersion(check)).toBe(99);
    expect(check.pragma('journal_mode', { simple: true })).not.toBe('wal');
    const n = check.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('enforces the turns.status CHECK constraint', () => {
    const { db } = open();
    db.prepare(
      "INSERT INTO sessions (session_id, first_seen_at, last_event_at) VALUES ('s', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO turns (session_id, seq, started_at, last_event_at, status) VALUES ('s', 1, 1, 1, 'guessing')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('settings', () => {
  it('privacy.storeRawPrompt defaults to off and nothing is stored for defaults', () => {
    const { db, repo } = open();
    expect(SETTING_DEFAULTS['privacy.storeRawPrompt']).toBe(false);
    expect(repo.getSetting('privacy.storeRawPrompt')).toBe(false);
    expect(repo.getSetting('turns.inactivityMs')).toBe(600_000);
    expect(repo.getSetting('turns.longInactivityMs')).toBe(3_600_000);
    const n = db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('round-trips values as JSON with updated_at', () => {
    const { db, repo } = open();
    repo.setSetting('privacy.storeRawPrompt', true);
    expect(repo.getSetting('privacy.storeRawPrompt')).toBe(true);
    const row = db
      .prepare("SELECT value, updated_at FROM settings WHERE key = 'privacy.storeRawPrompt'")
      .get() as { value: string; updated_at: number };
    expect(row.value).toBe('true');
    expect(row.updated_at).toBeGreaterThan(T0);
  });

  it('falls back to the default for corrupt or wrong-typed stored values', () => {
    const { db, repo } = open();
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('privacy.storeRawPrompt', '\"yes\"', 1), ('turns.inactivityMs', '{oops', 1)",
    ).run();
    expect(repo.getSetting('privacy.storeRawPrompt')).toBe(false);
    expect(repo.getSetting('turns.inactivityMs')).toBe(600_000);
  });

  it('rejects unknown keys and invalid values', () => {
    const { repo } = open();
    expect(() => {
      repo.setSetting('nope' as 'turns.inactivityMs', 1);
    }).toThrow(RangeError);
    expect(() => {
      repo.setSetting('turns.inactivityMs', -5);
    }).toThrow(TypeError);
    expect(() => {
      repo.setSetting('privacy.storeRawPrompt', 1 as unknown as boolean);
    }).toThrow(TypeError);
  });
});

describe('repo.applyEvent', () => {
  function normalTurn(repo: Repo, extraPrompt: Partial<NormalizedEvent> = {}) {
    repo.applyEvent(
      ev('SessionStart', T0, { source: 'startup', cwd: '/work', data: { model: 'm-1' } }),
      step(null),
    );
    const opened = repo.applyEvent(
      ev('UserPromptSubmit', T0 + 100, {
        promptId: 'p1',
        cwd: '/work',
        permissionMode: 'default',
        prompt: PROMPT,
        ...extraPrompt,
      }),
      step(1, { type: 'open', seq: 1, startedAt: T0 + 100, promptId: 'p1' }),
    );
    repo.applyEvent(
      ev('PreToolUse', T0 + 200, { toolName: 'Read', toolUseId: 'tu1', promptId: 'p1' }),
      step(1, { type: 'touch', seq: 1, lastEventAt: T0 + 200 }),
    );
    repo.applyEvent(
      ev('PostToolUse', T0 + 300, {
        toolName: 'Read',
        toolUseId: 'tu1',
        durationMs: 99.6,
        data: { duration_ms: 99.6 },
      }),
      step(1, { type: 'touch', seq: 1, lastEventAt: T0 + 300 }),
    );
    const stopped = repo.applyEvent(
      ev('Stop', T0 + 125_100),
      step(1, { type: 'close', seq: 1, endedAt: T0 + 125_100, status: 'done', reason: 'stop' }),
    );
    return { opened, stopped };
  }

  it('persists a normal turn with prompt features, counters and debug rows', () => {
    const { db, repo } = open();
    const { opened, stopped } = normalTurn(repo);

    expect(opened.event).toMatchObject({ eventName: 'UserPromptSubmit', turnSeq: 1 });
    expect(opened.turns).toEqual([
      {
        sessionId: SID,
        seq: 1,
        status: 'running',
        startedAt: T0 + 100,
        endedAt: null,
        endReason: null,
        eventCount: 1,
      },
    ]);
    expect(stopped.turns[0]).toMatchObject({ status: 'done', endReason: 'stop', eventCount: 4 });

    const turn = db.prepare('SELECT * FROM turns').get() as Record<string, unknown>;
    expect(turn).toMatchObject({
      session_id: SID,
      seq: 1,
      prompt_id: 'p1',
      started_at: T0 + 100,
      ended_at: T0 + 125_100,
      last_event_at: T0 + 300,
      status: 'done',
      end_reason: 'stop',
      event_count: 4,
      tool_count: 1,
      cwd: '/work',
      permission_mode: 'default',
      model: 'm-1',
      prompt_length: 12,
      prompt_word_count: 3,
      prompt_is_slash: 0,
      prompt_first_word: 'please',
      prompt_text: null,
      train_exclude: 0,
    });

    const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(session).toMatchObject({
      first_seen_at: T0,
      last_event_at: T0 + 125_100,
      started_at: T0,
      start_source: 'startup',
      model: 'm-1',
      cwd: '/work',
      ended_at: null,
    });

    const events = db
      .prepare('SELECT event_name, turn_id, duration_ms, data FROM events ORDER BY id')
      .all() as {
      event_name: string;
      turn_id: number | null;
      duration_ms: number | null;
      data: string;
    }[];
    expect(events.map((e) => e.event_name)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
    expect(events[0]?.turn_id).toBeNull();
    expect(events[3]?.duration_ms).toBe(100);
    expect(JSON.parse(events[3]?.data ?? '')).toEqual({ duration_ms: 99.6 });
  });

  it('never stores prompt text while privacy.storeRawPrompt is off, even if handed some', () => {
    const { db, repo } = open();
    normalTurn(repo, { promptText: 'AWT_SENTINEL_should_not_be_stored' });
    const row = db.prepare('SELECT prompt_text FROM turns').get() as { prompt_text: string | null };
    expect(row.prompt_text).toBeNull();
  });

  it('stores prompt text only after the opt-in', () => {
    const { db, repo } = open();
    repo.setSetting('privacy.storeRawPrompt', true);
    normalTurn(repo, { promptText: 'opted in' });
    const row = db.prepare('SELECT prompt_text FROM turns').get() as { prompt_text: string | null };
    expect(row.prompt_text).toBe('opted in');
  });

  it('records StopFailure errors and marks interrupted turns train_exclude (sticky)', () => {
    const { db, repo } = open();
    repo.applyEvent(
      ev('UserPromptSubmit', T0, { prompt: PROMPT }),
      step(1, { type: 'open', seq: 1, startedAt: T0, promptId: null }),
    );
    repo.applyEvent(
      ev('StopFailure', T0 + 10, { error: 'rate_limit' }),
      step(1, { type: 'close', seq: 1, endedAt: T0 + 10, status: 'error', reason: 'stop_failure' }),
    );
    let t = db.prepare('SELECT * FROM turns WHERE seq = 1').get() as Record<string, unknown>;
    expect(t).toMatchObject({ status: 'error', stop_error: 'rate_limit', train_exclude: 0 });

    // Next prompt interrupts nothing (turn 1 closed); open turn 2, then a tool interrupt closes it.
    repo.applyEvent(
      ev('UserPromptSubmit', T0 + 20, { prompt: PROMPT }),
      step(2, { type: 'open', seq: 2, startedAt: T0 + 20, promptId: null }),
    );
    repo.applyEvent(
      ev('PostToolUseFailure', T0 + 30, { toolName: 'Bash', isInterrupt: true }),
      step(2, {
        type: 'close',
        seq: 2,
        endedAt: T0 + 30,
        status: 'interrupted',
        reason: 'tool_interrupt',
      }),
    );
    t = db.prepare('SELECT * FROM turns WHERE seq = 2').get() as Record<string, unknown>;
    expect(t).toMatchObject({ status: 'interrupted', train_exclude: 1 });

    // Reopen on continued activity, then a normal Stop: stays excluded, reopen counted.
    repo.applyEvent(
      ev('PreToolUse', T0 + 40, { toolName: 'Bash', toolUseId: 'x' }),
      step(2, { type: 'reopen', seq: 2 }, { type: 'touch', seq: 2, lastEventAt: T0 + 40 }),
    );
    repo.applyEvent(
      ev('Stop', T0 + 50),
      step(2, { type: 'close', seq: 2, endedAt: T0 + 50, status: 'done', reason: 'stop' }),
    );
    t = db.prepare('SELECT * FROM turns WHERE seq = 2').get() as Record<string, unknown>;
    expect(t).toMatchObject({
      status: 'done',
      end_reason: 'stop',
      reopened_count: 1,
      train_exclude: 1,
      stop_error: null,
    });
    const isInterrupt = db
      .prepare("SELECT is_interrupt FROM events WHERE event_name = 'PostToolUseFailure'")
      .get() as { is_interrupt: number };
    expect(isInterrupt.is_interrupt).toBe(1);
  });

  it('rolls back the whole event when an effect is inconsistent', () => {
    const { db, repo } = open();
    expect(() =>
      repo.applyEvent(
        ev('Stop', T0),
        step(null, { type: 'close', seq: 7, endedAt: T0, status: 'done', reason: 'stop' }),
      ),
    ).toThrow(/close/);
    expect(() => repo.applyEvent(ev('Notification', T0), step(3))).toThrow(/unknown turn/);
    const counts = db
      .prepare('SELECT (SELECT count(*) FROM events) AS e, (SELECT count(*) FROM sessions) AS s')
      .get() as { e: number; s: number };
    expect(counts).toEqual({ e: 0, s: 0 });
  });

  it('tracks session end and a resume clearing it', () => {
    const { db, repo } = open();
    repo.applyEvent(ev('SessionEnd', T0, { reason: 'logout' }), step(null));
    let s = db.prepare('SELECT ended_at, end_reason FROM sessions').get();
    expect(s).toEqual({ ended_at: T0, end_reason: 'logout' });
    repo.applyEvent(ev('SessionStart', T0 + 5, { source: 'resume' }), step(null));
    s = db.prepare('SELECT ended_at, end_reason, start_source FROM sessions').get();
    expect(s).toEqual({ ended_at: null, end_reason: null, start_source: 'resume' });
  });
});

describe('repo.applySweep', () => {
  it('closes a stale turn without inserting an event', () => {
    const { db, repo } = open();
    repo.applyEvent(
      ev('UserPromptSubmit', T0, { prompt: PROMPT }),
      step(1, { type: 'open', seq: 1, startedAt: T0, promptId: null }),
    );
    const turns = repo.applySweep(
      SID,
      step(null, {
        type: 'close',
        seq: 1,
        endedAt: T0,
        status: 'interrupted',
        reason: 'inactivity',
      }),
    );
    expect(turns).toEqual([
      expect.objectContaining({ status: 'interrupted', endReason: 'inactivity', endedAt: T0 }),
    ]);
    const n = db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('repo.loadSessionStates', () => {
  it('rebuilds lastSeq, the latest turn, ended, subagents, in-flight tools and awaitingUser', () => {
    const first = open();
    const r = first.repo;
    r.applyEvent(
      ev('UserPromptSubmit', T0, { promptId: 'p1', prompt: PROMPT }),
      step(1, { type: 'open', seq: 1, startedAt: T0, promptId: 'p1' }),
    );
    r.applyEvent(
      ev('Stop', T0 + 1),
      step(1, { type: 'close', seq: 1, endedAt: T0 + 1, status: 'done', reason: 'stop' }),
    );
    r.applyEvent(
      ev('UserPromptSubmit', T0 + 10, { promptId: 'p2', prompt: PROMPT }),
      step(2, { type: 'open', seq: 2, startedAt: T0 + 10, promptId: 'p2' }),
    );
    const touch = (t: number) => step(2, { type: 'touch', seq: 2, lastEventAt: t });
    r.applyEvent(
      ev('SubagentStart', T0 + 11, { agentId: 'ag1', agentType: 'Explore' }),
      touch(T0 + 11),
    );
    r.applyEvent(ev('PreToolUse', T0 + 12, { toolName: 'Bash', toolUseId: 'a' }), touch(T0 + 12));
    r.applyEvent(ev('PreToolUse', T0 + 13, { toolName: 'Read', toolUseId: 'b' }), touch(T0 + 13));
    r.applyEvent(ev('PostToolUse', T0 + 14, { toolName: 'Read', toolUseId: 'b' }), touch(T0 + 14));
    // Subagent tool calls never count as main in-flight tools.
    r.applyEvent(
      ev('PreToolUse', T0 + 15, { toolName: 'Grep', toolUseId: 'sub', agentId: 'ag1' }),
      touch(T0 + 15),
    );
    r.applyEvent(
      ev('Notification', T0 + 16, { notificationType: 'permission_prompt' }),
      touch(T0 + 16),
    );
    // A second session that ended with no turns.
    r.applyEvent(ev('SessionEnd', T0 + 20, { sessionId: 'sess-2', reason: 'other' }), step(null));
    first.db.close();

    const { repo } = open();
    const states = repo.loadSessionStates();
    expect(states).toEqual([
      {
        sessionId: SID,
        lastSeq: 2,
        current: {
          seq: 2,
          promptId: 'p2',
          startedAt: T0 + 10,
          lastEventAt: T0 + 16,
          endedAt: null,
          status: 'running',
          endReason: null,
          inflightTools: ['a'],
          awaitingUser: true,
        },
        ended: false,
        knownSubagents: ['ag1'],
      },
      { sessionId: 'sess-2', lastSeq: 0, current: null, ended: true, knownSubagents: [] },
    ]);
  });
});

describe('repo debug queries', () => {
  it('returns the newest events first with their turn seq, capped by limit', () => {
    const { repo } = open();
    repo.applyEvent(ev('SessionStart', T0), step(null));
    repo.applyEvent(
      ev('UserPromptSubmit', T0 + 1, { prompt: PROMPT }),
      step(1, { type: 'open', seq: 1, startedAt: T0 + 1, promptId: null }),
    );
    repo.applyEvent(
      ev('Notification', T0 + 2, { notificationType: 'idle_prompt' }),
      step(1, { type: 'touch', seq: 1, lastEventAt: T0 + 2 }),
    );
    const rows = repo.recentEvents(2);
    expect(rows).toEqual([
      {
        id: 3,
        receivedAt: T0 + 2,
        eventName: 'Notification',
        sessionId: SID,
        turnSeq: 1,
        toolName: null,
        notificationType: 'idle_prompt',
        agentType: null,
      },
      expect.objectContaining({ id: 2, eventName: 'UserPromptSubmit', turnSeq: 1 }),
    ]);
    expect(repo.recentEvents(10).at(-1)).toMatchObject({
      eventName: 'SessionStart',
      turnSeq: null,
    });
  });

  it('currentTurns returns running turns and recent ones', () => {
    const { repo } = open();
    repo.applyEvent(
      ev('UserPromptSubmit', T0, { prompt: PROMPT }),
      step(1, { type: 'open', seq: 1, startedAt: T0, promptId: null }),
    );
    repo.applyEvent(
      ev('Stop', T0 + 5),
      step(1, { type: 'close', seq: 1, endedAt: T0 + 5, status: 'done', reason: 'stop' }),
    );
    repo.applyEvent(
      ev('UserPromptSubmit', T0 + 10, { prompt: PROMPT }),
      step(2, { type: 'open', seq: 2, startedAt: T0 + 10, promptId: null }),
    );
    expect(repo.currentTurns(T0 + 100).map((t) => t.seq)).toEqual([2]);
    expect(repo.currentTurns(T0).map((t) => t.seq)).toEqual([2, 1]);
  });
});
