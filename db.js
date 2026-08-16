const Database = require('better-sqlite3');
const path = require('path');
// DB_FILE lets a separate process (e.g. the demo environment under demo/) point this exact same
// code at a different SQLite file. Unset (the normal/production case) it behaves exactly as
// before — same filename, same location, zero behavior change.
const db = new Database(path.join(__dirname, process.env.DB_FILE || 'data.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'individual', -- individual | business
  location TEXT DEFAULT '',
  is_verified INTEGER DEFAULT 0,
  verify_code TEXT DEFAULT '',
  last_active_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  condition TEXT DEFAULT 'used',
  price_type TEXT NOT NULL DEFAULT 'free', -- free | paid | exchange | rent
  price REAL DEFAULT 0,
  exchange_for TEXT DEFAULT '',
  rent_rate REAL DEFAULT 0,
  rent_period TEXT DEFAULT '', -- day | week | month
  deposit REAL DEFAULT 0,
  media_url TEXT DEFAULT '',
  media_type TEXT DEFAULT '', -- image | video
  is_recurring INTEGER DEFAULT 0,
  frequency TEXT DEFAULT '', -- daily | weekly | monthly | one_time
  quantity TEXT DEFAULT '',
  status TEXT DEFAULT 'available', -- available | claimed | closed
  request_count INTEGER DEFAULT 0,
  listing_type TEXT DEFAULT 'consumer', -- consumer | business_waste
  pickup_available INTEGER DEFAULT 1,
  expires_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', -- pending | accepted | declined
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(requester_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS item_media (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  media_type TEXT DEFAULT 'image', -- image | video
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- new_request | request_accepted | request_declined | ...
  message TEXT NOT NULL,
  item_id TEXT,
  target_type TEXT, -- item | request | claim | offer | user — what a click on this notification should open
  target_id TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL, -- item | user | request | rating
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'open', -- open | resolved | dismissed
  resolved_by TEXT DEFAULT NULL,
  resolved_at TEXT DEFAULT NULL,
  resolution_note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(reporter_id) REFERENCES users(id)
);

-- V1 moderation audit trail. Every admin action (report resolution, listing close, ban/unban)
-- writes one row here — a single lightweight log doubles as both "moderation history" and the
-- audit trail, rather than scattering history across several tables.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL, -- resolve_report | dismiss_report | close_item | close_request | ban_user | unban_user
  target_type TEXT NOT NULL, -- report | item | request | user
  target_id TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(admin_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'thing', -- thing | service
  category TEXT NOT NULL,
  budget_type TEXT NOT NULL DEFAULT 'free', -- free | paid | exchange
  budget_amount REAL DEFAULT 0,
  exchange_for TEXT DEFAULT '',
  quantity TEXT DEFAULT '',
  is_urgent INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open', -- open | fulfilled | closed
  offer_count INTEGER DEFAULT 0,
  expires_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS request_offers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  responder_id TEXT NOT NULL,
  message TEXT DEFAULT '',
  offered_price REAL DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending | accepted | declined
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(responder_id) REFERENCES users(id)
);

-- V1 trust/rating system. One rating per (exchange, rater) — the UNIQUE constraint below is the
-- real duplicate-prevention mechanism, not just an application-level check. exchange_type +
-- exchange_id point at either a claims row or a request_offers row; both must have reached
-- status='completed' before the API will accept a rating referencing them (enforced in server.js,
-- not here, since SQLite can't easily cross-check status across two different possible tables).
CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  exchange_type TEXT NOT NULL, -- claim | offer
  exchange_id TEXT NOT NULL,
  rater_id TEXT NOT NULL,
  ratee_id TEXT NOT NULL,
  stars INTEGER NOT NULL,
  tags TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(rater_id) REFERENCES users(id),
  FOREIGN KEY(ratee_id) REFERENCES users(id),
  UNIQUE(exchange_type, exchange_id, rater_id)
);
`);

// Migration for databases created before rent/trending fields existed.
const existingColumns = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
const migrations = {
  rent_rate: "ALTER TABLE items ADD COLUMN rent_rate REAL DEFAULT 0",
  rent_period: "ALTER TABLE items ADD COLUMN rent_period TEXT DEFAULT ''",
  deposit: "ALTER TABLE items ADD COLUMN deposit REAL DEFAULT 0",
  request_count: "ALTER TABLE items ADD COLUMN request_count INTEGER DEFAULT 0",
  listing_type: "ALTER TABLE items ADD COLUMN listing_type TEXT DEFAULT 'consumer'",
  pickup_available: "ALTER TABLE items ADD COLUMN pickup_available INTEGER DEFAULT 1",
  expires_at: "ALTER TABLE items ADD COLUMN expires_at TEXT DEFAULT NULL"
};
for (const [col, sql] of Object.entries(migrations)) {
  if (!existingColumns.includes(col)) db.exec(sql);
}

// Migration for users table (trust features: verification, activity tracking).
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
const userMigrations = {
  is_verified: "ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0",
  verify_code: "ALTER TABLE users ADD COLUMN verify_code TEXT DEFAULT ''",
  last_active_at: "ALTER TABLE users ADD COLUMN last_active_at TEXT DEFAULT (datetime('now'))"
};
for (const [col, sql] of Object.entries(userMigrations)) {
  if (!userColumns.includes(col)) db.exec(sql);
}

// Migration for requests table (auto-expiry).
const requestColumns = db.prepare("PRAGMA table_info(requests)").all().map(c => c.name);
if (!requestColumns.includes('expires_at')) db.exec("ALTER TABLE requests ADD COLUMN expires_at TEXT DEFAULT NULL");

// Migration for sessions table (server-side expiry — previously only the client cookie expired,
// the DB row lived forever). Existing sessions get a fresh 30-day expiry so nobody already logged
// in gets silently kicked out by this change.
const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
if (!sessionColumns.includes('expires_at')) {
  db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT DEFAULT NULL");
  db.exec("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE expires_at IS NULL");
}

// Migration: safe pickup-location fields on items.
// pickup_area is public-safe (approximate). pickup_address/pickup_instructions are exact/private
// and must only ever be returned by the API to the owner or the accepted requester (see server.js).
const itemColumns2 = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
const itemMigrations2 = {
  pickup_type: "ALTER TABLE items ADD COLUMN pickup_type TEXT DEFAULT 'public_point'",
  pickup_area: "ALTER TABLE items ADD COLUMN pickup_area TEXT DEFAULT ''",
  pickup_address: "ALTER TABLE items ADD COLUMN pickup_address TEXT DEFAULT ''",
  pickup_instructions: "ALTER TABLE items ADD COLUMN pickup_instructions TEXT DEFAULT ''"
};
for (const [col, sql] of Object.entries(itemMigrations2)) {
  if (!itemColumns2.includes(col)) db.exec(sql);
}

// Migration: two-sided completion confirmation on claims (item exchanges).
const claimColumns = db.prepare("PRAGMA table_info(claims)").all().map(c => c.name);
const claimMigrations = {
  giver_confirmed: "ALTER TABLE claims ADD COLUMN giver_confirmed INTEGER DEFAULT 0",
  receiver_confirmed: "ALTER TABLE claims ADD COLUMN receiver_confirmed INTEGER DEFAULT 0",
  completed_at: "ALTER TABLE claims ADD COLUMN completed_at TEXT DEFAULT NULL",
  not_completed_reason: "ALTER TABLE claims ADD COLUMN not_completed_reason TEXT DEFAULT ''"
};
for (const [col, sql] of Object.entries(claimMigrations)) {
  if (!claimColumns.includes(col)) db.exec(sql);
}

// Migration: same pickup + confirmation fields on request_offers (the "giver" in a request
// fulfillment is the responder; the "receiver" is the request's poster).
const offerColumns = db.prepare("PRAGMA table_info(request_offers)").all().map(c => c.name);
const offerMigrations = {
  pickup_type: "ALTER TABLE request_offers ADD COLUMN pickup_type TEXT DEFAULT 'public_point'",
  pickup_area: "ALTER TABLE request_offers ADD COLUMN pickup_area TEXT DEFAULT ''",
  pickup_address: "ALTER TABLE request_offers ADD COLUMN pickup_address TEXT DEFAULT ''",
  pickup_instructions: "ALTER TABLE request_offers ADD COLUMN pickup_instructions TEXT DEFAULT ''",
  giver_confirmed: "ALTER TABLE request_offers ADD COLUMN giver_confirmed INTEGER DEFAULT 0",
  receiver_confirmed: "ALTER TABLE request_offers ADD COLUMN receiver_confirmed INTEGER DEFAULT 0",
  completed_at: "ALTER TABLE request_offers ADD COLUMN completed_at TEXT DEFAULT NULL",
  not_completed_reason: "ALTER TABLE request_offers ADD COLUMN not_completed_reason TEXT DEFAULT ''"
};
for (const [col, sql] of Object.entries(offerMigrations)) {
  if (!offerColumns.includes(col)) db.exec(sql);
}

// Indexes for the monthly badge/leaderboard queries (calculated live from completed_at, never
// from a manually-reset counter).
db.exec("CREATE INDEX IF NOT EXISTS idx_claims_completed ON claims(status, completed_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_request_offers_completed ON request_offers(status, completed_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_items_listing_type ON items(listing_type)");
db.exec("CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON ratings(ratee_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_ratings_rater ON ratings(rater_id)");

// Migration: notification click-routing fields, for databases created before the V1 notification
// center existed.
const notifColumns = db.prepare("PRAGMA table_info(notifications)").all().map(c => c.name);
const notifMigrations = {
  target_type: "ALTER TABLE notifications ADD COLUMN target_type TEXT",
  target_id: "ALTER TABLE notifications ADD COLUMN target_id TEXT"
};
for (const [col, sql] of Object.entries(notifMigrations)) {
  if (!notifColumns.includes(col)) db.exec(sql);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read)");

// Migration: Food Rescue V1 fields on items. available_until is the donor's stated pickup
// availability deadline — NOT a certified food-safety expiry date, and not required for non-food
// listings. is_edible_food only matters for the 'Food & Organic Waste' category, which mixes
// edible surplus with genuine inedible waste (compost/feed material) — 'Food (Surplus)' listings
// are always treated as edible regardless of this flag (see isEdibleFoodListing() in server.js).
const itemColumns3 = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
const itemMigrations3 = {
  available_until: "ALTER TABLE items ADD COLUMN available_until TEXT DEFAULT NULL",
  is_urgent: "ALTER TABLE items ADD COLUMN is_urgent INTEGER DEFAULT 0",
  food_pref: "ALTER TABLE items ADD COLUMN food_pref TEXT DEFAULT 'not_specified'", // vegetarian | non_vegetarian | mixed | not_specified
  is_edible_food: "ALTER TABLE items ADD COLUMN is_edible_food INTEGER DEFAULT 0"
};
for (const [col, sql] of Object.entries(itemMigrations3)) {
  if (!itemColumns3.includes(col)) db.exec(sql);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_items_urgent ON items(is_urgent, status)");

// Migration: Trust & Safety / Admin V1. is_admin is synced from the ADMIN_EMAILS env var at every
// login (see server.js) — this column is the fast, explicit source of truth requireAdmin actually
// checks on each request; the env var only ever matters at the moment of login.
const userColumns2 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
const userMigrations2 = {
  is_admin: "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
  is_banned: "ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0",
  ban_reason: "ALTER TABLE users ADD COLUMN ban_reason TEXT DEFAULT ''"
};
for (const [col, sql] of Object.entries(userMigrations2)) {
  if (!userColumns2.includes(col)) db.exec(sql);
}

// Migration: report resolution fields, for databases created before this phase existed.
const reportColumns = db.prepare("PRAGMA table_info(reports)").all().map(c => c.name);
const reportMigrations = {
  status: "ALTER TABLE reports ADD COLUMN status TEXT DEFAULT 'open'",
  resolved_by: "ALTER TABLE reports ADD COLUMN resolved_by TEXT DEFAULT NULL",
  resolved_at: "ALTER TABLE reports ADD COLUMN resolved_at TEXT DEFAULT NULL",
  resolution_note: "ALTER TABLE reports ADD COLUMN resolution_note TEXT DEFAULT ''"
};
for (const [col, sql] of Object.entries(reportMigrations)) {
  if (!reportColumns.includes(col)) db.exec(sql);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_moderation_actions_created ON moderation_actions(created_at)");

// Migration: Image Moderation V1. status defaults to 'approved' so every existing row (posted
// before this feature existed) stays exactly as visible as it always was — this migration never
// hides or breaks historical images. Going forward, server.js's upload flow explicitly sets
// status to 'pending_review' or 'approved' per image at upload time (see moderateImage()); it
// only relies on this column default for pre-existing rows.
const itemMediaColumns = db.prepare("PRAGMA table_info(item_media)").all().map(c => c.name);
const itemMediaMigrations = {
  status: "ALTER TABLE item_media ADD COLUMN status TEXT DEFAULT 'approved'", // approved | pending_review
  moderation_note: "ALTER TABLE item_media ADD COLUMN moderation_note TEXT DEFAULT ''",
  moderated_at: "ALTER TABLE item_media ADD COLUMN moderated_at TEXT DEFAULT NULL",
  moderated_by: "ALTER TABLE item_media ADD COLUMN moderated_by TEXT DEFAULT NULL" // admin user id, or 'auto' for an API decision
};
for (const [col, sql] of Object.entries(itemMediaMigrations)) {
  if (!itemMediaColumns.includes(col)) db.exec(sql);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_item_media_status ON item_media(status)");

// Hard monthly usage cap for the moderation API (avoids surprise billing on a free/metered tier).
// One row per calendar month (month_key = 'YYYY-MM'); server.js increments this on every API call
// and refuses to call the provider again once MODERATION_MONTHLY_LIMIT is reached that month.
db.exec(`
CREATE TABLE IF NOT EXISTS moderation_usage (
  month_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
)
`);

module.exports = db;
