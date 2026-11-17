// Open the app database: version check, pragmas, migrations (plan 01 §3.8).
import type Database from 'better-sqlite3';
import { openDatabase } from '../db';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations';

/** Thrown when the database was written by a newer awaiting build. Nothing is written. */
export class SchemaTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `awaiting.db has schema version ${found}, but this build supports up to ${supported}. ` +
        'Update awaiting; the database was left untouched.',
    );
    this.name = 'SchemaTooNewError';
    this.found = found;
    this.supported = supported;
  }
}

/** Current `PRAGMA user_version`. */
export function schemaVersion(db: Database.Database): number {
  const v = db.pragma('user_version', { simple: true });
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`unexpected user_version ${String(v)}`);
  }
  return v;
}

/** Apply every migration newer than `user_version`, each in its own transaction. Returns the new version. */
export function migrate(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0);
  let current = schemaVersion(db);
  if (current > latest) throw new SchemaTooNewError(current, latest);

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      // user_version takes no bound parameters; `version` is an integer from our own table.
      db.pragma(`user_version = ${Math.trunc(m.version)}`);
    })();
    current = m.version;
  }
  return current;
}

export interface OpenStoreOptions {
  /** Override the migration list (tests only). */
  readonly migrations?: readonly Migration[];
}

/**
 * Open (creating if needed) the SQLite file at `path`, refuse a too-new schema without writing,
 * set WAL / foreign keys / busy timeout / synchronous=NORMAL, then migrate.
 */
export function openStore(path: string, options: OpenStoreOptions = {}): Database.Database {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest =
    options.migrations === undefined
      ? LATEST_SCHEMA_VERSION
      : migrations.reduce((m, x) => Math.max(m, x.version), 0);

  const db = openDatabase(path);
  try {
    db.pragma('busy_timeout = 2000');
    // Check before any pragma that writes the file (journal_mode), so a newer DB stays untouched.
    const found = schemaVersion(db);
    if (found > latest) throw new SchemaTooNewError(found, latest);

    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (path !== ':memory:' && mode !== 'wal') {
      throw new Error(`could not enable WAL (journal_mode=${String(mode)})`);
    }
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
