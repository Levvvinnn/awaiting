import Database from 'better-sqlite3';

/**
 * Open a raw SQLite connection (a file path or ':memory:'). No pragmas, no migrations: use
 * `openStore` from ./store/open for the app database.
 */
export function openDatabase(path: string): Database.Database {
  return new Database(path);
}

/** The SQLite library version, e.g. "3.50.4". */
export function sqliteVersion(db: Database.Database): string {
  const row = db.prepare<[], { v: string }>('select sqlite_version() as v').get();
  if (row === undefined) throw new Error('sqlite_version() returned no row');
  return row.v;
}
