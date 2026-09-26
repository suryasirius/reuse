// PHASE 8 HARDENING — Section 21 (Database Backup / Recovery Readiness).
//
// This is a simple, local, operator-run backup script — NOT a disaster-recovery system. It answers
// the specific, narrow question this phase asked: "can production safely back up the SQLite
// database?" Nothing here schedules itself, uploads anywhere, or manages retention/rotation beyond
// what's described below. Running it, storing the output somewhere durable (off this VPS), and
// deciding how often to run it all remain the operator's responsibility.
//
// WHY better-sqlite3's built-in backup() and not `cp data.sqlite ...`:
// This app runs in WAL (Write-Ahead Log) mode (see db.js). In WAL mode, recent writes live in
// data.sqlite-wal, not in the main data.sqlite file yet — a plain filesystem copy of data.sqlite
// alone, taken while the server is running, can produce a backup that is missing the most recent
// transactions or is internally inconsistent. better-sqlite3's `.backup()` method uses SQLite's own
// Online Backup API, which is safe to run against a live, open, concurrently-written database: it
// produces a single consistent snapshot file, no matter what the server is doing at the same moment,
// and does not require stopping the server or holding a long-lived write lock.
//
// USAGE:
//   node scripts/backup-db.js
//   DB_FILE=demo/demo.sqlite node scripts/backup-db.js   (same DB_FILE override db.js itself supports)
//
// Exits non-zero and prints a clear error on ANY failure (missing source file, disk full, permission
// error, etc.) — this fails loudly by design, per this phase's own instruction, rather than silently
// producing an empty or partial backup file.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbFile = process.env.DB_FILE || 'data.sqlite';
const sourcePath = path.join(__dirname, '..', dbFile);
const backupDir = path.join(__dirname, '..', 'backups', 'db');

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found at ${sourcePath}. Set DB_FILE if it lives somewhere else.`);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const destName = `${path.basename(dbFile, path.extname(dbFile))}_${timestamp()}${path.extname(dbFile) || '.sqlite'}`;
  const destPath = path.join(backupDir, destName);
  const tmpPath = destPath + '.tmp';

  // Open the LIVE database read-write (matches how the running server has it open) and use the
  // Online Backup API to write a consistent snapshot to a .tmp path first, then atomically rename it
  // into place — a reader/lister of the backups/ directory should never see a partially-written file
  // under its final name, even if this process is killed mid-backup.
  const db = new Database(sourcePath);
  try {
    await db.backup(tmpPath);
  } finally {
    db.close();
  }
  fs.renameSync(tmpPath, destPath);

  const sizeMb = (fs.statSync(destPath).size / (1024 * 1024)).toFixed(2);
  console.log(`[backup-db] OK: ${destPath} (${sizeMb} MB)`);
  console.log(`[backup-db] Reminder: this only backs up the database file. Approved user-uploaded photos`);
  console.log(`[backup-db] live separately under public/uploads/ (or UPLOAD_DIR) and are NOT copied by`);
  console.log(`[backup-db] this script — back that directory up separately if photo loss would matter.`);
  console.log(`[backup-db] Reminder: backups/ is git-ignored and lives on this same disk — for real`);
  console.log(`[backup-db] disaster recovery (this VPS itself failing), copy backups/ to separate storage.`);
}

main().catch(err => {
  console.error('[backup-db] FAILED:', err.message);
  process.exit(1);
});
