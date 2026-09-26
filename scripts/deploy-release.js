#!/usr/bin/env node
// Phase 9A -- minimal release/shared deployment helper.
//
// Implements the smallest reliable version of the standard "releases + shared + symlink" pattern
// for this app's actual architecture (single Node process, SQLite, local file uploads). This is a
// mechanism to be TESTED and DOCUMENTED now, not necessarily wired into the live dev checkout --
// see docs/deployment.md for how this maps onto an actual VPS.
//
// Layout, all under a single BASE_DIR (defaults to ./deploy_root, override via env for testing):
//   BASE_DIR/
//     releases/<timestamp>/     -- one full copy of the application CODE for that release
//     current -> releases/<X>   -- symlink, always points at the live release
//     shared/
//       database/   (the SQLite file lives here, OUTSIDE every release)
//       uploads/
//       quarantine/
//       backups/
//       logs/
//
// Commands:
//   node scripts/deploy-release.js new <source-dir>   -- create a new release from source-dir's
//                                                          code (NOT its shared/ data) and switch
//                                                          `current` to point at it
//   node scripts/deploy-release.js rollback           -- switch `current` back to the PREVIOUS
//                                                          release (code only -- never touches
//                                                          shared/)
//   node scripts/deploy-release.js list               -- print releases in order, mark current
//
// The one invariant this entire script exists to enforce: `shared/` is never created, copied,
// deleted, or written to by anything in this file except the one-time `ensureShared()` call that
// creates the (empty) directories if they don't already exist. Every release operation only ever
// touches `releases/` and the `current` symlink.

const path = require('path');
const fs = require('fs');

const BASE_DIR = path.resolve(process.env.BASE_DIR || path.join(process.cwd(), 'deploy_root'));
const RELEASES_DIR = path.join(BASE_DIR, 'releases');
const CURRENT_LINK = path.join(BASE_DIR, 'current');
const SHARED_DIR = path.join(BASE_DIR, 'shared');
const SHARED_SUBDIRS = ['database', 'uploads', 'quarantine', 'backups', 'logs'];

// Application code files/dirs to copy into a new release. Deliberately a fixed allowlist rather
// than "everything in source-dir" so a stray shared/ or node_modules/ in the source can never be
// accidentally copied into (and thus duplicated inside) a release.
const APP_ENTRIES = ['server.js', 'db.js', 'geocoding.js', 'package.json', 'package-lock.json', 'public', 'scripts', 'database'];

function ensureShared() {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  for (const sub of SHARED_SUBDIRS) fs.mkdirSync(path.join(SHARED_DIR, sub), { recursive: true });
}

function listReleases() {
  if (!fs.existsSync(RELEASES_DIR)) return [];
  return fs.readdirSync(RELEASES_DIR).filter(f => fs.statSync(path.join(RELEASES_DIR, f)).isDirectory()).sort();
}

function currentTarget() {
  if (!fs.existsSync(CURRENT_LINK)) return null;
  return path.basename(fs.readlinkSync(CURRENT_LINK));
}

// Absolute source paths that must NEVER be copied into a release, even though they live inside
// an APP_ENTRIES directory. `public/uploads` is the default UPLOAD_DIR location and, once real
// uploads exist, a naive recursive copy of the whole `public/` entry would duplicate every
// approved photo/video into each new disposable release -- silently ballooning disk usage and
// creating a second, stale copy of user media that isn't the one actually served (which always
// comes from shared/uploads via the UPLOAD_DIR env override). This was caught by the Deliverable
// 5 upload-persistence testing, not assumed in advance: the sandbox's public/uploads was always
// empty in earlier testing, so this never surfaced until deploying with realistic upload content.
const NEVER_COPY_INTO_RELEASE = ['public/uploads'];

function copyRecursive(src, dest, sourceDir) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (candidate) => {
      const rel = path.relative(sourceDir, candidate).split(path.sep).join('/');
      return !NEVER_COPY_INTO_RELEASE.some(skip => rel === skip || rel.startsWith(skip + '/'));
    }
  });
}

