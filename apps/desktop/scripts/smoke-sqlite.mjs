// Headless smoke test: better-sqlite3 loads inside Electron's runtime and opens :memory:.
// Run via run-electron-node.mjs (ELECTRON_RUN_AS_NODE=1), never with plain Node.
import { createRequire } from 'node:module';

try {
  const electronVersion = process.versions.electron;
  if (electronVersion === undefined) {
    throw new Error('not running inside Electron (process.versions.electron is unset)');
  }

  const Database = createRequire(import.meta.url)('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('create table t(x integer)');
    db.prepare('insert into t(x) values (?)').run(42);
    const row = db.prepare('select sqlite_version() as v, count(*) as n, sum(x) as s from t').get();
    if (row.n !== 1 || row.s !== 42) throw new Error(`unexpected row ${JSON.stringify(row)}`);
    console.log(`smoke:sqlite ok electron=${electronVersion} sqlite=${row.v}`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error('smoke:sqlite FAIL', error);
  process.exit(1);
}
