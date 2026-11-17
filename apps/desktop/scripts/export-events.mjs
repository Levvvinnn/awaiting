// Export a sanitized recording of an awaiting.db (plan 01 §6.2 step 13) for replay fixtures.
//
//   node apps/desktop/scripts/export-events.mjs <path/to/awaiting.db> [out.json]
//
// - Opens the database read-only (never creates or migrates it). Safe while the app is running.
// - Exports an explicit column allowlist of sessions, turns and events. `turns.prompt_text` is
//   never exported, nor are any `prompt` / `prompt_text` / `promptText` keys in event data.
// - Every string has the user's home directory replaced by `~` (both slash styles, any case on
//   Windows, and Claude Code's dash-encoded project-dir form such as `C--Users-name`).
// - Writes JSON to `out.json`, or to stdout when no output path is given.
//
// better-sqlite3 is built for Electron's ABI, so under plain Node this script re-runs itself
// inside Electron's runtime (ELECTRON_RUN_AS_NODE=1).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FORMAT = 'awaiting-recording';
const FORMAT_VERSION = 1;

const [dbArg, outArg] = process.argv.slice(2);
if (dbArg === undefined || dbArg === '--help' || dbArg === '-h') {
  console.error('usage: export-events.mjs <awaiting.db> [out.json]');
  process.exit(dbArg === undefined ? 2 : 0);
}

if (process.versions.electron === undefined) {
  const electronPath = /** @type {string} */ (require('electron'));
  const r = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  if (r.error) {
    console.error('export-events: could not start Electron:', r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Home-directory spellings to replace, longest first. */
function homeVariants() {
  const homes = new Set(
    [homedir(), process.env.HOME, process.env.USERPROFILE].filter(
      (h) => typeof h === 'string' && h.trim().length > 1,
    ),
  );
  const out = new Set();
  for (const h of homes) {
    const trimmed = h.replace(/[\\/]+$/, '');
    out.add(trimmed);
    out.add(trimmed.replace(/\\/g, '/'));
    out.add(trimmed.replace(/\//g, '\\'));
    // Claude Code names project dirs by replacing path separators (and ':') with '-'.
    out.add(trimmed.replace(/[\\/:]/g, '-'));
  }
  return [...out].filter((v) => v.length > 1).sort((a, b) => b.length - a.length);
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const variants = homeVariants();
const homeRe =
  variants.length === 0
    ? null
    : new RegExp(variants.map(escapeRe).join('|'), caseInsensitive ? 'gi' : 'g');

/** @param {string} s */
const scrubString = (s) => (homeRe === null ? s : s.replace(homeRe, '~'));

const DROPPED_KEYS = new Set(['prompt', 'prompt_text', 'promptText']);

/** Deep copy with home paths replaced and prompt-text keys dropped. */
function scrub(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROPPED_KEYS.has(k)) continue;
      out[scrubString(k)] = scrub(v);
    }
    return out;
  }
  return value;
}

const SESSION_COLUMNS = [
  'session_id',
  'first_seen_at',
  'last_event_at',
  'started_at',
  'start_source',
  'ended_at',
  'end_reason',
  'model',
  'cwd',
  'permission_mode',
  'agent_type',
];
// Explicit allowlist: prompt_text is deliberately absent.
const TURN_COLUMNS = [
  'id',
  'session_id',
  'seq',
  'prompt_id',
  'started_at',
  'ended_at',
  'last_event_at',
  'status',
  'end_reason',
  'reopened_count',
  'event_count',
  'tool_count',
  'cwd',
  'permission_mode',
  'model',
  'prompt_length',
  'prompt_word_count',
  'prompt_line_count',
  'prompt_pasted_blocks',
  'prompt_code_fences',
  'prompt_is_slash',
  'prompt_first_word',
  'stop_error',
  'train_exclude',
];
const EVENT_COLUMNS = [
  'id',
  'received_at',
  'ingested_at',
  'session_id',
  'turn_id',
  'event_name',
  'prompt_id',
  'agent_id',
  'agent_type',
  'tool_name',
  'tool_use_id',
  'notification_type',
  'duration_ms',
  'is_interrupt',
  'data',
];

try {
  const Database = require('better-sqlite3');
  const db = new Database(resolve(dbArg), { readonly: true, fileMustExist: true });
  let recording;
  try {
    const schemaVersion = db.pragma('user_version', { simple: true });
    const all = (table, cols, order) =>
      db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${order}`).all();
    const events = all('events', EVENT_COLUMNS, 'received_at, id').map((row) => {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        data = { unparseable: true };
      }
      return { ...row, data };
    });
    recording = scrub({
      format: FORMAT,
      version: FORMAT_VERSION,
      schemaVersion,
      exportedAt: Date.now(),
      sessions: all('sessions', SESSION_COLUMNS, 'first_seen_at, session_id'),
      turns: all('turns', TURN_COLUMNS, 'started_at, id'),
      events,
    });
  } finally {
    db.close();
  }

  const json = `${JSON.stringify(recording, null, 2)}\n`;
  if (outArg === undefined) {
    process.stdout.write(json);
  } else {
    writeFileSync(resolve(outArg), json, { encoding: 'utf8', mode: 0o600 });
    console.error(
      `export-events: ${recording.events.length} events, ${recording.turns.length} turns, ` +
        `${recording.sessions.length} sessions -> ${resolve(outArg)}`,
    );
  }
} catch (error) {
  console.error('export-events: failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
