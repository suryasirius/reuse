// Wipes demo/demo.sqlite (and its WAL/SHM sidecar files) and demo/uploads, then re-runs
// seed-demo.js to repopulate everything from scratch. Never touches production data.sqlite or
// public/uploads — those live at completely different paths and this script never references them.
//
// Usage: npm run demo:reset

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const demoDir = path.join(ROOT, 'demo');

console.log('Resetting demo environment...');

for (const suffix of ['', '-wal', '-shm']) {
  const f = path.join(demoDir, 'demo.sqlite' + suffix);
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log('  removed ' + path.relative(ROOT, f));
  }
}

const uploadsDir = path.join(demoDir, 'uploads');
if (fs.existsSync(uploadsDir)) {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  console.log('  removed ' + path.relative(ROOT, uploadsDir));
}

console.log('Reseeding...\n');
const result = spawnSync(process.execPath, [path.join(demoDir, 'seed-demo.js')], {
  cwd: ROOT,
  stdio: 'inherit'
});
process.exitCode = result.status || 0;
