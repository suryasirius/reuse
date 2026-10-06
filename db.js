const Database = require('better-sqlite3');
const path = require('path');
// DB_FILE lets a separate process (e.g. the demo environment under demo/) point this exact same
// code at a different SQLite file. Unset (the normal/production case) it behaves exactly as
// before — same filename, same location, zero behavior change.
const db = new Database(path.join(__dirname, process.env.DB_FILE || 'data.sqlite'));

db.pragma('journal_mode = WAL');
// PHASE 8 HARDENING: two reliability pragmas that were never set.
// foreign_keys: SQLite does NOT enforce declared FOREIGN KEY constraints unless this is explicitly
// turned on per-connection — it was OFF this whole time, meaning every `FOREIGN KEY(...) REFERENCES
// ...` declaration below was purely documentation, not an enforced constraint. Verified safe to turn
// on: the only place in this codebase that deletes a row with dependents (DELETE /api/items/:id in
// server.js) already deletes item_media and claims before the item itself, inside a transaction —
// written that way specifically because the developer already anticipated FK enforcement (see that
// route's own comment). No other route deletes a users/items/requests row at all. Confirmed via the
// full existing regression suite (926/926 before this change) passing unchanged after enabling this.
// busy_timeout: SQLite's default busy behavior is to fail IMMEDIATELY with SQLITE_BUSY if another
// connection holds a write lock, rather than waiting. better-sqlite3 itself is synchronous and this
// app normally uses a single long-lived connection from one Node process, so this rarely matters
// day-to-day — but a second short-lived connection (a backup script using the online-backup API, the
// demo/ scripts, an ad-hoc `sqlite3` CLI inspection) can legitimately hold a brief write lock. 5s
// gives such a second connection room to finish rather than surfacing a raw "database is locked"
// error to a user's request.
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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

