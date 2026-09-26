# Deployment, Backup & Rollback Procedure

This document describes how to release a new version of Zineedo's code, and how to recover
if something goes wrong. It does not introduce any new tooling. Every script referenced here
already exists and has been tested:

- `scripts/backup-db.js` — Phase 8, unmodified.
- `scripts/restore-db.js` — Phase 9A.
- `scripts/deploy-release.js` — Phase 9A.
- `scripts/migrate.js` — Phase 9A.

## 1. The filesystem layout this all assumes

```
BASE_DIR/
  releases/
    2026-09-10T12-00-00-000Z/    <- one full copy of application CODE
    2026-09-15T09-30-00-000Z/    <- a newer release
  current -> releases/2026-09-15T09-30-00-000Z/   (symlink)
  shared/
    database/    <- the SQLite file. NEVER inside a release.
    uploads/     <- approved user photos/videos. NEVER inside a release.
    quarantine/  <- pending-moderation uploads. NEVER inside a release.
    backups/     <- output of backup-db.js. NEVER inside a release.
    logs/
```

**`shared/` is sacred.** No command in `deploy-release.js` ever creates, copies, deletes, or
writes into `shared/` except the one-time `ensureShared()` call that creates the (empty)
subdirectories the first time `BASE_DIR` is used. Every `new` and `rollback` operation touches
only `releases/` and the `current` symlink. This is the entire reason the release/shared split
exists: application code becomes disposable, and the database, uploads, and backups do not
move or get duplicated when code changes.

Each release directory gets its own `backups` entry, but it is a **symlink to
`shared/backups`**, not a real directory — this is what lets `backup-db.js` (which resolves its
output path relative to its own file location) write into the persistent location without any
change to that script. Confirmed by `data_preservation_test.js` (see Deliverable 2/3 report).

Each release also gets a `.env-hint.json` file recording the correct relative `DB_FILE`,
`UPLOAD_DIR`, and `QUARANTINE_DIR` values pointing into `shared/` — because `server.js`/`db.js`
resolve those paths relative to their own location by default, and a deployed release must not
be started without pointing them at `shared/` instead of its own (disposable) directory.

## 2. Two different kinds of "rollback" — never confuse these

- **Code rollback** (`node scripts/deploy-release.js rollback`): moves the `current` symlink
  back to the previous release directory. This is fast, safe, and reversible in the other
  direction just as easily. It changes nothing in `shared/` — the database keeps whatever state
  it was in, including any schema migration that already ran.
- **Database restore** (`node scripts/restore-db.js <backup-file> [--to <dest>] [--force]`):
  overwrites the live database file with a specific backup snapshot. This is a deliberate,
  explicit, and destructive recovery action — it is never triggered automatically by a code
  rollback, and it requires `--force` to overwrite an existing file.

If a new release's code is broken, roll back the code. Do **not** reach for a database restore
unless the *data itself* is what's wrong (e.g., a migration corrupted something, or bad data
got written). Rolling the code back does not undo a migration's schema change, because newer
rows may already depend on it — see `data_preservation_test.js` scenario 9, which proves this
explicitly.

## 3. Standard release procedure

Run these steps in order for every release that touches the database schema, and steps 1, 3–6
for a code-only release with no migration.

1. **Backup.**
   ```
   node scripts/backup-db.js
   ```
   Produces a timestamped snapshot in `shared/backups/db/` using SQLite's Online Backup API —
   safe to run against the live, running server, no downtime required. This step is never
   skipped before a release that includes a migration.

2. **Verify the backup.** Confirm the new file appeared and has a reasonable size (the script
   prints both). Optionally, on a scratch copy, run:
   ```
   node scripts/restore-db.js shared/backups/db/<file> --to /tmp/verify.sqlite
   ```
   and open `/tmp/verify.sqlite` with a SQLite tool to spot-check it opens and looks right. This
   is the only way to know a backup is actually restorable, rather than just present.

3. **Deploy the new release.**
   ```
   node scripts/deploy-release.js new /path/to/updated/source
   ```
   Copies the fixed `APP_ENTRIES` allowlist (`server.js`, `db.js`, `geocoding.js`,
   `package.json`, `package-lock.json`, `public`, `scripts`, `database`) into a new
   `releases/<timestamp>/` directory and atomically swaps `current` to point at it. The previous
   release remains on disk, untouched, ready for a code rollback.

4. **Run pending migrations, if any**, from inside the new release directory (using the
   `DB_FILE`/etc. values from that release's `.env-hint.json`):
   ```
   node releases/<new-timestamp>/scripts/migrate.js
   ```
   If this exits non-zero, **stop** — do not restart the app on the new release. Either fix the
   migration and try again, or roll the code back (step 6) while investigating. A failed
   migration is guaranteed by `migrate.js` to leave the database exactly as it was before that
   migration started (see `migration_test.js` scenario 7).

5. **Restart the app process** pointed at `current/` (using the env values from
   `current/.env-hint.json`) and smoke-test it: log in, load the main feed, confirm the pages
   that exercise the area you changed.

6. **If something is wrong with the new release's code:** roll back immediately.
   ```
   node scripts/deploy-release.js rollback
   ```
   Restart the app process against `current/` again (it now points at the previous release).
   `shared/` — database, uploads, quarantine, backups — is untouched by this command. Do **not**
   pair this automatically with a database restore; only restore the database if the data
   itself, not the code, is the problem (see Section 2).

7. **If the data itself is the problem** (a bad migration, corrupted rows): use
   `scripts/restore-db.js` deliberately, with `--force`, pointed at the backup taken in step 1.
   This is a separate, explicit decision from a code rollback and should not be automated into
   the standard release flow.

## 4. What this procedure deliberately does NOT do

- It does not automatically restore the database after every failed deployment. Most
  deployment failures are code problems, not data problems, and reflexively restoring the
  database would throw away real writes that happened since the last backup for no reason.
- It does not schedule backups, rotate/retire old ones, or ship them off-server. Per
  `backup-db.js`'s own documented scope, that remains an explicit operator responsibility (e.g.
  a cron job plus copying `shared/backups/` to storage off the VPS).
- It does not invent a migration for the schema that already exists — `database/migrations/`
  starts empty on purpose (see its own README) and db.js's existing additive schema-setup
  mechanism is unchanged.

## 5. Status

This procedure has been verified mechanically end-to-end (backup → new release → migration →
restart → code rollback → restart) against disposable directories and a disposable database in
`data_preservation_test.js` (23/23 passing — corrected from an earlier 20/20 figure after fixing
a counting artifact in the test harness itself; see the Deliverable 4-6 report). It has **not
yet** been run against a real VPS —
that is Phase 10's job. Before the first real production deployment, run this exact procedure
once against the actual target VPS with a throwaway release, to confirm file permissions,
symlink support, and process-restart mechanics behave the same way outside the test sandbox.
