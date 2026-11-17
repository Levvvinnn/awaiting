// Ordered schema migrations (plan 01 §3.8). Versions are tracked in `PRAGMA user_version`.
// Never edit a shipped migration: append a new one.
import { END_REASONS, TURN_STATUSES } from '@awaiting/core';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

const MIGRATION_1 = `
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  first_seen_at   INTEGER NOT NULL,
  last_event_at   INTEGER NOT NULL,
  started_at      INTEGER,
  start_source    TEXT,
  ended_at        INTEGER,
  end_reason      TEXT,
  model           TEXT,
  cwd             TEXT,
  permission_mode TEXT,
  agent_type      TEXT
);

CREATE TABLE turns (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT NOT NULL REFERENCES sessions(session_id),
  seq                  INTEGER NOT NULL,
  prompt_id            TEXT,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  last_event_at        INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (${sqlList(TURN_STATUSES)})),
  end_reason           TEXT CHECK (end_reason IN (${sqlList(END_REASONS)})),
  reopened_count       INTEGER NOT NULL DEFAULT 0,
  event_count          INTEGER NOT NULL DEFAULT 0,
  tool_count           INTEGER NOT NULL DEFAULT 0,
  cwd                  TEXT,
  permission_mode      TEXT,
  model                TEXT,
  prompt_length        INTEGER,
  prompt_word_count    INTEGER,
  prompt_line_count    INTEGER,
  prompt_pasted_blocks INTEGER,
  prompt_code_fences   INTEGER,
  prompt_is_slash      INTEGER,
  prompt_first_word    TEXT,
  prompt_text          TEXT, -- only with privacy.storeRawPrompt = true
  stop_error           TEXT,
  train_exclude        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, seq)
);
CREATE INDEX turns_session_started ON turns (session_id, started_at);
CREATE INDEX turns_status ON turns (status);

CREATE TABLE events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at       INTEGER NOT NULL,
  ingested_at       INTEGER NOT NULL,
  session_id        TEXT NOT NULL,
  turn_id           INTEGER REFERENCES turns(id),
  event_name        TEXT NOT NULL,
  prompt_id         TEXT,
  agent_id          TEXT,
  agent_type        TEXT,
  tool_name         TEXT,
  tool_use_id       TEXT,
  notification_type TEXT,
  duration_ms       INTEGER,
  is_interrupt      INTEGER,
  data              TEXT NOT NULL -- sanitized JSON (core allowlist)
);
CREATE INDEX events_session_received ON events (session_id, received_at);
CREATE INDEX events_turn ON events (turn_id);
CREATE INDEX events_name ON events (event_name);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL, -- JSON
  updated_at INTEGER NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, sql: MIGRATION_1 }),
]);

/** The newest schema version this build knows. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