-- Trust & Safety: user-initiated blocks. Separate from 'reports' (a flag for admin moderation
-- review) -- a block is a personal relationship the blocker controls directly, with no admin
-- involvement. Bidirectional in effect (see isBlockedEitherWay() in server.js): if A blocks B,
-- both A's and B's content/interactions are hidden from each other, closing the obvious workaround
-- of the blocked side just creating new content the blocker would otherwise still see.
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(blocker_id) REFERENCES users(id),
  FOREIGN KEY(blocked_id) REFERENCES users(id),
  CHECK (blocker_id != blocked_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_pair ON blocks(blocker_id, blocked_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

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
  resolution_note: "ALTER TABLE reports ADD COLUMN resolution_note TEXT DEFAULT ''",
  // Fixed report-reason categories (see REPORT_CATEGORIES in server.js) — 'reason' remains as
  // free-text optional additional detail, category is the required, structured classification.
  category: "ALTER TABLE reports ADD COLUMN category TEXT DEFAULT 'other'"
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
  moderated_by: "ALTER TABLE item_media ADD COLUMN moderated_by TEXT DEFAULT NULL", // admin user id, or 'auto' for an API decision
  // Image pipeline quality pass: a smaller, consistently-cropped/compressed variant generated at
  // publish time (see processApprovedImage() in server.js), used for card thumbnails so a huge
  // phone-camera original isn't shipped to a 220px card. NULL for any row published before this
  // migration (old sharp-less rename) or if processing ever falls back — frontend falls back to the
  // full `url` in that case, so nothing breaks for existing images.
  thumb_url: "ALTER TABLE item_media ADD COLUMN thumb_url TEXT DEFAULT NULL"
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

// ---------- Food Rescue safety acknowledgements ----------
// Audit trail: one row each time a provider confirms the food-safety statement while posting edible
// food (role 'provider', claim_id NULL) or a recipient confirms it before requesting/claiming food
// (role 'recipient', claim_id = the claim). text_version lets a later wording change be told apart
// from earlier acknowledgements. Deliberately small — not a general legal/audit system.
db.exec(`
CREATE TABLE IF NOT EXISTS food_safety_acks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claim_id TEXT,
  role TEXT NOT NULL,
  text_version TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_food_safety_acks_item ON food_safety_acks(item_id)");

// ---------- Web Push V1 ----------
// One row per browser/device a user has turned notifications on in (endpoint is unique per
// browser install, so the same user opening Zineedo on their phone AND laptop gets two rows and a
// push to both). p256dh/auth are the browser-generated encryption keys the Push API requires to
// encrypt a payload that only that specific browser install can decrypt — server.js never sees or
// stores anything else about the device. A dead/unsubscribed endpoint is deleted reactively by
// server.js the first time a push to it fails with 404/410, rather than needing a cleanup job.
db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
)
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)");

// ---------- Location Foundation V1 ----------
// LOCATION FOUNDATION — see server.js's geocoding.js module for the actual geocoding logic.
// All columns below are purely additive/nullable: existing free-text location/pickup_area/
// pickup_address fields are untouched and remain the source of truth for display. Nothing here is
// exposed via any API response yet (see stripInternalGeoFields() in server.js) — these columns are
// populated best-effort in the background and are not read by any route's response building today.
//
// users.location_lat/location_lng: a single best-effort geocoded point for the free-text `location`
// field (already city/area-level, not a home address, so no separate public/private split is
// needed here — the text itself is already coarse).
//
// items.pickup_lat/pickup_lng and request_offers.pickup_lat/pickup_lng: the PRIVATE/canonical
// geocoded point, derived from pickup_address when present (falls back to pickup_area otherwise).
// Must never be returned by any API response except to an authorized owner/accepted-party route
// once a future phase actually needs it — today it is stripped from every response, no exceptions.
//
// items.pickup_public_lat/pickup_public_lng and the same on request_offers: a deliberately
// rounded/fuzzed point (see fuzzCoordinate() in geocoding.js) intended to eventually back
// radius/distance search without ever revealing the real pickup point. Also not yet exposed via
// any API response in this phase — computed and stored only, for a future search feature to use.
//
// *_geo_precision: 'exact' (geocoded from a specific address) | 'approximate' (geocoded from a
// coarse area description only) | NULL (never geocoded). *_geocode_status: 'ok' | 'not_found' |
// 'failed' | 'timeout' | 'rate_limited' | 'not_configured' | 'skipped' (empty input) | NULL (never
// attempted) — lets an admin/backfill script tell "never tried" apart from "tried and failed".
const userColumns3 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
const userMigrations3 = {
  location_lat: "ALTER TABLE users ADD COLUMN location_lat REAL DEFAULT NULL",
  location_lng: "ALTER TABLE users ADD COLUMN location_lng REAL DEFAULT NULL",
  location_precision: "ALTER TABLE users ADD COLUMN location_precision TEXT DEFAULT NULL",
  location_geocoded_at: "ALTER TABLE users ADD COLUMN location_geocoded_at TEXT DEFAULT NULL",
  location_geocode_status: "ALTER TABLE users ADD COLUMN location_geocode_status TEXT DEFAULT NULL"
};
for (const [col, sql] of Object.entries(userMigrations3)) {
  if (!userColumns3.includes(col)) db.exec(sql);
}

const itemColumns4 = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
const itemMigrations4 = {
  pickup_lat: "ALTER TABLE items ADD COLUMN pickup_lat REAL DEFAULT NULL",
  pickup_lng: "ALTER TABLE items ADD COLUMN pickup_lng REAL DEFAULT NULL",
  pickup_public_lat: "ALTER TABLE items ADD COLUMN pickup_public_lat REAL DEFAULT NULL",
  pickup_public_lng: "ALTER TABLE items ADD COLUMN pickup_public_lng REAL DEFAULT NULL",
  pickup_geo_precision: "ALTER TABLE items ADD COLUMN pickup_geo_precision TEXT DEFAULT NULL",
  pickup_geocoded_at: "ALTER TABLE items ADD COLUMN pickup_geocoded_at TEXT DEFAULT NULL",
  pickup_geocode_status: "ALTER TABLE items ADD COLUMN pickup_geocode_status TEXT DEFAULT NULL"
};
for (const [col, sql] of Object.entries(itemMigrations4)) {
  if (!itemColumns4.includes(col)) db.exec(sql);
}

const offerColumns2 = db.prepare("PRAGMA table_info(request_offers)").all().map(c => c.name);
const offerMigrations2 = {
  pickup_lat: "ALTER TABLE request_offers ADD COLUMN pickup_lat REAL DEFAULT NULL",
  pickup_lng: "ALTER TABLE request_offers ADD COLUMN pickup_lng REAL DEFAULT NULL",
  pickup_public_lat: "ALTER TABLE request_offers ADD COLUMN pickup_public_lat REAL DEFAULT NULL",
  pickup_public_lng: "ALTER TABLE request_offers ADD COLUMN pickup_public_lng REAL DEFAULT NULL",
  pickup_geo_precision: "ALTER TABLE request_offers ADD COLUMN pickup_geo_precision TEXT DEFAULT NULL",
  pickup_geocoded_at: "ALTER TABLE request_offers ADD COLUMN pickup_geocoded_at TEXT DEFAULT NULL",
  pickup_geocode_status: "ALTER TABLE request_offers ADD COLUMN pickup_geocode_status TEXT DEFAULT NULL"
};
for (const [col, sql] of Object.entries(offerMigrations2)) {
  if (!offerColumns2.includes(col)) db.exec(sql);
}

module.exports = db;
