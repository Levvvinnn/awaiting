// Repository over the app database (plan 01 §3.8). Prepared statements only; every event is
// applied in one transaction. Decisions (turn boundaries, sanitization) come from @awaiting/core:
// this module only persists what the core state machine returns.
import type Database from 'better-sqlite3';
import {
  MAX_INFLIGHT_TOOLS,
  MAX_KNOWN_SUBAGENTS,
  isActionableNotificationType,
  type NormalizedEvent,
  type SessionTurnState,
  type TurnEffect,
  type TurnRef,
  type TurnStepResult,
} from '@awaiting/core';
import {
  MAX_SNAPSHOT_TURNS,
  isDebugEventRow,
  isDebugTurnRow,
  type DebugEventRow,
  type DebugTurnRow,
} from '../../shared/debug-types';

// ---------------------------------------------------------------------------------------------
// Settings

/** Defaults live in code; the table only holds values the user (or a test) changed. */
export const SETTING_DEFAULTS = Object.freeze({
  /** H3: raw prompt text is stored only when this is explicitly true. */
  'privacy.storeRawPrompt': false,
  'turns.inactivityMs': 600_000,
  'turns.longInactivityMs': 3_600_000,
});

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K] extends boolean
  ? boolean
  : number;

function isValidSetting<K extends SettingKey>(key: K, value: unknown): value is SettingValue<K> {
  if (typeof SETTING_DEFAULTS[key] === 'boolean') return typeof value === 'boolean';
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key);
}

// ---------------------------------------------------------------------------------------------
// Row types

interface TurnRow {
  id: number;
  session_id: string;
  seq: number;
  prompt_id: string | null;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
  status: string;
  end_reason: string | null;
  event_count: number;
}

interface SessionWithLatestTurnRow {
  session_id: string;
  ended_at: number | null;
  last_seq: number | null;
  turn_id: number | null;
  seq: number | null;
  prompt_id: string | null;
  started_at: number | null;
  turn_ended_at: number | null;
  last_event_at: number | null;
  status: string | null;
  end_reason: string | null;
}

interface ReplayEventRow {
  event_name: string;
  agent_id: string | null;
  tool_use_id: string | null;
  notification_type: string | null;
}

interface DebugEventDbRow {
  id: number;
  received_at: number;
  event_name: string;
  session_id: string;
  turn_seq: number | null;
  tool_name: string | null;
  notification_type: string | null;
  agent_type: string | null;
}

/** What `applyEvent` changed, for the debug push. */
export interface AppliedEvent {
  readonly event: DebugEventRow | null;
  /** Every turn touched by the effects or the attach, after the change. */
  readonly turns: readonly DebugTurnRow[];
}

export interface Repo {
  /** Persist one event and the effects `stepTurn` produced for it, in one transaction. */
  applyEvent(ev: NormalizedEvent, step: TurnStepResult): AppliedEvent;
  /** Persist the effects of `sweepInactive` (no event row). Returns the changed turns. */
  applySweep(sessionId: string, step: TurnStepResult): readonly DebugTurnRow[];
  /** Rebuild core turn state for every known session (startup). */
  loadSessionStates(): SessionTurnState[];
  /** The newest `limit` events, newest first. */
  recentEvents(limit: number): DebugEventRow[];
  /** Running turns plus turns started or ended at or after `sinceMs`, newest first. */
  currentTurns(sinceMs: number): DebugTurnRow[];
  getSetting<K extends SettingKey>(key: K): SettingValue<K>;
  setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): void;
}

const toTurnRow = (r: TurnRow): DebugTurnRow =>
  ({
    sessionId: r.session_id,
    seq: r.seq,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    eventCount: r.event_count,
  }) as DebugTurnRow;

const toEventRow = (r: DebugEventDbRow): DebugEventRow =>
  ({
    id: r.id,
    receivedAt: r.received_at,
    eventName: r.event_name,
    sessionId: r.session_id,
    turnSeq: r.turn_seq,
    toolName: r.tool_name,
    notificationType: r.notification_type,
    agentType: r.agent_type,
  }) as DebugEventRow;

const boolToInt = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);

function stringField(data: NormalizedEvent['data'], key: string): string | null {
  const v = data[key];
  return typeof v === 'string' ? v : null;
}

