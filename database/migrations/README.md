# Database migrations

This folder holds numbered, one-way schema migrations for the SQLite database, run by
`scripts/migrate.js`.

## Why this exists alongside db.js's own schema setup

`db.js` already creates every table with `CREATE TABLE IF NOT EXISTS` and evolves existing
tables additively via an idempotent `ALTER TABLE ... ADD COLUMN` pass (checked against
`PRAGMA table_info` on every startup). That mechanism is NOT replaced by this folder -- it's
how the CURRENT schema, as of Phase 9A, came to exist, and it keeps working exactly as before.

This folder is for FUTURE schema changes from this point forward: anything more involved than
"add a column with a default" (new tables with data backfill, restructuring, anything that
benefits from being reviewed, numbered, and tracked explicitly rather than folded silently into
db.js's startup routine).

## Rules

1. Each migration is a separate file: `NNN_short_description.js` (zero-padded 3-digit number,
   e.g. `001_example.js`), exporting `{ up(db) { ... } }`.
2. Migrations run in numeric order, inside a single `db.transaction()` each -- either the whole
   migration applies, or none of it does.
3. Applied migrations are recorded in a `schema_migrations` table (id, applied_at). A migration
   that's already recorded is never re-run.
4. Running the migration runner against a database with no pending migrations is always a
   complete no-op beyond creating the (empty) tracking table if it doesn't exist yet -- no
   existing table is touched, no data is modified. This is deliberately the first thing
   `migration_test.js` verifies.
5. This folder starts EMPTY on purpose. No migration was written just to "backfill" the schema
   that already exists via db.js -- inventing one would risk drifting out of sync with the real
   startup schema for no benefit. The first real file here will be whatever the next genuine
   schema change turns out to be.
6. A migration must never `DROP TABLE`, `DELETE FROM` (without a very deliberate, reviewed
   reason), or otherwise destroy existing rows. If a change genuinely isn't safely reversible
   or additive, the mitigation is the mandatory pre-migration backup (see `scripts/migrate.js`
   and `docs/deployment.md`), not a clever migration that tries to be undoable.
