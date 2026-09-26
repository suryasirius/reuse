#!/usr/bin/env node
// Phase 9A -- minimal, non-destructive migration runner.
//
// Usage: node scripts/migrate.js
// Env:   DB_FILE          -- same convention as db.js/server.js (defaults to data.sqlite)
//        MIGRATIONS_DIR   -- override the migrations folder (used by migration_test.js to point
//                             this at a disposable fixture directory instead of the real,
//                             currently-empty database/migrations/)
//
// Behavior, in order:
//   1. Open the database (does NOT create a new one if it's missing -- see note below).
//   2. Ensure `schema_migrations` exists (CREATE TABLE IF NOT EXISTS -- a genuine no-op if it
//      already does; does not touch any other table).
//   3. Read every `NNN_*.js` file in the migrations directory, sorted numerically.
//   4. Skip any migration whose filename is already recorded in schema_migrations.
//   5. If nothing is pending: print "No pending migrations." and exit 0. Nothing else happens.
//   6. Otherwise, apply each pending migration in order, each inside its own db.transaction()
//      (all-or-nothing), recording it as applied only after its transaction commits
//      successfully. If one fails, the runner stops immediately (later migrations are NOT
//      attempted), reports which migration failed and why, and exits non-zero -- the DB is left
//      exactly as it was after the last successfully-applied migration, never partially applied.
//
// This script deliberately does NOT create the database file if it doesn't exist. Migrating a
// database that isn't there yet is very likely an environment misconfiguration (wrong DB_FILE,
// wrong working directory) -- silently creating an empty DB and "successfully" migrating it
// would hide that mistake instead of surfacing it.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dbFile = path.join(ROOT, process.env.DB_FILE || 'data.sqlite');
const migrationsDir = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.join(ROOT, 'database', 'migrations');

function fail(msg) {
  console.error('[migrate] FAILED: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(dbFile)) {
  fail(`Database not found at ${dbFile}. Set DB_FILE if it lives somewhere else. Refusing to create a new database via the migration runner.`);
}

const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);
`);

let files = [];
if (fs.existsSync(migrationsDir)) {
  files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{3}_.+\.js$/.test(f))
    .sort(); // zero-padded numeric prefix sorts correctly as a plain string sort
}

const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
const pending = files.filter(f => !applied.has(f));

if (pending.length === 0) {
  console.log('[migrate] No pending migrations.');
  db.close();
  process.exit(0);
}

console.log(`[migrate] ${pending.length} pending migration(s): ${pending.join(', ')}`);

for (const file of pending) {
  const fullPath = path.join(migrationsDir, file);
  let migration;
  try {
    migration = require(fullPath);
  } catch (err) {
    fail(`Could not load migration ${file}: ${err.message}`);
  }
  if (!migration || typeof migration.up !== 'function') {
    fail(`Migration ${file} does not export an up(db) function.`);
  }
  console.log(`[migrate] Applying ${file}...`);
  try {
    const runMigration = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(file);
    });
    runMigration();
    console.log(`[migrate] Applied ${file}.`);
  } catch (err) {
    // The transaction has already rolled back at this point (better-sqlite3 rolls back
    // automatically on a thrown error inside db.transaction()), so schema_migrations does NOT
    // record this file, and none of this migration's own changes were committed either.
    fail(`Migration ${file} threw and was rolled back: ${err.message}\nNo later migrations were attempted. The database is unchanged from before this migration ran.`);
  }
}

console.log('[migrate] All pending migrations applied successfully.');
db.close();
process.exit(0);
