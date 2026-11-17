import Database from 'better-sqlite3';

/** Open a SQLite database. M0 uses ':memory:' only; file paths and migrations are M1. */
export function openDatabase(path: ':memory:'): Database.Database {
  return new Database(path);
}

/** The SQLite library version, e.g. "3.50.4". */
export function sqliteVersion(db: Database.Database): string {
  const row = db.prepare<[], { v: string }>('select sqlite_version() as v').get();
  if (row === undefined) throw new Error('sqlite_version() returned no row');
  return row.v;
}
