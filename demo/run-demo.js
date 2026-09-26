// Starts the REAL, unmodified server.js pointed at the demo database and demo uploads folder
// instead of your production data.sqlite / public/uploads. Nothing about the application code
// changes in demo mode — only which files it reads and writes.
//
// Usage: npm run demo
// (If demo/demo.sqlite doesn't exist yet, run `npm run demo:seed` first — or just
// `npm run demo:reset`, which wipes and reseeds it in one step.)

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.DEMO_PORT || '3300';
const ADMIN_EMAIL = 'admin@demo.zineedo.local';

const demoDbPath = path.join(ROOT, 'demo', 'demo.sqlite');
if (!fs.existsSync(demoDbPath)) {
  console.log('No demo database found yet.');
  console.log('Run `npm run demo:seed` (or `npm run demo:reset`) first to populate it with sample data.\n');
  process.exit(1);
}

process.env.DB_FILE = 'demo/demo.sqlite';
process.env.UPLOAD_DIR = 'demo/uploads';
process.env.PORT = PORT;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;

console.log(`\nStarting Zineedo in DEMO MODE at http://localhost:${PORT}`);
console.log('Using demo/demo.sqlite — your real data.sqlite is untouched.');
console.log('Log in as admin@demo.zineedo.local (or any *@demo.zineedo.local account), password: Demo@1234\n');

process.chdir(ROOT);
require(path.join(ROOT, 'server.js'));