function cmdNew(sourceDir) {
  if (!sourceDir) { console.error('[deploy] Usage: node scripts/deploy-release.js new <source-dir>'); process.exit(1); }
  ensureShared();
  const releaseId = new Date().toISOString().replace(/[:.]/g, '-');
  const releaseDir = path.join(RELEASES_DIR, releaseId);
  fs.mkdirSync(releaseDir, { recursive: true });

  for (const entry of APP_ENTRIES) {
    const src = path.join(sourceDir, entry);
    if (fs.existsSync(src)) copyRecursive(src, path.join(releaseDir, entry), sourceDir);
  }

  // The release's own db.js/server.js resolve DB_FILE/UPLOAD_DIR/QUARANTINE_DIR relative to their
  // OWN __dirname by default -- so a deployed release must be launched with those env vars pointed
  // at shared/, not left to the default (which would put the DB INSIDE the disposable release dir,
  // exactly the mistake this whole mechanism exists to prevent). This is captured for the deployer
  // here rather than silently assumed.
  const envHint = {
    DB_FILE: path.relative(releaseDir, path.join(SHARED_DIR, 'database', 'zineedo.sqlite')),
    UPLOAD_DIR: path.relative(releaseDir, path.join(SHARED_DIR, 'uploads')),
    QUARANTINE_DIR: path.relative(releaseDir, path.join(SHARED_DIR, 'quarantine'))
  };
  fs.writeFileSync(path.join(releaseDir, '.env-hint.json'), JSON.stringify(envHint, null, 2));

  // scripts/backup-db.js (preserved unmodified from Phase 8) resolves its output directory
  // relative to ITS OWN file location (__dirname/../backups/db). Once copied into a release, that
  // would resolve to release/backups/db -- INSIDE the disposable release directory, not
  // shared/backups, defeating the whole point of running it from a deployed release. Rather than
  // modify the preserved script, this symlinks the release's own `backups/` straight at
  // shared/backups, so backup-db.js's existing relative-path logic transparently lands in the
  // right, persistent place with zero changes to that script.
  fs.symlinkSync(path.join(SHARED_DIR, 'backups'), path.join(releaseDir, 'backups'), 'dir');

  const tmpLink = CURRENT_LINK + '.tmp';
  if (fs.existsSync(tmpLink)) fs.rmSync(tmpLink);
  fs.symlinkSync(releaseDir, tmpLink, 'dir');
  fs.renameSync(tmpLink, CURRENT_LINK); // atomic swap -- there is never a moment with no `current`
  console.log(`[deploy] New release ${releaseId} is now current.`);
  return releaseId;
}

function cmdRollback() {
  const releases = listReleases();
  const cur = currentTarget();
  const idx = releases.indexOf(cur);
  if (idx <= 0) {
    console.error('[deploy] FAILED: no earlier release to roll back to.');
    process.exit(1);
  }
  const previous = releases[idx - 1];
  const tmpLink = CURRENT_LINK + '.tmp';
  if (fs.existsSync(tmpLink)) fs.rmSync(tmpLink);
  fs.symlinkSync(path.join(RELEASES_DIR, previous), tmpLink, 'dir');
  fs.renameSync(tmpLink, CURRENT_LINK);
  console.log(`[deploy] Rolled back: current is now ${previous} (was ${cur}). shared/ was not touched.`);
  return previous;
}

function cmdList() {
  const releases = listReleases();
  const cur = currentTarget();
  releases.forEach(r => console.log((r === cur ? '* ' : '  ') + r));
}

const [, , cmd, arg] = process.argv;
if (cmd === 'new') cmdNew(arg);
else if (cmd === 'rollback') cmdRollback();
else if (cmd === 'list') cmdList();
else {
  console.error('[deploy] Usage: node scripts/deploy-release.js <new <source-dir>|rollback|list>');
  process.exit(1);
}