/** Append `id` (deduplicated), dropping the oldest entries beyond `cap`. */
function pushCapped(list: string[], id: string, cap: number): void {
  const i = list.indexOf(id);
  if (i !== -1) list.splice(i, 1);
  list.push(id);
  if (list.length > cap) list.splice(0, list.length - cap);
}

// ---------------------------------------------------------------------------------------------

export function createRepo(db: Database.Database, now: () => number = Date.now): Repo {
  const upsertSession = db.prepare<{
    sessionId: string;
    t: number;
    cwd: string | null;
    permissionMode: string | null;
  }>(`
    INSERT INTO sessions (session_id, first_seen_at, last_event_at, cwd, permission_mode)
    VALUES (@sessionId, @t, @t, @cwd, @permissionMode)
    ON CONFLICT (session_id) DO UPDATE SET
      first_seen_at   = min(first_seen_at, excluded.first_seen_at),
      last_event_at   = max(last_event_at, excluded.last_event_at),
      cwd             = coalesce(excluded.cwd, cwd),
      permission_mode = coalesce(excluded.permission_mode, permission_mode)
  `);
  const sessionStarted = db.prepare<{
    sessionId: string;
    t: number;
    source: string | null;
    model: string | null;
    agentType: string | null;
    resume: number;
  }>(`
    UPDATE sessions SET
      started_at   = coalesce(started_at, @t),
      start_source = coalesce(@source, start_source),
      model        = coalesce(@model, model),
      agent_type   = coalesce(@agentType, agent_type),
      ended_at     = CASE WHEN @resume = 1 THEN NULL ELSE ended_at END,
      end_reason   = CASE WHEN @resume = 1 THEN NULL ELSE end_reason END
    WHERE session_id = @sessionId
  `);
  const sessionEnded = db.prepare<{ sessionId: string; t: number; reason: string | null }>(
    'UPDATE sessions SET ended_at = @t, end_reason = @reason WHERE session_id = @sessionId',
  );

  const openTurn = db.prepare<{
    sessionId: string;
    seq: number;
    promptId: string | null;
    startedAt: number;
    cwd: string | null;
    permissionMode: string | null;
    promptLength: number | null;
    promptWordCount: number | null;
    promptLineCount: number | null;
    promptPastedBlocks: number | null;
    promptCodeFences: number | null;
    promptIsSlash: number | null;
    promptFirstWord: string | null;
    promptText: string | null;
  }>(`
    INSERT INTO turns (
      session_id, seq, prompt_id, started_at, last_event_at, status,
      cwd, permission_mode, model,
      prompt_length, prompt_word_count, prompt_line_count, prompt_pasted_blocks,
      prompt_code_fences, prompt_is_slash, prompt_first_word, prompt_text
    ) VALUES (
      @sessionId, @seq, @promptId, @startedAt, @startedAt, 'running',
      @cwd, @permissionMode, (SELECT model FROM sessions WHERE session_id = @sessionId),
      @promptLength, @promptWordCount, @promptLineCount, @promptPastedBlocks,
      @promptCodeFences, @promptIsSlash, @promptFirstWord, @promptText
    )
  `);
  // train_exclude is sticky: a turn that was ever interrupted keeps it after a reopen (M2 reads it).
  const closeTurn = db.prepare<{
    sessionId: string;
    seq: number;
    endedAt: number;
    status: string;
    reason: string;
    stopError: string | null;
  }>(`
    UPDATE turns SET
      ended_at      = @endedAt,
      status        = @status,
      end_reason    = @reason,
      stop_error    = @stopError,
      train_exclude = max(train_exclude, CASE WHEN @status = 'interrupted' THEN 1 ELSE 0 END)
    WHERE session_id = @sessionId AND seq = @seq
  `);
  const reopenTurn = db.prepare<{ sessionId: string; seq: number }>(`
    UPDATE turns SET
      ended_at = NULL, end_reason = NULL, stop_error = NULL, status = 'running',
      reopened_count = reopened_count + 1
    WHERE session_id = @sessionId AND seq = @seq
  `);
  const touchTurn = db.prepare<{ sessionId: string; seq: number; t: number }>(
    'UPDATE turns SET last_event_at = max(last_event_at, @t) WHERE session_id = @sessionId AND seq = @seq',
  );
  const turnIdBySeq = db.prepare<[string, number], { id: number }>(
    'SELECT id FROM turns WHERE session_id = ? AND seq = ?',
  );
  const bumpTurn = db.prepare<{ id: number; tool: number }>(
    'UPDATE turns SET event_count = event_count + 1, tool_count = tool_count + @tool WHERE id = @id',
  );
  const insertEvent = db.prepare<{
    receivedAt: number;
    ingestedAt: number;
    sessionId: string;
    turnId: number | null;
    eventName: string;
    promptId: string | null;
    agentId: string | null;
    agentType: string | null;
    toolName: string | null;
    toolUseId: string | null;
    notificationType: string | null;
    durationMs: number | null;
    isInterrupt: number | null;
    data: string;
  }>(`
    INSERT INTO events (
      received_at, ingested_at, session_id, turn_id, event_name, prompt_id, agent_id, agent_type,
      tool_name, tool_use_id, notification_type, duration_ms, is_interrupt, data
    ) VALUES (
      @receivedAt, @ingestedAt, @sessionId, @turnId, @eventName, @promptId, @agentId, @agentType,
      @toolName, @toolUseId, @notificationType, @durationMs, @isInterrupt, @data
    )
  `);
  const turnBySeq = db.prepare<[string, number], TurnRow>(
    'SELECT * FROM turns WHERE session_id = ? AND seq = ?',
  );
  const eventById = db.prepare<[number], DebugEventDbRow>(`
    SELECT e.id, e.received_at, e.event_name, e.session_id, t.seq AS turn_seq,
           e.tool_name, e.notification_type, e.agent_type
    FROM events e LEFT JOIN turns t ON t.id = e.turn_id
    WHERE e.id = ?
  `);
  const recentEventsStmt = db.prepare<[number], DebugEventDbRow>(`
    SELECT e.id, e.received_at, e.event_name, e.session_id, t.seq AS turn_seq,
           e.tool_name, e.notification_type, e.agent_type
    FROM events e LEFT JOIN turns t ON t.id = e.turn_id
    ORDER BY e.id DESC
    LIMIT ?
  `);
  const currentTurnsStmt = db.prepare<{ since: number; limit: number }, TurnRow>(`
    SELECT * FROM turns
    WHERE status = 'running' OR started_at >= @since OR ended_at >= @since
    ORDER BY started_at DESC, id DESC
    LIMIT @limit
  `);
  const sessionsWithLatestTurn = db.prepare<[], SessionWithLatestTurnRow>(`
    SELECT s.session_id, s.ended_at,
           (SELECT max(seq) FROM turns WHERE session_id = s.session_id) AS last_seq,
           t.id AS turn_id, t.seq, t.prompt_id, t.started_at, t.ended_at AS turn_ended_at,
           t.last_event_at, t.status, t.end_reason
    FROM sessions s
    LEFT JOIN turns t ON t.session_id = s.session_id
      AND t.seq = (SELECT max(seq) FROM turns WHERE session_id = s.session_id)
    ORDER BY s.session_id
  `);
  const subagentStarts = db.prepare<[], { session_id: string; agent_id: string }>(`
    SELECT session_id, agent_id FROM events
    WHERE event_name = 'SubagentStart' AND agent_id IS NOT NULL
    ORDER BY received_at, id
  `);
  const turnEvents = db.prepare<[number], ReplayEventRow>(`
    SELECT event_name, agent_id, tool_use_id, notification_type FROM events
    WHERE turn_id = ? ORDER BY received_at, id
  `);
  const getSettingStmt = db.prepare<[string], { value: string }>(
    'SELECT value FROM settings WHERE key = ?',
  );
  const setSettingStmt = db.prepare<{ key: string; value: string; t: number }>(`
    INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @t)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
    const fallback = SETTING_DEFAULTS[key] as SettingValue<K>;
    const row = getSettingStmt.get(key);
    if (row === undefined) return fallback;
    try {
      const value: unknown = JSON.parse(row.value);
      return isValidSetting(key, value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>): void {
    if (!isSettingKey(key)) throw new RangeError(`unknown setting ${String(key)}`);
    if (!isValidSetting(key, value)) throw new TypeError(`invalid value for setting ${key}`);
    setSettingStmt.run({ key, value: JSON.stringify(value), t: now() });
  }

  function mustChange(info: Database.RunResult, what: string): void {
    if (info.changes !== 1) throw new Error(`store: ${what} matched ${info.changes} rows`);
  }

  function applyEffects(
    sessionId: string,
    effects: readonly TurnEffect[],
    ev: NormalizedEvent | null,
  ): Set<number> {
    const seqs = new Set<number>();
    for (const effect of effects) {
      seqs.add(effect.seq);
      switch (effect.type) {
        case 'open': {
          const p = ev?.eventName === 'UserPromptSubmit' ? ev.prompt : null;
          // Defense in depth for H3: the parser drops the text unless opted in, and the store
          // re-checks the setting at write time.
          const keepText = getSetting('privacy.storeRawPrompt');
          openTurn.run({
            sessionId,
            seq: effect.seq,
            promptId: effect.promptId,
            startedAt: effect.startedAt,
            cwd: ev?.cwd ?? null,
            permissionMode: ev?.permissionMode ?? null,
            promptLength: p?.length ?? null,
            promptWordCount: p?.wordCount ?? null,
            promptLineCount: p?.lineCount ?? null,
            promptPastedBlocks: p?.pastedBlocks ?? null,
            promptCodeFences: p?.codeFences ?? null,
            promptIsSlash: p === null ? null : boolToInt(p.isSlashCommand),
            promptFirstWord: p?.firstWord ?? null,
            promptText: keepText && ev !== null ? ev.promptText : null,
          });
          break;
        }
        case 'close':
          mustChange(
            closeTurn.run({
              sessionId,
              seq: effect.seq,
              endedAt: effect.endedAt,
              status: effect.status,
              reason: effect.reason,
              stopError: effect.reason === 'stop_failure' ? (ev?.error ?? null) : null,
            }),
            `close ${sessionId}#${effect.seq}`,
          );
          break;
        case 'reopen':
          mustChange(
            reopenTurn.run({ sessionId, seq: effect.seq }),
            `reopen ${sessionId}#${effect.seq}`,
          );
          break;
        case 'touch':
          mustChange(
            touchTurn.run({ sessionId, seq: effect.seq, t: effect.lastEventAt }),
            `touch ${sessionId}#${effect.seq}`,
          );
          break;
      }
    }
    return seqs;
  }

  function readTurns(sessionId: string, seqs: Iterable<number>): DebugTurnRow[] {
    const out: DebugTurnRow[] = [];
    for (const seq of seqs) {
      const row = turnBySeq.get(sessionId, seq);
      if (row !== undefined) out.push(toTurnRow(row));
    }
    return out;
  }

  const applyEventTx = db.transaction((ev: NormalizedEvent, step: TurnStepResult): AppliedEvent => {
    const sessionId = ev.sessionId;
    upsertSession.run({
      sessionId,
      t: ev.receivedAt,
      cwd: ev.cwd,
      permissionMode: ev.permissionMode,
    });
    if (ev.eventName === 'SessionStart') {
      sessionStarted.run({
        sessionId,
        t: ev.receivedAt,
        source: ev.source,
        model: stringField(ev.data, 'model'),
        agentType: ev.agentType,
        resume: ev.source === 'resume' ? 1 : 0,
      });
    } else if (ev.eventName === 'SessionEnd') {
      sessionEnded.run({ sessionId, t: ev.receivedAt, reason: ev.reason });
    }

    const seqs = applyEffects(sessionId, step.effects, ev);

    let turnId: number | null = null;
    if (step.attachSeq !== null) {
      const row = turnIdBySeq.get(sessionId, step.attachSeq);
      if (row === undefined) {
        throw new Error(`store: attach to unknown turn ${sessionId}#${step.attachSeq}`);
      }
      turnId = row.id;
      seqs.add(step.attachSeq);
    }

    const info = insertEvent.run({
      receivedAt: ev.receivedAt,
      ingestedAt: now(),
      sessionId,
      turnId,
      eventName: ev.eventName,
      promptId: ev.promptId,
      agentId: ev.agentId,
      agentType: ev.agentType,
      toolName: ev.toolName,
      toolUseId: ev.toolUseId,
      notificationType: ev.notificationType,
      durationMs: ev.durationMs === null ? null : Math.round(ev.durationMs),
      isInterrupt: boolToInt(ev.isInterrupt),
      data: JSON.stringify(ev.data),
    });
    if (turnId !== null) {
      bumpTurn.run({ id: turnId, tool: ev.eventName === 'PreToolUse' ? 1 : 0 });
    }

    const eventRow = eventById.get(Number(info.lastInsertRowid));
    return {
      event: eventRow === undefined ? null : toEventRow(eventRow),
      turns: readTurns(sessionId, seqs),
    };
  });

  const applySweepTx = db.transaction((sessionId: string, step: TurnStepResult): DebugTurnRow[] =>
    readTurns(sessionId, applyEffects(sessionId, step.effects, null)),
  );

  /** Rebuild in-flight tools and the awaiting-user flag of an open turn from its events. */
  function replayOpenTurn(
    turnId: number,
    knownSubagents: ReadonlySet<string>,
  ): { inflightTools: string[]; awaitingUser: boolean } {
    const inflight: string[] = [];
    let awaitingUser = false;
    for (const e of turnEvents.all(turnId)) {
      if (e.agent_id !== null && knownSubagents.has(e.agent_id)) continue;
      switch (e.event_name) {
        case 'PreToolUse':
          if (e.tool_use_id !== null) pushCapped(inflight, e.tool_use_id, MAX_INFLIGHT_TOOLS);
          awaitingUser = false;
          break;
        case 'PostToolUse':
        case 'PostToolUseFailure': {
          const i = e.tool_use_id === null ? -1 : inflight.indexOf(e.tool_use_id);
          if (i !== -1) inflight.splice(i, 1);
          awaitingUser = false;
          break;
        }
        case 'PermissionRequest':
          awaitingUser = true;
          break;
        case 'Notification':
          if (e.notification_type !== null && isActionableNotificationType(e.notification_type)) {
            awaitingUser = true;
          }
          break;
        default:
          break;
      }
    }
    return { inflightTools: inflight, awaitingUser };
  }

  function loadSessionStates(): SessionTurnState[] {
    const subagents = new Map<string, string[]>();
    for (const r of subagentStarts.all()) {
      let list = subagents.get(r.session_id);
      if (list === undefined) subagents.set(r.session_id, (list = []));
      pushCapped(list, r.agent_id, MAX_KNOWN_SUBAGENTS);
    }

    return sessionsWithLatestTurn.all().map((r): SessionTurnState => {
      const knownSubagents = subagents.get(r.session_id) ?? [];
      let current: TurnRef | null = null;
      if (
        r.turn_id !== null &&
        r.seq !== null &&
        r.started_at !== null &&
        r.last_event_at !== null &&
        r.status !== null
      ) {
        const open = r.status === 'running';
        const replay = open
          ? replayOpenTurn(r.turn_id, new Set(knownSubagents))
          : { inflightTools: [], awaitingUser: false };
        current = {
          seq: r.seq,
          promptId: r.prompt_id,
          startedAt: r.started_at,
          lastEventAt: r.last_event_at,
          endedAt: r.turn_ended_at,
          status: r.status as TurnRef['status'],
          endReason: r.end_reason as TurnRef['endReason'],
          inflightTools: replay.inflightTools,
          awaitingUser: replay.awaitingUser,
        };
      }
      return {
        sessionId: r.session_id,
        lastSeq: r.last_seq ?? 0,
        current,
        ended: r.ended_at !== null,
        knownSubagents,
      };
    });
  }

  return {
    applyEvent: (ev, step) => applyEventTx(ev, step),
    applySweep: (sessionId, step) => applySweepTx(sessionId, step),
    loadSessionStates,
    recentEvents(limit) {
      const n = Math.max(0, Math.min(Math.trunc(limit), 10_000));
      return recentEventsStmt.all(n).map(toEventRow).filter(isDebugEventRow);
    },
    currentTurns(sinceMs) {
      return currentTurnsStmt
        .all({ since: sinceMs, limit: MAX_SNAPSHOT_TURNS })
        .map(toTurnRow)
        .filter(isDebugTurnRow);
    },
    getSetting,
    setSetting,
  };
}
