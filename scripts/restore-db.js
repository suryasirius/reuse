#!/usr/bin/env node
// Phase 9A -- companion to Phase 8's scripts/backup-db.js. A backup that has never been
// successfully restored isn't one you can rely on -- this is the other half of that proof.
//
// USAGE:
//   node scripts/restore-db.js <path-to-backup-file> [--to <destination-path>] [--force]
//
// By default, restores to DB_FILE (same env-var convention as db.js/backup-db.js/migrate.js),
// relative to the repo root. Refuses to overwrite an existing file unless --force is passed --
// restoring is a deliberate, explicit recovery operation, never an accidental default, matching
// the "DB restore must require deliberate operator action" principle from the deployment plan.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const filteredArgs = args.filter(a => a !== '--force');

const backupPath = filteredArgs[0];
if (!backupPath) {
  console.error('[restore-db] Usage: node scripts/restore-db.js <path-to-backup-file> [--to <destination>] [--force]');
  process.exit(1);
}
const toIndex = filteredArgs.indexOf('--to');
const destArg = toIndex !== -1 ? filteredArgs[toIndex + 1] : null;
const destPath = destArg
  ? path.resolve(destArg)
  : path.join(ROOT, process.env.DB_FILE || 'data.sqlite');

const resolvedBackupPath = path.resolve(backupPath);

if (!fs.existsSync(resolvedBackupPath)) {
  console.error(`[restore-db] FAILED: backup file not found at ${resolvedBackupPath}`);
  process.exit(1);
}

if (fs.existsSync(destPath) && !force) {
  console.error(`[restore-db] FAILED: destination already exists at ${destPath}. Pass --force to overwrite it deliberately (this is a destructive, explicit action -- back up the current file first if you're not certain).`);
  process.exit(1);
}

// Copy to a .tmp path first, then atomically rename into place -- mirrors backup-db.js's own
// approach, so a reader of the destination path never sees a partially-written file.
const tmpPath = destPath + '.restoring.tmp';
fs.copyFileSync(resolvedBackupPath, tmpPath);
fs.renameSync(tmpPath, destPath);
// A restored file may carry stale -wal/-shm sidecars from whatever state the backup snapshot
// captured; the destination should start clean so SQLite doesn't try to replay an unrelated WAL.
for (const suffix of ['-wal', '-shm']) {
  const sidecar = destPath + suffix;
  if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
}

console.log(`[restore-db] OK: restored ${resolvedBackupPath} -> ${destPath}`);
console.log('[restore-db] Reminder: this only restores the database file itself. If the backup was');
console.log('[restore-db] taken as part of a matched database+uploads+config backup, restore those');
console.log('[restore-db] pieces separately and verify they are from the same point in time.');
