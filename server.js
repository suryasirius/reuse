const express = require('express');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { nanoid } = require('nanoid');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Only trust X-Forwarded-For when we know we're actually behind a reverse proxy (set
// TRUST_PROXY=1 in that environment's config). Blindly trusting it otherwise lets a client
// spoof its own IP and dodge rate limiting entirely.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 days, matches previous cookie behavior
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PROD,       // only sent over HTTPS in production; localhost dev stays usable over HTTP
    sameSite: 'lax',       // same-origin website; native mobile clients aren't affected by this browser-only policy
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  };
}

function createSession(userId) {
  const token = nanoid(32);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime('now', '+30 days'))").run(token, userId);
  return token;
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Periodic cleanup so the sessions/reset-token tables don't grow forever. Runs in-process since
// this is a single-instance server — no external cron needed at this scale.
function cleanupExpired() {
  db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
  db.prepare("DELETE FROM password_reset_tokens WHERE expires_at < datetime('now') OR used = 1").run();
  // Lightweight retention: notifications older than 90 days are dropped. Simpler than a
  // per-user "keep latest 100" trim (which needs a window-function query per user) and reuses
  // this existing hourly cleanup pass rather than adding a second scheduled job.
  db.prepare("DELETE FROM notifications WHERE created_at < datetime('now', '-90 days')").run();
}
cleanupExpired();
setInterval(cleanupExpired, 60 * 60 * 1000).unref();

// ---------- rate limiting ----------
// Generic response (never reveals *why* a request was blocked or whether an account exists).
function rateLimitHandler(req, res) {
  res.status(429).json({ error: 'Too many requests. Please try again later.' });
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const ratingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
// "Light" per the profile design — this is a public, unauthenticated endpoint, so the limit exists
// only to blunt bulk scraping, not to gate normal browsing.
const profileLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const accountUpdateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });
const changePasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler });

// UPLOAD_DIR mirrors DB_FILE — lets the demo environment store its sample photos in a separate
// folder so they never land in the real public/uploads directory. Unset, this is identical to
// the previous hardcoded path.
const uploadDir = process.env.UPLOAD_DIR ? path.join(__dirname, process.env.UPLOAD_DIR) : path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// Image Moderation V1: every uploaded file lands here first — a private directory never mounted
// by express.static, so nothing here is ever publicly reachable by URL. Files only move into
// uploadDir (public) once moderateImage() below approves them. QUARANTINE_DIR mirrors UPLOAD_DIR's
// env-var pattern so the demo environment can keep its own separate quarantine too.
const quarantineDir = process.env.QUARANTINE_DIR ? path.join(__dirname, process.env.QUARANTINE_DIR) : path.join(__dirname, 'quarantine');
fs.mkdirSync(quarantineDir, { recursive: true });

// ---------- upload security ----------
// Only these three formats are accepted. The stored file extension is derived from this map,
// NEVER from the client-supplied original filename or its extension — that's what stops both
// path traversal (a filename can't put "../" or anything else into the path we actually write
// to) and extension spoofing (a file named "evil.html.jpg" only ever gets treated as a jpg).
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: [[0xFF, 0xD8, 0xFF]] },
  'image/png': { ext: '.png', magic: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]] },
  'image/webp': { ext: '.webp', magic: [[0x52, 0x49, 0x46, 0x46]] } // 'RIFF'; full WEBP check below
};
const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024; // 8MB — generous for a photo, not for arbitrary junk
const MAX_UPLOAD_FILES = 5;

const storage = multer.diskStorage({
  // Image Moderation V1: files always land in quarantine first, never directly in the public
  // uploadDir — see moderateImage()/the POST /api/items handler for how (and whether) they move.
  destination: (req, file, cb) => cb(null, quarantineDir),
  filename: (req, file, cb) => {
    const type = ALLOWED_IMAGE_TYPES[file.mimetype];
    // Filter below rejects unknown mimetypes before this runs, but fail safe with a generic
    // extension-less name rather than ever touching file.originalname if it somehow got here.
    cb(null, nanoid() + (type ? type.ext : ''));
  }
});

// Browser-declared MIME type is layer 1 — cheap, but trivially spoofed by the client, so it's
// never trusted alone. Layer 2 is the magic-byte check on the actual bytes after upload (see
// verifyImageMagicBytes below, run in the /api/items handler once the file is on disk).
function uploadFileFilter(req, file, cb) {
  if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
    return cb(new Error('UNSUPPORTED_FILE_TYPE'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter: uploadFileFilter,
  limits: {
    fileSize: MAX_UPLOAD_FILE_BYTES,
    files: MAX_UPLOAD_FILES,
    fields: 30,     // non-file form fields in the same multipart request
    fieldSize: 1024 * 100 // 100KB per text field — plenty for a listing description
  }
});

// Layer 2 validation: read the first bytes actually written to disk and confirm they match the
// claimed type's file signature. Catches a JS/HTML/executable file renamed with a fake
// Content-Type + .jpg extension, which fileFilter alone cannot (it only sees what the client
// claims). Deliberately NOT pulling in a full image-decoding library (e.g. sharp) for this pass —
// magic-byte + declared-type agreement is enough to stop "disguised non-image file" attacks,
// which is the actual threat here; real re-encoding is a heavier dependency worth its own review
// later if ReUse Hub needs to also defend against maliciously crafted-but-valid image files
// (e.g. decompression bombs, polyglot files) rather than just disguised non-images.
function verifyImageMagicBytes(filePath, mimetype) {
  const type = ALLOWED_IMAGE_TYPES[mimetype];
  if (!type) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
    if (mimetype === 'image/webp') {
      // RIFF????WEBP — bytes 0-3 'RIFF', bytes 8-11 'WEBP'
      if (bytesRead < 12) return false;
      const riff = buf.toString('ascii', 0, 4) === 'RIFF';
      const webp = buf.toString('ascii', 8, 12) === 'WEBP';
      return riff && webp;
    }
    return type.magic.some(sig => sig.every((byte, i) => bytesRead > i && buf[i] === byte));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Runs magic-byte validation on every uploaded file for a request; deletes and rejects the whole
// upload if any file fails. Returns true (and leaves files in place) if all pass.
function validateUploadedFiles(files) {
  for (const f of files) {
    if (!verifyImageMagicBytes(f.path, f.mimetype)) {
      files.forEach(cleanupFile => { try { fs.unlinkSync(cleanupFile.path); } catch {} });
      return false;
    }
  }
  return true;
}

// Public reads only ever see approved media — pending/rejected images are never exposed by URL
// to anyone but an admin (via the dedicated /api/admin/images/:id/file route below). The owner
// isn't shown their own pending photo either (kept simple for V1); they get a text count instead
// (see pending_media_count below) so they at least know a review is in progress.
function attachMedia(item) {
  const media = db.prepare("SELECT id, url, media_type FROM item_media WHERE item_id = ? AND status = 'approved' ORDER BY position ASC").all(item.id);
  item.media = media;
  const pending = db.prepare("SELECT COUNT(*) AS c FROM item_media WHERE item_id = ? AND status = 'pending_review'").get(item.id);
  item.pending_media_count = pending.c;
  return item;
}

// ---------- Image Moderation V1 ----------
// Provider-agnostic by design: swap/add providers by extending moderateImage()'s branch below —
// the upload flow that calls it never needs to change. MODERATION_PROVIDER unset (the default) is
// the explicit "disabled/fallback-safe during beta" state: every image auto-approves exactly like
// before this feature existed, zero behavior change until a real provider is configured. Every
// other path (unknown provider, cap reached, network/API error) fails CLOSED to 'pending_review' —
// this function must never let uncertainty result in an automatic public image.
const MODERATION_PROVIDER = process.env.MODERATION_PROVIDER || '';
// Sightengine's free tier is ~2000 checks/month; default cap leaves headroom rather than cutting
// it exactly at the provider's own limit. Override via env var if a paid tier is ever added.
const MODERATION_MONTHLY_LIMIT = parseInt(process.env.MODERATION_MONTHLY_LIMIT || '1800', 10);

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function moderationUsageRemaining() {
  const row = db.prepare('SELECT count FROM moderation_usage WHERE month_key = ?').get(currentMonthKey());
  return MODERATION_MONTHLY_LIMIT - (row ? row.count : 0);
}
function incrementModerationUsage() {
  db.prepare('INSERT INTO moderation_usage (month_key, count) VALUES (?, 1) ON CONFLICT(month_key) DO UPDATE SET count = count + 1').run(currentMonthKey());
}

// Returns { status: 'approved'|'pending_review', note }. Never throws.
async function moderateImage(filePath, mimetype) {
  if (!MODERATION_PROVIDER) return { status: 'approved', note: 'moderation disabled' };
  if (moderationUsageRemaining() <= 0) return { status: 'pending_review', note: 'monthly moderation usage cap reached' };
  try {
    if (MODERATION_PROVIDER === 'sightengine') {
      const result = await moderateWithSightengine(filePath);
      incrementModerationUsage();
      return result;
    }
    return { status: 'pending_review', note: `unknown MODERATION_PROVIDER "${MODERATION_PROVIDER}"` };
  } catch (err) {
    return { status: 'pending_review', note: 'moderation check failed — held for manual review' };
  }
}

// Sightengine REST API (https://sightengine.com) — simple per-image POST, no cloud project setup.
// Credentials come only from env vars, never hardcoded, and this function is only ever reached
// when MODERATION_PROVIDER=sightengine is explicitly set.
async function moderateWithSightengine(filePath) {
  const apiUser = process.env.SIGHTENGINE_API_USER;
  const apiSecret = process.env.SIGHTENGINE_API_SECRET;
  if (!apiUser || !apiSecret) return { status: 'pending_review', note: 'Sightengine credentials not configured' };
  const FormData = require('form-data');
  const form = new FormData();
  form.append('media', fs.createReadStream(filePath));
  form.append('models', 'nudity-2.1,weapon,offensive');
  form.append('api_user', apiUser);
  form.append('api_secret', apiSecret);
  const res = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || data.status !== 'success') return { status: 'pending_review', note: 'Sightengine API error' };
  const nudity = data.nudity || {};
  const unsafeScore = Math.max(nudity.sexual_activity || 0, nudity.sexual_display || 0, nudity.erotica || 0);
  const weaponHit = data.weapon && data.weapon.classes && Object.values(data.weapon.classes).some(v => v > 0.5);
  const offensiveHit = data.offensive && data.offensive.prob > 0.5;
  if (unsafeScore > 0.5 || weaponHit || offensiveHit) return { status: 'pending_review', note: 'flagged by automated scan' };
  return { status: 'approved', note: 'passed automated scan' };
}

// Moves a validated, moderated file from quarantine into the public uploads directory it will
// actually be served from, and returns the public-facing filename to store as item_media.url.
function publishFromQuarantine(quarantinePath) {
  const filename = path.basename(quarantinePath);
  fs.renameSync(quarantinePath, path.join(uploadDir, filename));
  return '/uploads/' + filename;
}

// targetType/targetId tell the frontend what a click on this notification should open
// ('item' | 'request' | 'claim' | 'offer' | 'user'). Both optional — a notification without a
// target just isn't clickable, which is fine and shouldn't block the notification from firing.
function notify(userId, type, message, itemId, targetType, targetId) {
  db.prepare('INSERT INTO notifications (id, user_id, type, message, item_id, target_type, target_id) VALUES (?,?,?,?,?,?,?)')
    .run(nanoid(), userId, type, message, itemId || null, targetType || null, targetId || null);
}

// Trust stage: listings quietly auto-expire after LISTING_LIFETIME_DAYS so the site
// doesn't fill up with stale posts. Called lazily before reads (no background worker needed).
const LISTING_LIFETIME_DAYS = 30;
function expireStaleListings() {
  db.prepare(`UPDATE items SET status = 'closed' WHERE status = 'available' AND expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
  db.prepare(`UPDATE requests SET status = 'closed' WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
  // Food Rescue: a listing past its stated pickup-availability deadline closes automatically,
  // same mechanism as the generic 30-day expiry above, just keyed off the donor's own deadline
  // instead of a fixed listing lifetime.
  db.prepare(`UPDATE items SET status = 'closed' WHERE status = 'available' AND available_until IS NOT NULL AND available_until < datetime('now')`).run();
}

// Content-Security-Policy is intentionally left off for now: app.js's dynamically-generated modal
// markup relies on inline `style="..."` attributes in ~16 places (auth forms, post forms, item
// detail, etc.). A strict style-src without 'unsafe-inline' would silently break those. Locking
// that down properly means auditing/refactoring those call sites first — worth doing, but as its
// own focused pass with full UI regression testing, not bundled into a security-hardening pass
// where a subtle mistake could take down the whole site. Every other Helmet protection below is
// safe to enable as-is and doesn't touch app.js at all.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false // would block the unpkg.com lucide-icons <script> otherwise
}));

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(cookieParser());

// /uploads gets its own static handler (mounted before the general one) so we can force
// nosniff + a locked-down CSP + Content-Disposition on exactly the files users control the
// content of. Even though only jpg/png/webp can ever land in this folder (enforced by the
// fileFilter + magic-byte check above), this is defense-in-depth: if that validation is ever
// weakened by a future change, the browser still won't execute anything served from here.
app.use('/uploads', express.static(uploadDir, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Canonical consumer-category order (single source of truth — drives the sidebar, Post/Edit Item
// dropdowns, and homepage highlights everywhere, via GET /api/me -> state.categories in app.js).
// 'Baby Products' and 'Toys & Kids' were merged into 'Baby & Kids' — see LEGACY_CATEGORY_MERGE
// below for how existing rows carrying the old values stay discoverable without a DB rewrite.
const CATEGORIES = [
  'Furniture',
  'Food (Surplus)',
  'Electronics & Phones',
  'Computers & Laptops',
  'Education & School Supplies',
  'Construction Materials',
  'Baby & Kids',
  'Kitchen & Appliances',
  'Clothing & Accessories',
  'Tools & Equipment',
  'Books & Media',
  'Vehicles',
  'Event Items & Decorations',
  'Other'
];

// Category-merge compatibility map: maps a canonical category to the legacy category values it
// replaces. Existing item/request rows are never rewritten — this is consulted anywhere category
// is matched (filtering, homepage highlights) so old rows stay fully discoverable under the new
// name. Extend this map (don't add a second array) if another category is ever merged/renamed.
const LEGACY_CATEGORY_MERGE = { 'Baby & Kids': ['Baby Products', 'Toys & Kids'] };
function categoryFilterValues(cat) { return [cat, ...(LEGACY_CATEGORY_MERGE[cat] || [])]; }

// Homepage priority sections: which categories feed each featured strip.
// Final homepage order (confirmed with user): Urgent Requests -> Most Wanted (trending) -> Construction -> Educational.
const HOME_HIGHLIGHT_GROUPS = [
  { key: 'construction', label: 'Construction Site Leftovers', icon: '🏗️', categories: ['Construction Materials'] },
  { key: 'education', label: "Educational & Children's Needs", icon: '🎓', categories: ['Education & School Supplies', ...categoryFilterValues('Baby & Kids'), 'Books & Media'] }
];

const SERVICE_CATEGORIES = [
  'Electrician',
  'Plumber',
  'Carpenter',
  'Tutor',
  'Delivery',
  'Cleaning',
  'Repairs',
  'Assembly & Local Help',
  'Design',
  'Photography',
  'Pet Care',
  'Other Service'
];

// V1 note: this list now mixes two different things under one section (internal listing_type
// stays 'business_waste' to avoid a migration, user-facing label is "Business Surplus" — see
// app.js). The original entries are industrial byproducts (recycling/composting/feed material);
// the five new ones below are actual reusable surplus goods a business no longer needs. Both use
// the identical items/claims exchange engine — this is a category-list expansion only, not a new
// listing type or table. BUSINESS_SURPLUS_CATEGORIES (a subset) drives which categories show the
// optional available_until/is_urgent fields on the post form.
const BUSINESS_CATEGORIES = [
  'Office Furniture & Fixtures',
  'Business Equipment & Machinery',
  'Electronics & IT Equipment',
  'Packaging Material',
  'Retail / Event Surplus',
  'Metal Scrap (CNC/Machining)',
  'Wood Scrap & Sawdust',
  'Cow Dung & Manure',
  'Used Cooking Oil',
  'Food & Organic Waste',
  'Fabric & Textile Scrap',
  'Paper & Cardboard Waste',
  'Plastic Scrap',
  'Construction Debris',
  'Other Industrial Byproduct'
];
const BUSINESS_SURPLUS_CATEGORIES = [
  'Office Furniture & Fixtures',
  'Business Equipment & Machinery',
  'Electronics & IT Equipment',
  'Packaging Material',
  'Retail / Event Surplus'
];

// Categories that count as "food" for the monthly contribution badges (Top Food Giver) and for
// deciding which pickup-privacy copy to use. Matches the existing category lists exactly rather
// than inventing a new listing_type value.
const FOOD_CATEGORIES = ['Food (Surplus)', 'Food & Organic Waste'];

// Whitelist of selectable rating tags (V1 keeps this fixed and small — no free-form tagging).
const RATING_TAGS = ['good_communication', 'item_as_described', 'smooth_handover'];

// ---------- Food Rescue V1 ----------
const FOOD_PREF_VALUES = ['vegetarian', 'non_vegetarian', 'mixed', 'not_specified'];
function sanitizeFoodPref(v) { return FOOD_PREF_VALUES.includes(v) ? v : 'not_specified'; }
function truthy(v) { return v === true || v === 'true' || v === '1' || v === 1; }

// 'Food (Surplus)' is always edible surplus food. 'Food & Organic Waste' deliberately mixes real
// edible surplus (a restaurant's unsold prepared food) with genuinely inedible waste (compost
// material, used cooking oil, spoiled produce for animal feed) — so that category alone can't
// decide whether a pickup deadline should be required. The donor's own is_edible_food flag
// decides it for that one category; every other category is never treated as food.
function isEdibleFoodListing(category, isEdibleFoodFlag) {
  if (category === 'Food (Surplus)') return true;
  if (category === 'Food & Organic Waste') return truthy(isEdibleFoodFlag);
  return false;
}

// Normalizes a browser datetime-local value ("2026-08-13T14:30") into the "YYYY-MM-DD HH:MM:SS"
// shape SQLite's datetime('now') comparisons expect. Returns null for anything unparseable, which
// callers treat the same as "not provided". Known V1 limitation: datetime-local is the browser's
// local time with no timezone info, while SQLite's datetime('now') is UTC — fine for a single-server
// deployment in one timezone (this app's actual scale), worth revisiting before a multi-timezone launch.
function normalizeAvailableUntil(v) {
  if (!v) return null;
  const s = String(v).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return s + ':00';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

const PICKUP_TYPES = ['public_point', 'my_address', 'business_location', 'custom'];
function sanitizePickupType(t) { return PICKUP_TYPES.includes(t) ? t : 'public_point'; }

// Strips exact pickup info (pickup_address, pickup_instructions) AND the owner's/responder's/
// requester's email from a row. Used for every public/listing surface. pickup_area (approximate,
// e.g. "Arakkonam ~2 km away") is always safe to keep — it's the user's own coarse description, not
// a computed distance. Never trust the frontend about who's allowed to see more than this — that
// decision is made per-request at each call site below, using req.user from the verified session.
// A destructure of a field that isn't present on a given row (e.g. list endpoints that never select
// owner_email in the first place) is a harmless no-op, so this is safe to apply broadly.
function stripExactPickup(item) {
  if (!item) return item;
  const { pickup_address, pickup_instructions, owner_email, responder_email, requester_email, ...safe } = item;
  return safe;
}

// ---------- Trust & Safety / Admin V1 ----------
// Bootstrap mechanism: admin status is granted/revoked by editing this env var and having that
// person log in again — no invite flow, no manual SQL editing needed. The env var itself is only
// ever consulted at login (see /api/login and /api/signup below); every other admin check re-reads
// the users.is_admin column from the DB, which is the actual fast/explicit source of truth.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function logModeration(adminId, action, targetType, targetId, note) {
  db.prepare('INSERT INTO moderation_actions (id, admin_id, action, target_type, target_id, note) VALUES (?,?,?,?,?,?)')
    .run(nanoid(), adminId, action, targetType, targetId, String(note || '').slice(0, 500));
}

// ---------- auth helpers ----------
const USER_FIELDS = 'id, name, email, account_type, location, is_verified, is_admin, is_banned';

// Returns the session row only if it exists AND hasn't expired (checked in SQL against SQLite's
// own clock, not Node's, so there's no risk of a JS/SQLite time-format mismatch). Deletes it if
// expired so a stolen/old token can't be replayed indefinitely just by resending the cookie.
function getLiveSession(token) {
  const session = db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND (expires_at IS NULL OR expires_at >= datetime('now'))"
  ).get(token);
  if (session) return session;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return null;
}

function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const session = getLiveSession(token);
  if (!session) return res.status(401).json({ error: 'Session expired, please log in again' });
  const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(session.user_id);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  if (user.is_banned) {
    // Defense in depth: banning already revokes every session for that user at the moment of the
    // ban (see /api/admin/users/:id/ban), so this path should rarely trigger — but it guarantees a
    // banned user is rejected on every subsequent authenticated request, not just at their next
    // login, covering races like a request already in flight when the ban happened.
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(403).json({ error: 'Your account has been suspended.' });
  }
  req.user = user;
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
  next();
}

function optionalAuth(req, res, next) {
  const token = req.cookies.token;
  if (token) {
    const session = getLiveSession(token);
    if (session) {
      const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(session.user_id);
      if (user && user.is_banned) {
        // Optional-auth routes are read-only/public-facing — a banned user shouldn't get any
        // "logged in" privileges there (e.g. owner-only pickup visibility), but there's no reason
        // to hard-fail a page view, so this just quietly treats them as logged out.
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      } else if (user) {
        req.user = user;
        db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
      }
    }
  }
  next();
}

// Registered as a second middleware AFTER requireAuth on admin routes (app.get(path, requireAuth,
// requireAdmin, handler)) so it can rely on req.user already being populated and fresh from the DB
// this request — never trusts anything the client claims about its own role.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ---------- auth routes ----------
app.post('/api/signup', signupLimiter, (req, res) => {
  const { name, email, password, account_type, location } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'Password must be 6-72 characters' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const id = nanoid();
  const hash = bcrypt.hashSync(password, 10);
  const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase()) ? 1 : 0;
  db.prepare('INSERT INTO users (id, name, email, password_hash, account_type, location, is_admin) VALUES (?,?,?,?,?,?,?)')
    .run(id, name, email.toLowerCase(), hash, account_type === 'business' ? 'business' : 'individual', location || '', isAdmin);
  const token = createSession(id);
  res.cookie('token', token, sessionCookieOptions());
  res.json({ id, name, email, account_type: account_type === 'business' ? 'business' : 'individual', is_verified: 0, is_admin: isAdmin });
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  // Check ban status only after the password has already been verified — checking it earlier
  // would let an attacker use this endpoint to enumerate which accounts are banned without
  // knowing their password.
  if (user.is_banned) {
    return res.status(403).json({ error: 'Your account has been suspended.' + (user.ban_reason ? ' Reason: ' + user.ban_reason : '') });
  }
  // Admin bootstrap sync: re-checked on every login against ADMIN_EMAILS so granting or revoking
  // admin access is just an env var change + next login, no manual SQL editing. requireAdmin
  // itself never reads this env var — only the DB column set here.
  const shouldBeAdmin = ADMIN_EMAILS.includes(user.email) ? 1 : 0;
  if (shouldBeAdmin !== user.is_admin) {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(shouldBeAdmin, user.id);
  }
  const token = createSession(user.id);
  res.cookie('token', token, sessionCookieOptions());
  res.json({ id: user.id, name: user.name, email: user.email, account_type: user.account_type, is_verified: user.is_verified, is_admin: shouldBeAdmin });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.token;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('token', sessionCookieOptions());
  res.json({ ok: true });
});

// ---------- password reset ----------
// Route naming follows the existing flat /api/* convention used by /api/login, /api/signup, etc.
// rather than introducing a separate /api/auth/* namespace.
const GENERIC_RESET_MESSAGE = 'If an account exists for that email, password reset instructions will be sent.';

app.post('/api/forgot-password', passwordResetLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email) {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?,?,?, datetime(\'now\', \'+30 minutes\'))')
        .run(nanoid(), user.id, hashToken(rawToken));
      // DEMO/DEV MODE: no email provider is wired up yet, so outside production we return the raw
      // token directly (and log it) so the reset flow is testable end-to-end. In production this
      // must be replaced with actually emailing/texting a reset link containing the raw token —
      // never log or return it once a real provider is connected.
      if (!IS_PROD) {
        console.log(`[dev] password reset token for ${email}: ${rawToken}`);
        return res.json({ ok: true, message: GENERIC_RESET_MESSAGE, dev_reset_token: rawToken });
      }
    }
  }
  // Always the same response whether or not the account exists, and even for a blank/invalid
  // email — the response must not leak which case happened.
  res.json({ ok: true, message: GENERIC_RESET_MESSAGE });
});

app.post('/api/reset-password', passwordResetLimiter, (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword || !confirmPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  if (newPassword.length < 6 || newPassword.length > 72) return res.status(400).json({ error: 'Password must be 6-72 characters' });

  const tokenHash = hashToken(token);
  const row = db.prepare(
    "SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at >= datetime('now')"
  ).get(tokenHash);
  if (!row) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);
  // A password reset means any existing session (including one an attacker may hold) should stop
  // working immediately — force everyone, including the legitimate user, to log in again.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  res.json({ ok: true });
});

app.get('/api/me', optionalAuth, (req, res) => {
  res.json({ user: req.user || null, categories: CATEGORIES, business_categories: BUSINESS_CATEGORIES, service_categories: SERVICE_CATEGORIES });
});

// Edit Profile: only name and location are editable here. Email is intentionally left out — changing
// it would need its own re-verification flow, which doesn't exist yet, so this doesn't pretend to
// support it. account_type/is_admin/is_verified/is_banned are never client-settable.
app.patch('/api/me', requireAuth, accountUpdateLimiter, (req, res) => {
  const { name, location } = req.body;
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 80) return res.status(400).json({ error: 'Name must be 1-80 characters' });
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trimmed, req.user.id);
  }
  if (location !== undefined) {
    const trimmedLoc = String(location).trim();
    if (trimmedLoc.length > 120) return res.status(400).json({ error: 'Location must be under 120 characters' });
    db.prepare('UPDATE users SET location = ? WHERE id = ?').run(trimmedLoc, req.user.id);
  }
  const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(req.user.id);
  res.json({ user });
});

// Password & Security: change password while already logged in (distinct from the forgot/reset-by-
// email-token flow above, which is for when you're locked out). Requires the current password.
app.post('/api/change-password', requireAuth, changePasswordLimiter, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
  if (newPassword.length < 6 || newPassword.length > 72) return res.status(400).json({ error: 'Password must be 6-72 characters' });

  const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!fullUser || !bcrypt.compareSync(currentPassword, fullUser.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  // Revoke every OTHER session (e.g. a device you're not using right now) but keep this one alive,
  // so changing your password from a settings page doesn't also log you out of the tab you're on.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.token);
  res.json({ ok: true });
});

// ---------- trust: verification (demo OTP — no real SMS/email provider wired up yet) ----------
app.post('/api/verify/request', requireAuth, verifyLimiter, (req, res) => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET verify_code = ? WHERE id = ?').run(code, req.user.id);
  // DEMO MODE: normally this code would go out via SMS/email. We return it directly
  // so the flow is testable without a provider hooked up.
  res.json({ ok: true, demo_code: code });
});

app.post('/api/verify/confirm', requireAuth, verifyLimiter, (req, res) => {
  const user = db.prepare('SELECT verify_code FROM users WHERE id = ?').get(req.user.id);
  if (!user.verify_code || req.body.code !== user.verify_code) {
    return res.status(400).json({ error: 'Incorrect code' });
  }
  db.prepare("UPDATE users SET is_verified = 1, verify_code = '' WHERE id = ?").run(req.user.id);
  res.json({ ok: true });
});

// ---------- search & filters V1: whitelisted sort ----------
// A sort key can ONLY ever resolve through one of these maps — the raw req.query.sort value is
// never concatenated into SQL. An unrecognized key silently falls back to the section's existing
// default order rather than erroring, so a stale/bad client value can't break the page.
const ITEM_SORTS = {
  newest: 'items.created_at DESC',
  urgent: 'items.is_urgent DESC, items.created_at DESC',
  price_low: 'items.price ASC, items.created_at DESC'
};
const REQUEST_SORTS = {
  newest: 'requests.created_at DESC',
  urgent: 'requests.is_urgent DESC, requests.created_at DESC',
  price_low: 'requests.budget_amount ASC, requests.created_at DESC'
};

// ---------- items ----------
app.get('/api/items', (req, res) => {
  expireStaleListings();
  const { category, price_type, q, mine, listing_type, location, urgent, sort } = req.query;
  // "mine" (My Posts dashboard) must show the owner's own closed/completed posts too, so the
  // status!='closed' exclusion below only applies to the public browse path. Public results
  // (no mine=) are completely unaffected — same query as before this change.
  let sql = `SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
             FROM items JOIN users ON items.user_id = users.id WHERE 1=1`;
  const params = [];
  if (!mine) { sql += " AND items.status != 'closed'"; }
  // "mine" (My posts) shows both listing types for that user; otherwise filter by section.
  if (!mine) { sql += ' AND items.listing_type = ?'; params.push(listing_type === 'business_waste' ? 'business_waste' : 'consumer'); }
  if (category) {
    // Expand merged categories (e.g. 'Baby & Kids') so legacy rows still stored under the old
    // category names ('Baby Products'/'Toys & Kids') remain discoverable — see LEGACY_CATEGORY_MERGE.
    const catValues = categoryFilterValues(category);
    sql += ` AND items.category IN (${catValues.map(() => '?').join(',')})`;
    params.push(...catValues);
  }
  if (price_type) { sql += ' AND items.price_type = ?'; params.push(price_type); }
  if (location) { sql += ' AND users.location LIKE ?'; params.push(`%${location}%`); }
  if (q) { sql += ' AND (items.title LIKE ? OR items.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (urgent) { sql += ' AND items.is_urgent = 1'; }
  if (mine) { sql += ' AND items.user_id = ?'; params.push(mine); }
  // Default (no/unknown sort param) preserves the exact pre-existing order — newest first —
  // so this is purely additive and can't change behavior for any caller that doesn't opt in.
  sql += ' ORDER BY ' + (ITEM_SORTS[sort] || ITEM_SORTS.newest);
  // List/browse view is always the "public" surface: never include exact pickup address/instructions
  // here, regardless of who's logged in. Exact info is only ever returned from the single-item
  // detail route below, and only to the owner or the accepted requester.
  const rows = db.prepare(sql).all(...params).map(attachMedia).map(stripExactPickup);
  res.json(rows);
});

// Urgent listing discovery — mirrors /api/requests/urgent exactly. Must be registered BEFORE
// /api/items/:id below, otherwise Express matches "urgent" as an :id param and this route is
// never reached (route order matters — first matching pattern wins).
// Optional listing_type filter keeps "urgent food about to spoil" (homepage) and "urgent business
// surplus" (Business Surplus page) from being mixed into one undifferentiated list — without it,
// every urgent item across both sections is returned, same as before this filter was added.
app.get('/api/items/urgent', (req, res) => {
  expireStaleListings();
  const { listing_type } = req.query;
  let sql = `SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
             FROM items JOIN users ON items.user_id = users.id
             WHERE items.status = 'available' AND items.is_urgent = 1`;
  const params = [];
  if (listing_type === 'consumer' || listing_type === 'business_waste') {
    sql += ' AND items.listing_type = ?';
    params.push(listing_type);
  }
  sql += ' ORDER BY items.created_at DESC LIMIT 8';
  const rows = db.prepare(sql).all(...params).map(attachMedia).map(stripExactPickup);
  res.json(rows);
});

app.get('/api/items/:id', optionalAuth, (req, res) => {
  const item = db.prepare(`SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.email AS owner_email, users.is_verified AS owner_verified
                            FROM items JOIN users ON items.user_id = users.id WHERE items.id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const full = attachMedia(item);
  // Exact pickup_address/pickup_instructions must only ever reach: (1) the authenticated owner,
  // or (2) the requester on a claim for this item that the owner has accepted. Everyone else
  // (including logged-out visitors) only ever gets pickup_area. This check happens server-side
  // against req.user from the verified session — the frontend never gets to assert who it is.
  const isOwner = req.user && req.user.id === item.user_id;
  let isAcceptedReceiver = false;
  if (!isOwner && req.user) {
    const acceptedClaim = db.prepare(
      "SELECT id FROM claims WHERE item_id = ? AND requester_id = ? AND status = 'accepted'"
    ).get(item.id, req.user.id);
    isAcceptedReceiver = !!acceptedClaim;
  }
  res.json(isOwner || isAcceptedReceiver ? full : stripExactPickup(full));
});

app.post('/api/items', requireAuth, upload.array('media', MAX_UPLOAD_FILES), async (req, res) => {
  const { title, description, category, condition, price_type, price, exchange_for, rent_rate, rent_period, deposit, is_recurring, frequency, quantity, listing_type, pickup_available, pickup_type, pickup_area, pickup_address, pickup_instructions,
    available_until, is_urgent, food_pref, is_edible_food } = req.body;
  const files = req.files || [];
  if (!title || !description || !category) {
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Layer 2: confirm the bytes actually on disk match the claimed image type (fileFilter above
  // only checked the client-declared Content-Type, which is trivial to fake).
  if (files.length && !validateUploadedFiles(files)) {
    return res.status(400).json({ error: 'One or more files were not valid images' });
  }
  // Food Rescue: a pickup availability deadline is required for edible food listings, and
  // optional/irrelevant for everything else — see isEdibleFoodListing() above.
  const edible = isEdibleFoodListing(category, is_edible_food);
  const normalizedAvailableUntil = normalizeAvailableUntil(available_until);
  if (edible && !normalizedAvailableUntil) {
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: 'Food available until (your pickup deadline) is required for food listings' });
  }
  const id = nanoid();
  // Image Moderation V1: every uploaded file goes through moderateImage(), not just the first —
  // approved files move out of quarantine into the public uploads dir; anything else stays
  // quarantined until an admin reviews it (see /api/admin/images/*). The item's cover photo
  // (media_url/media_type on the items row) only ever points at an approved image.
  const mediaResults = [];
  for (const f of files) {
    const decision = await moderateImage(f.path, f.mimetype);
    const url = decision.status === 'approved' ? publishFromQuarantine(f.path) : '/uploads/' + f.filename;
    mediaResults.push({ url, status: decision.status, note: decision.note });
  }
  const firstApproved = mediaResults.find(m => m.status === 'approved');
  const media_url = firstApproved ? firstApproved.url : '';
  const media_type = firstApproved ? 'image' : ''; // only image/jpeg|png|webp can ever pass the filter above
  db.prepare(`INSERT INTO items (id, user_id, title, description, category, condition, price_type, price, exchange_for, rent_rate, rent_period, deposit, media_url, media_type, is_recurring, frequency, quantity, listing_type, pickup_available, pickup_type, pickup_area, pickup_address, pickup_instructions, expires_at, available_until, is_urgent, food_pref, is_edible_food)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now', '+${LISTING_LIFETIME_DAYS} days'), ?,?,?,?)`)
    .run(id, req.user.id, title, description, category, condition || 'used', price_type || 'free',
      price_type === 'paid' ? (parseFloat(price) || 0) : 0,
      price_type === 'exchange' ? (exchange_for || '') : '',
      price_type === 'rent' ? (parseFloat(rent_rate) || 0) : 0,
      price_type === 'rent' ? (rent_period || 'day') : '',
      price_type === 'rent' ? (parseFloat(deposit) || 0) : 0,
      media_url, media_type,
      is_recurring === 'true' || is_recurring === '1' || is_recurring === true ? 1 : 0,
      frequency || '', quantity || '',
      listing_type === 'business_waste' ? 'business_waste' : 'consumer',
      pickup_available === 'false' || pickup_available === '0' || pickup_available === false ? 0 : 1,
      sanitizePickupType(pickup_type), pickup_area || '', pickup_address || '', pickup_instructions || '',
      normalizedAvailableUntil, truthy(is_urgent) ? 1 : 0, sanitizeFoodPref(food_pref), edible && truthy(is_edible_food) ? 1 : 0);
  mediaResults.forEach((m, i) => {
    db.prepare("INSERT INTO item_media (id, item_id, url, media_type, position, status, moderation_note, moderated_at, moderated_by) VALUES (?,?,?,?,?,?,?, datetime('now'), 'auto')")
      .run(nanoid(), id, m.url, 'image', i, m.status, m.note);
  });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.json(attachMedia(item));
});

app.get('/api/items-trending', (req, res) => {
  const { listing_type } = req.query;
  const rows = db.prepare(`SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location
                            FROM items JOIN users ON items.user_id = users.id
                            WHERE items.status != 'closed' AND items.request_count > 0 AND items.listing_type = ?
                            ORDER BY items.request_count DESC, items.created_at DESC
                            LIMIT 8`).all(listing_type === 'business_waste' ? 'business_waste' : 'consumer').map(attachMedia).map(stripExactPickup);
  res.json(rows);
});

// ---------- homepage priority sections: Education & Children's Needs, then Construction Site Leftovers ----------
app.get('/api/home-highlights', (req, res) => {
  expireStaleListings();
  const result = HOME_HIGHLIGHT_GROUPS.map(group => {
    const placeholders = group.categories.map(() => '?').join(',');
    const rows = db.prepare(`SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
                              FROM items JOIN users ON items.user_id = users.id
                              WHERE items.status != 'closed' AND items.listing_type = 'consumer' AND items.category IN (${placeholders})
                              ORDER BY items.created_at DESC
                              LIMIT 8`).all(...group.categories).map(attachMedia).map(stripExactPickup);
    return { key: group.key, label: group.label, icon: group.icon, items: rows };
  });
  res.json(result);
});

app.patch('/api/items/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.user_id !== req.user.id) return res.status(403).json({ error: 'Not your item' });
  const { status, title, description, category, condition, quantity, price_type, price, exchange_for, rent_rate, rent_period, deposit, pickup_available, pickup_type, pickup_area, pickup_address, pickup_instructions,
    available_until, is_urgent, food_pref, is_edible_food } = req.body;

  if (status) {
    db.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, req.params.id);
    // Reposting (marking available again) resets the expiry clock.
    if (status === 'available') db.prepare(`UPDATE items SET expires_at = datetime('now', '+${LISTING_LIFETIME_DAYS} days') WHERE id = ?`).run(req.params.id);
  }
  // Full edit: only applied when title is present, so a status-only PATCH (e.g. "mark closed") still works unchanged.
  if (title !== undefined) {
    const newPriceType = price_type || item.price_type;
    const newCategory = category || item.category;
    // The edit form doesn't currently collect these fields (that UI wasn't part of this change),
    // so an edit preserves the item's existing food values unless a future PATCH explicitly
    // includes them — same "preserve if undefined" convention already used for pickup fields above.
    const newIsEdibleFood = is_edible_food !== undefined ? (truthy(is_edible_food) ? 1 : 0) : item.is_edible_food;
    const newEdible = isEdibleFoodListing(newCategory, newIsEdibleFood);
    const newAvailableUntil = available_until !== undefined ? normalizeAvailableUntil(available_until) : item.available_until;
    if (newEdible && !newAvailableUntil) {
      return res.status(400).json({ error: 'Food available until (your pickup deadline) is required for food listings' });
    }
    db.prepare(`UPDATE items SET title=?, description=?, category=?, condition=?, quantity=?, price_type=?, price=?, exchange_for=?, rent_rate=?, rent_period=?, deposit=?, pickup_available=?, pickup_type=?, pickup_area=?, pickup_address=?, pickup_instructions=?, available_until=?, is_urgent=?, food_pref=?, is_edible_food=? WHERE id=?`)
      .run(
        title, description || item.description, newCategory, condition || item.condition, quantity || '',
        newPriceType,
        newPriceType === 'paid' ? (parseFloat(price) || 0) : 0,
        newPriceType === 'exchange' ? (exchange_for || '') : '',
        newPriceType === 'rent' ? (parseFloat(rent_rate) || 0) : 0,
        newPriceType === 'rent' ? (rent_period || 'day') : '',
        newPriceType === 'rent' ? (parseFloat(deposit) || 0) : 0,
        pickup_available === 'false' || pickup_available === '0' || pickup_available === false ? 0 : 1,
        pickup_type !== undefined ? sanitizePickupType(pickup_type) : item.pickup_type,
        pickup_area !== undefined ? pickup_area : item.pickup_area,
        pickup_address !== undefined ? pickup_address : item.pickup_address,
        pickup_instructions !== undefined ? pickup_instructions : item.pickup_instructions,
        newAvailableUntil,
        is_urgent !== undefined ? (truthy(is_urgent) ? 1 : 0) : item.is_urgent,
        food_pref !== undefined ? sanitizeFoodPref(food_pref) : item.food_pref,
        newIsEdibleFood,
        req.params.id
      );
  }
  // The owner always gets the full row back (including exact pickup info) — this response only
  // ever goes to the authenticated owner, since the route is requireAuth + ownership-checked above.
  res.json(attachMedia(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id)));
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.user_id !== req.user.id) return res.status(403).json({ error: 'Not your item' });
  // item_media and claims both have a FOREIGN KEY on item_id with no ON DELETE CASCADE, so
  // deleting the item row first throws SQLITE_CONSTRAINT_FOREIGNKEY whenever the listing has a
  // photo or has been claimed. Clear the dependent rows (and their uploaded files) first.
  const media = db.prepare('SELECT * FROM item_media WHERE item_id = ?').all(req.params.id);
  const deleteItemTx = db.transaction(() => {
    db.prepare('DELETE FROM item_media WHERE item_id = ?').run(req.params.id);
    db.prepare('DELETE FROM claims WHERE item_id = ?').run(req.params.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  });
  deleteItemTx();
  media.forEach(m => {
    const filePath = path.join(__dirname, 'public', m.url);
    fs.unlink(filePath, () => {}); // best-effort; missing file shouldn't fail the request
  });
  res.json({ ok: true });
});

// ---------- claims / requests ----------
app.post('/api/items/:id/claim', requireAuth, (req, res) => {
  expireStaleListings();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.user_id === req.user.id) return res.status(400).json({ error: "Can't claim your own item" });
  // Defense-in-depth: expireStaleListings() above should already have closed this if it passed
  // its deadline, but re-check the raw field too in case a claim lands in the narrow race window
  // between that closing pass and this request. Scoped only to the new available_until field so
  // this doesn't change claim behavior for any listing that isn't using Food Rescue deadlines.
  if (item.available_until && item.available_until < db.prepare("SELECT datetime('now') AS n").get().n) {
    return res.status(400).json({ error: 'This food is past its pickup deadline and can no longer be requested' });
  }
  const id = nanoid();
  db.prepare('INSERT INTO claims (id, item_id, requester_id, message) VALUES (?,?,?,?)')
    .run(id, item.id, req.user.id, req.body.message || '');
  db.prepare('UPDATE items SET request_count = request_count + 1 WHERE id = ?').run(item.id);
  notify(item.user_id, 'new_request', `${req.user.name} requested "${item.title}"`, item.id, 'claim', id);
  res.json({ ok: true, id });
});

app.get('/api/my/claims-received', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT claims.*, items.title AS item_title, users.name AS requester_name, users.email AS requester_email, users.is_verified AS requester_verified
                            FROM claims JOIN items ON claims.item_id = items.id JOIN users ON claims.requester_id = users.id
                            WHERE items.user_id = ? ORDER BY claims.created_at DESC`).all(req.user.id);
  // Someone interested in your item is visible with name/rating/verified status only. Their email
  // only becomes visible once you've accepted their claim — same "public listing -> interested
  // person -> accepted interaction" privacy tiering as everywhere else.
  res.json(rows.map(r => (r.status === 'accepted' || r.status === 'completed' || r.status === 'not_completed') ? r : stripExactPickup(r)));
});

app.get('/api/my/claims-sent', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT claims.*, items.title AS item_title, items.status AS item_status
                            FROM claims JOIN items ON claims.item_id = items.id
                            WHERE claims.requester_id = ? ORDER BY claims.created_at DESC`).all(req.user.id);
  res.json(rows);
});

// Valid claim status transitions. The server/database status is authoritative — a second PATCH
// arriving after the claim has already moved off 'pending' (double-click, slow network retry,
// stale tab) is rejected rather than silently re-applied, which is what was letting duplicate
// request_accepted/request_declined notifications get created before this fix.
const CLAIM_TRANSITIONS = { pending: ['accepted', 'declined'] };

app.patch('/api/claims/:id', requireAuth, (req, res) => {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(claim.item_id);
  if (item.user_id !== req.user.id) return res.status(403).json({ error: 'Not your item' });
  const { status } = req.body;
  const allowed = CLAIM_TRANSITIONS[claim.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `This request is already ${claim.status} and can't be changed to ${status}` });
  }
  db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'accepted') db.prepare('UPDATE items SET status = ? WHERE id = ?').run('claimed', item.id);
  notify(claim.requester_id, status === 'accepted' ? 'request_accepted' : 'request_declined',
    `Your request for "${item.title}" was ${status}`, item.id, 'claim', claim.id);
  res.json({ ok: true });
});

const NOT_COMPLETED_REASONS = ['Pickup did not happen', 'Item/food was unavailable', 'Could not contact the other person', 'Other'];

// Two-sided completion confirmation. Only counts as a real, badge-eligible contribution once BOTH
// the giver (item owner) and the receiver (accepted requester) confirm. A listing being posted or a
// request being accepted does NOT count — only this. Role is derived from the authenticated session
// (item.user_id vs claim.requester_id), never from anything the frontend claims to be.
app.post('/api/claims/:id/confirm', requireAuth, (req, res) => {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(claim.item_id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const isGiver = item.user_id === req.user.id;
  const isReceiver = claim.requester_id === req.user.id;
  if (!isGiver && !isReceiver) return res.status(403).json({ error: 'Not part of this exchange' });
  if (claim.status !== 'accepted') return res.status(400).json({ error: 'This request has not been accepted yet' });

  const { confirmed, reason } = req.body;
  if (confirmed === false) {
    const finalReason = NOT_COMPLETED_REASONS.includes(reason) ? reason : 'Other';
    db.prepare("UPDATE claims SET status = 'not_completed', not_completed_reason = ? WHERE id = ?").run(finalReason, claim.id);
    // Free the item back up so it can be reclaimed by someone else.
    db.prepare("UPDATE items SET status = 'available' WHERE id = ?").run(item.id);
    notify(isGiver ? claim.requester_id : item.user_id, 'exchange_not_completed', `"${item.title}" was marked as not completed`, item.id, 'claim', claim.id);
    return res.json({ ok: true, status: 'not_completed' });
  }

  const field = isGiver ? 'giver_confirmed' : 'receiver_confirmed';
  db.prepare(`UPDATE claims SET ${field} = 1 WHERE id = ?`).run(claim.id);
  const updated = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
  let status = 'pending_confirmation';
  if (updated.giver_confirmed && updated.receiver_confirmed) {
    db.prepare("UPDATE claims SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(claim.id);
    status = 'completed';
    notify(isGiver ? claim.requester_id : item.user_id, 'exchange_completed', `"${item.title}" exchange is complete`, item.id, 'claim', claim.id);
  } else {
    notify(isGiver ? claim.requester_id : item.user_id, 'exchange_confirmed', `Waiting for you to confirm "${item.title}"`, item.id, 'claim', claim.id);
  }
  res.json({ ok: true, status, giver_confirmed: !!updated.giver_confirmed, receiver_confirmed: !!updated.receiver_confirmed });
});

app.get('/api/claims/:id', requireAuth, (req, res) => {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(claim.item_id);
  const isGiver = item.user_id === req.user.id;
  const isReceiver = claim.requester_id === req.user.id;
  if (!isGiver && !isReceiver) return res.status(403).json({ error: 'Not part of this exchange' });
  // Exact pickup info is safe here — only the giver/receiver of this specific accepted exchange
  // can reach this response.
  res.json({ claim, item: claim.status === 'accepted' || claim.status === 'completed' ? item : stripExactPickup(item), role: isGiver ? 'giver' : 'receiver' });
});

// ---------- ratings (V1 trust system) ----------
// Resolves who the "other party" of a completed exchange is, and confirms the caller was actually
// part of it — same isGiver/isReceiver pattern as the /confirm endpoints, never trusting anything
// the client claims about its own role. Returns null for "exchange not found", {forbidden:true}
// for "not a participant", {notCompleted:true} for "not eligible yet", or {ok:true, ratee_id}.
function resolveRatingTarget(exchangeType, exchangeId, userId) {
  if (exchangeType === 'claim') {
    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(exchangeId);
    if (!claim) return null;
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(claim.item_id);
    if (!item) return null;
    const isGiver = item.user_id === userId;
    const isReceiver = claim.requester_id === userId;
    if (!isGiver && !isReceiver) return { forbidden: true };
    if (claim.status !== 'completed') return { notCompleted: true };
    return { ok: true, ratee_id: isGiver ? claim.requester_id : item.user_id };
  }
  if (exchangeType === 'offer') {
    const offer = db.prepare('SELECT * FROM request_offers WHERE id = ?').get(exchangeId);
    if (!offer) return null;
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(offer.request_id);
    if (!request) return null;
    const isGiver = offer.responder_id === userId;
    const isReceiver = request.user_id === userId;
    if (!isGiver && !isReceiver) return { forbidden: true };
    if (offer.status !== 'completed') return { notCompleted: true };
    return { ok: true, ratee_id: isGiver ? request.user_id : offer.responder_id };
  }
  return null;
}

app.post('/api/ratings', requireAuth, ratingLimiter, (req, res) => {
  const { exchange_type, exchange_id, stars, tags, comment } = req.body;
  if (!['claim', 'offer'].includes(exchange_type) || !exchange_id) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const starsNum = parseInt(stars, 10);
  if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
    return res.status(400).json({ error: 'Stars must be a whole number from 1 to 5' });
  }
  const resolved = resolveRatingTarget(exchange_type, exchange_id, req.user.id);
  if (!resolved) return res.status(404).json({ error: 'Not found' });
  if (resolved.forbidden) return res.status(403).json({ error: 'Not part of this exchange' });
  if (resolved.notCompleted) return res.status(400).json({ error: 'This exchange has not been completed yet' });

  const cleanTags = Array.isArray(tags) ? tags.filter(t => RATING_TAGS.includes(t)).join(',') : '';
  const cleanComment = String(comment || '').slice(0, 500);
  const id = nanoid();
  try {
    db.prepare('INSERT INTO ratings (id, exchange_type, exchange_id, rater_id, ratee_id, stars, tags, comment) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, exchange_type, exchange_id, req.user.id, resolved.ratee_id, starsNum, cleanTags, cleanComment);
  } catch (e) {
    // UNIQUE(exchange_type, exchange_id, rater_id) is the real guard against duplicate ratings —
    // this just turns the constraint violation into a clean, expected error response.
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: "You've already rated this exchange" });
    throw e;
  }
  // Deliberately generic — never names the rater, matching the anonymous-reviewer rule already
  // enforced on the public profile. target_type 'user' + the ratee's own id opens their own
  // profile so they can see the new average, not the rater's.
  notify(resolved.ratee_id, 'rating_received', '⭐ You received a new rating after your completed exchange.', null, 'user', resolved.ratee_id);
  res.json({ ok: true, id });
});

// Lets the frontend know which completed exchanges the current user has already rated, so the
// "Rate this exchange" prompt doesn't reappear after submission. Returns bare "type:id" strings,
// nothing else about the rating itself.
app.get('/api/ratings/my-submitted', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT exchange_type, exchange_id FROM ratings WHERE rater_id = ?').all(req.user.id);
  res.json(rows.map(r => `${r.exchange_type}:${r.exchange_id}`));
});

// ---------- public user profile ----------
// Public, unauthenticated by design (same trust tier as browsing item listings). Every field
// returned here is deliberately either (a) already public elsewhere in the app, e.g. name/verified
// badge on listings, or (b) a live-computed aggregate. Never selects email, password_hash, exact
// pickup fields, or session data — and never returns a per-exchange activity log, only counts, so
// this can't be used to reconstruct who transacted with whom or when.
app.get('/api/users/:id/profile', profileLimiter, (req, res) => {
  const user = db.prepare('SELECT id, name, account_type, location, is_verified, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const claimContribs = db.prepare(`
    SELECT items.category AS category FROM claims JOIN items ON claims.item_id = items.id
    WHERE items.user_id = ? AND claims.status = 'completed'
  `).all(user.id);
  const offerContribs = db.prepare(`
    SELECT requests.category AS category FROM request_offers JOIN requests ON request_offers.request_id = requests.id
    WHERE request_offers.responder_id = ? AND request_offers.status = 'completed'
  `).all(user.id);
  const allContribs = [...claimContribs, ...offerContribs];
  const foodCount = allContribs.filter(r => FOOD_CATEGORIES.includes(r.category)).length;
  const reuseCount = allContribs.length - foodCount;

  const ratingAgg = db.prepare('SELECT COUNT(*) AS n, AVG(stars) AS avg FROM ratings WHERE ratee_id = ?').get(user.id);
  // Deliberately drops created_at and rater identity — reviews show stars/tags/comment only, per
  // the "anonymous reviewer, no per-contribution timestamps" V1 rule.
  const recentReviews = db.prepare('SELECT id, stars, tags, comment FROM ratings WHERE ratee_id = ? ORDER BY created_at DESC LIMIT 5').all(user.id)
    .map(r => ({ id: r.id, stars: r.stars, tags: r.tags ? r.tags.split(',').filter(Boolean) : [], comment: r.comment || '' }));

  // Reuses the exact same live monthly calculation the homepage Champions section and mini-badges
  // already use — no separate/duplicated badge logic for the profile.
  const monthly = computeMonthlyBadges();
  const badges = [];
  if (monthly.food_giver && monthly.food_giver.user_id === user.id) badges.push('food_giver');
  if (monthly.reuse_donor && monthly.reuse_donor.user_id === user.id) badges.push('reuse_donor');
  if (monthly.community_champion && monthly.community_champion.user_id === user.id) badges.push('community_champion');

  const memberSince = user.created_at
    ? new Date(user.created_at.replace(' ', 'T')).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : null;

  res.json({
    id: user.id,
    name: user.name,
    account_type: user.account_type,
    location: user.location || '',
    is_verified: !!user.is_verified,
    member_since: memberSince,
    avg_rating: ratingAgg.avg ? Math.round(ratingAgg.avg * 10) / 10 : null,
    rating_count: ratingAgg.n,
    reuse_count: reuseCount,
    food_count: foodCount,
    total_count: allContribs.length,
    badges,
    badge_month: monthly.month,
    recent_reviews: recentReviews
  });
});

// ---------- notifications ----------
app.get('/api/notifications', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json(rows);
});

app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
  res.json({ count: row.n });
});

app.post('/api/notifications/mark-all-read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Per-notification read state — lets the panel mark just the clicked row as read instead of
// wiping the whole unread count the instant the panel opens. Ownership-checked like every other
// per-row route in this file; a WHERE on user_id also means this can't be used to probe whether
// some other user's notification id exists.
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  const result = db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ---------- reports ----------
const REPORT_TARGET_TYPES = ['item', 'user', 'request', 'rating'];
// Fixed reason categories rather than free text only — lets Report actually mean something
// specific (and someday be triaged/prioritized by category) instead of an unstructured guess.
// 'other' is the catch-all; 'reason' stays as optional additional detail on every category.
const REPORT_CATEGORIES = ['scam_fraud', 'harassment', 'suspicious_request', 'inappropriate_content', 'fake_profile', 'asking_for_money', 'unsafe_behavior', 'other'];
app.post('/api/reports', requireAuth, reportLimiter, (req, res) => {
  const { target_type, target_id, category, reason } = req.body;
  if (!target_type || !target_id || !category) return res.status(400).json({ error: 'Missing fields' });
  if (!REPORT_TARGET_TYPES.includes(target_type)) return res.status(400).json({ error: 'Invalid target_type' });
  if (!REPORT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  db.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, category, reason) VALUES (?,?,?,?,?,?)')
    .run(nanoid(), req.user.id, target_type, target_id, category, String(reason || '').slice(0, 500));
  res.json({ ok: true });
});

// ---------- requests (reverse marketplace: post what you NEED) ----------
app.get('/api/requests', (req, res) => {
  expireStaleListings();
  const { request_type, category, q, mine, urgent, location, sort } = req.query;
  // Same "mine" exception as /api/items above: owners of a "mine" query see their own closed
  // requests too; the public browse path (no mine=) keeps excluding closed exactly as before.
  let sql = `SELECT requests.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
             FROM requests JOIN users ON requests.user_id = users.id WHERE 1=1`;
  const params = [];
  if (!mine) { sql += " AND requests.status != 'closed'"; }
  if (!mine) { sql += " AND requests.request_type = ?"; params.push(request_type === 'service' ? 'service' : 'thing'); }
  if (category) {
    const catValues = categoryFilterValues(category);
    sql += ` AND requests.category IN (${catValues.map(() => '?').join(',')})`;
    params.push(...catValues);
  }
  if (urgent) { sql += ' AND requests.is_urgent = 1'; }
  if (location) { sql += ' AND users.location LIKE ?'; params.push(`%${location}%`); }
  if (q) { sql += ' AND (requests.title LIKE ? OR requests.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (mine) { sql += ' AND requests.user_id = ?'; params.push(mine); }
  // Default (no/unknown sort param) preserves the exact pre-existing order — urgent-first — so
  // this stays additive; only an explicit sort=newest/price_low opts into a different order.
  sql += ' ORDER BY ' + (REQUEST_SORTS[sort] || REQUEST_SORTS.urgent);
  res.json(db.prepare(sql).all(...params));
});

// Homepage priority section #1: urgent requests across both thing/service types.
app.get('/api/requests/urgent', (req, res) => {
  expireStaleListings();
  const rows = db.prepare(`SELECT requests.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
                            FROM requests JOIN users ON requests.user_id = users.id
                            WHERE requests.status = 'open' AND requests.is_urgent = 1
                            ORDER BY requests.created_at DESC
                            LIMIT 8`).all();
  res.json(rows);
});

app.get('/api/requests/:id', optionalAuth, (req, res) => {
  const request = db.prepare(`SELECT requests.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.email AS owner_email, users.is_verified AS owner_verified
                               FROM requests JOIN users ON requests.user_id = users.id WHERE requests.id = ?`).get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  // owner_email must only ever reach the requester themselves — anyone browsing/considering
  // offering help sees name/location/verified status only, never the requester's email. Contact
  // only ever happens through an accepted request_offer (see /api/my/request-offers-received),
  // never by reading it straight off the request.
  const isOwner = req.user && req.user.id === request.user_id;
  res.json(isOwner ? request : stripExactPickup(request));
});

app.post('/api/requests', requireAuth, (req, res) => {
  const { title, description, request_type, category, budget_type, budget_amount, exchange_for, quantity, is_urgent } = req.body;
  if (!title || !description || !category) return res.status(400).json({ error: 'Missing required fields' });
  const id = nanoid();
  db.prepare(`INSERT INTO requests (id, user_id, title, description, request_type, category, budget_type, budget_amount, exchange_for, quantity, is_urgent, expires_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now', '+${LISTING_LIFETIME_DAYS} days'))`)
    .run(id, req.user.id, title, description,
      request_type === 'service' ? 'service' : 'thing',
      category, budget_type || 'free',
      budget_type === 'paid' ? (parseFloat(budget_amount) || 0) : 0,
      budget_type === 'exchange' ? (exchange_for || '') : '',
      quantity || '',
      is_urgent === 'true' || is_urgent === '1' || is_urgent === true ? 1 : 0);
  res.json(db.prepare('SELECT * FROM requests WHERE id = ?').get(id));
});

app.patch('/api/requests/:id', requireAuth, (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (request.user_id !== req.user.id) return res.status(403).json({ error: 'Not your request' });
  const { status, title, description, category, budget_type, budget_amount, exchange_for, quantity, is_urgent } = req.body;
  if (status) db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, req.params.id);
  if (title !== undefined) {
    const newBudgetType = budget_type || request.budget_type;
    db.prepare(`UPDATE requests SET title=?, description=?, category=?, budget_type=?, budget_amount=?, exchange_for=?, quantity=?, is_urgent=? WHERE id=?`)
      .run(title, description || request.description, category || request.category, newBudgetType,
        newBudgetType === 'paid' ? (parseFloat(budget_amount) || 0) : 0,
        newBudgetType === 'exchange' ? (exchange_for || '') : '',
        quantity || '',
        is_urgent === 'true' || is_urgent === '1' || is_urgent === true ? 1 : 0,
        req.params.id);
  }
  res.json(db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id));
});

app.post('/api/requests/:id/respond', requireAuth, (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (request.user_id === req.user.id) return res.status(400).json({ error: "Can't respond to your own request" });
  const id = nanoid();
  const { pickup_type, pickup_area, pickup_address, pickup_instructions } = req.body;
  db.prepare('INSERT INTO request_offers (id, request_id, responder_id, message, offered_price, pickup_type, pickup_area, pickup_address, pickup_instructions) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, request.id, req.user.id, req.body.message || '', parseFloat(req.body.offered_price) || 0,
      sanitizePickupType(pickup_type), pickup_area || '', pickup_address || '', pickup_instructions || '');
  db.prepare('UPDATE requests SET offer_count = offer_count + 1 WHERE id = ?').run(request.id);
  notify(request.user_id, 'new_offer', `${req.user.name} can help with "${request.title}"`, null, 'offer', id);
  res.json({ ok: true, id });
});

app.get('/api/my/request-offers-received', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT request_offers.*, requests.title AS request_title, users.name AS responder_name, users.email AS responder_email, users.is_verified AS responder_verified
                            FROM request_offers JOIN requests ON request_offers.request_id = requests.id JOIN users ON request_offers.responder_id = users.id
                            WHERE requests.user_id = ? ORDER BY request_offers.created_at DESC`).all(req.user.id);
  // Exact pickup location for an offer is only shown to the request owner once that offer is
  // accepted — same rule as items (approximate only while still deciding between offers).
  res.json(rows.map(r => (r.status === 'accepted' || r.status === 'completed') ? r : stripExactPickup(r)));
});

app.get('/api/my/request-offers-sent', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT request_offers.*, requests.title AS request_title, requests.status AS request_status
                            FROM request_offers JOIN requests ON request_offers.request_id = requests.id
                            WHERE request_offers.responder_id = ? ORDER BY request_offers.created_at DESC`).all(req.user.id);
  res.json(rows);
});

// Same authoritative-state-transition rule as CLAIM_TRANSITIONS above.
const OFFER_TRANSITIONS = { pending: ['accepted', 'declined'] };

app.patch('/api/request-offers/:id', requireAuth, (req, res) => {
  const offer = db.prepare('SELECT * FROM request_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(offer.request_id);
  if (request.user_id !== req.user.id) return res.status(403).json({ error: 'Not your request' });
  const { status } = req.body;
  const allowed = OFFER_TRANSITIONS[offer.status] || [];
  if (!allowed.includes(status)) {
    return res.status(409).json({ error: `This offer is already ${offer.status} and can't be changed to ${status}` });
  }
  db.prepare('UPDATE request_offers SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'accepted') db.prepare('UPDATE requests SET status = ? WHERE id = ?').run('fulfilled', request.id);
  notify(offer.responder_id, status === 'accepted' ? 'offer_accepted' : 'offer_declined',
    `Your offer to help with "${request.title}" was ${status}`, null, 'offer', offer.id);
  res.json({ ok: true });
});

// Two-sided completion confirmation for request fulfillment. Giver = the offer's responder
// (the one providing the item/service); Receiver = the request's poster. Badge credit for
// request-based contributions goes to the giver (responder), matching the item-claim flow.
app.post('/api/request-offers/:id/confirm', requireAuth, (req, res) => {
  const offer = db.prepare('SELECT * FROM request_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(offer.request_id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  const isGiver = offer.responder_id === req.user.id;
  const isReceiver = request.user_id === req.user.id;
  if (!isGiver && !isReceiver) return res.status(403).json({ error: 'Not part of this exchange' });
  if (offer.status !== 'accepted') return res.status(400).json({ error: 'This offer has not been accepted yet' });

  const { confirmed, reason } = req.body;
  if (confirmed === false) {
    const finalReason = NOT_COMPLETED_REASONS.includes(reason) ? reason : 'Other';
    db.prepare("UPDATE request_offers SET status = 'not_completed', not_completed_reason = ? WHERE id = ?").run(finalReason, offer.id);
    db.prepare("UPDATE requests SET status = 'open' WHERE id = ?").run(request.id);
    notify(isGiver ? request.user_id : offer.responder_id, 'exchange_not_completed', `"${request.title}" was marked as not completed`, null, 'offer', offer.id);
    return res.json({ ok: true, status: 'not_completed' });
  }

  const field = isGiver ? 'giver_confirmed' : 'receiver_confirmed';
  db.prepare(`UPDATE request_offers SET ${field} = 1 WHERE id = ?`).run(offer.id);
  const updated = db.prepare('SELECT * FROM request_offers WHERE id = ?').get(offer.id);
  let status = 'pending_confirmation';
  if (updated.giver_confirmed && updated.receiver_confirmed) {
    db.prepare("UPDATE request_offers SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(offer.id);
    status = 'completed';
    notify(isGiver ? request.user_id : offer.responder_id, 'exchange_completed', `"${request.title}" exchange is complete`, null, 'offer', offer.id);
  } else {
    notify(isGiver ? request.user_id : offer.responder_id, 'exchange_confirmed', `Waiting for you to confirm "${request.title}"`, null, 'offer', offer.id);
  }
  res.json({ ok: true, status, giver_confirmed: !!updated.giver_confirmed, receiver_confirmed: !!updated.receiver_confirmed });
});

app.get('/api/request-offers/:id', requireAuth, (req, res) => {
  const offer = db.prepare('SELECT * FROM request_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Not found' });
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(offer.request_id);
  const isGiver = offer.responder_id === req.user.id;
  const isReceiver = request.user_id === req.user.id;
  if (!isGiver && !isReceiver) return res.status(403).json({ error: 'Not part of this exchange' });
  res.json({ offer: offer.status === 'accepted' || offer.status === 'completed' ? offer : stripExactPickup(offer), request, role: isGiver ? 'giver' : 'receiver' });
});

// ---------- impact metrics (KPIs from the founder bible) ----------
app.get('/api/impact', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const activeToday = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_active_at >= datetime('now', '-1 day')`).get().n;
  // Counts here must reflect real, two-sided-confirmed completions only — matching the same
  // 'completed' status used by computeMonthlyBadges() below. Counting 'accepted'/'claimed' would
  // credit an exchange the moment the giver accepts a request, before either side has confirmed
  // the handover actually happened — that's exactly the "fake impact number" the badges logic
  // was already built to avoid, so /api/impact must use the same bar.
  const completedItemClaims = db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE status = 'completed'`).get().n;
  const completedRequestOffers = db.prepare(`SELECT COUNT(*) AS n FROM request_offers WHERE status = 'completed'`).get().n;
  const reusedItems = db.prepare(`SELECT COUNT(DISTINCT item_id) AS n FROM claims WHERE status = 'completed'`).get().n;
  const wasteDivertedListings = db.prepare(`
    SELECT COUNT(DISTINCT claims.item_id) AS n FROM claims JOIN items ON claims.item_id = items.id
    WHERE items.listing_type = 'business_waste' AND claims.status = 'completed'
  `).get().n;
  const repeatUsers = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT user_id FROM (
        SELECT user_id FROM items UNION ALL SELECT user_id FROM requests
      ) GROUP BY user_id HAVING COUNT(*) > 1
    )`).get().n;
  const avgResponseHours = db.prepare(`
    SELECT AVG((julianday(claims.created_at) - julianday(items.created_at)) * 24) AS h
    FROM claims JOIN items ON claims.item_id = items.id
  `).get().h;
  const verifiedUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_verified = 1').get().n;

  res.json({
    total_users: totalUsers,
    active_today: activeToday,
    verified_users: verifiedUsers,
    completed_requests: completedItemClaims + completedRequestOffers,
    reused_items: reusedItems,
    waste_diverted_listings: wasteDivertedListings,
    avg_response_hours: avgResponseHours ? Math.round(avgResponseHours * 10) / 10 : null,
    repeat_users: repeatUsers
  });
});

// ---------- monthly contribution badges ----------
// No points/XP/levels — real completed exchanges only, calculated live from completed_at every
// time this is called (never a manually-reset counter, so it can't drift or get stuck).
function computeMonthlyBadges() {
  const now = db.prepare("SELECT datetime('now','start of month') AS start, datetime('now','start of month','+1 month') AS end, strftime('%Y-%m', 'now') AS ym").get();

  const claimRows = db.prepare(`
    SELECT items.user_id AS giver_id, items.category AS category
    FROM claims JOIN items ON claims.item_id = items.id
    WHERE claims.status = 'completed' AND claims.completed_at >= ? AND claims.completed_at < ?
  `).all(now.start, now.end);

  const offerRows = db.prepare(`
    SELECT request_offers.responder_id AS giver_id, requests.category AS category
    FROM request_offers JOIN requests ON request_offers.request_id = requests.id
    WHERE request_offers.status = 'completed' AND request_offers.completed_at >= ? AND request_offers.completed_at < ?
  `).all(now.start, now.end);

  const foodCounts = {}, reuseCounts = {}, totalCounts = {};
  const bump = (map, id) => { map[id] = (map[id] || 0) + 1; };
  [...claimRows, ...offerRows].forEach(r => {
    bump(totalCounts, r.giver_id);
    if (FOOD_CATEGORIES.includes(r.category)) bump(foodCounts, r.giver_id);
    else bump(reuseCounts, r.giver_id);
  });

  const topOf = (counts) => {
    let bestId = null, bestN = 0;
    for (const [id, n] of Object.entries(counts)) { if (n > bestN) { bestId = id; bestN = n; } }
    if (!bestId) return null;
    const user = db.prepare('SELECT id, name, account_type FROM users WHERE id = ?').get(bestId);
    if (!user) return null;
    return { user_id: user.id, name: user.name, account_type: user.account_type, count: bestN };
  };

  const monthLabel = new Date(now.start.replace(' ', 'T')).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Top 10 overall contributors this month, for the "View all contributors" list. Same live,
  // no-manual-counter calculation as the three headline badges above.
  const leaderboard = Object.entries(totalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => {
      const user = db.prepare('SELECT id, name, account_type FROM users WHERE id = ?').get(id);
      return user ? { user_id: user.id, name: user.name, account_type: user.account_type, count } : null;
    })
    .filter(Boolean);

  return { month: monthLabel, month_key: now.ym, food_giver: topOf(foodCounts), reuse_donor: topOf(reuseCounts), community_champion: topOf(totalCounts), leaderboard };
}

app.get('/api/badges/monthly', (req, res) => {
  res.json(computeMonthlyBadges());
});

// ---------- admin (Trust & Safety / Moderation V1) ----------
// All routes here are requireAuth + requireAdmin, and stay entirely separate from the existing
// owner-only PATCH /api/items/:id and PATCH /api/requests/:id routes — this file never weakens
// those ownership checks; admin actions go through their own dedicated endpoints instead.

// Resolves a report's target into a short human-readable label for the admin dashboard. Reports
// can reference four different tables depending on target_type, so this is a small dispatcher
// rather than one complex join — report volume is tiny at this project's scale, so simplicity
// wins over a clever single query.
function resolveReportTarget(targetType, targetId) {
  if (targetType === 'item') {
    const item = db.prepare('SELECT id, title, status, user_id FROM items WHERE id = ?').get(targetId);
    return item ? { label: item.title, status: item.status, owner_id: item.user_id } : { label: '(deleted item)', status: '', owner_id: null };
  }
  if (targetType === 'request') {
    const r = db.prepare('SELECT id, title, status, user_id FROM requests WHERE id = ?').get(targetId);
    return r ? { label: r.title, status: r.status, owner_id: r.user_id } : { label: '(deleted request)', status: '', owner_id: null };
  }
  if (targetType === 'user') {
    const u = db.prepare('SELECT id, name, email, is_banned FROM users WHERE id = ?').get(targetId);
    return u ? { label: `${u.name} (${u.email})`, status: u.is_banned ? 'banned' : '', owner_id: u.id } : { label: '(deleted user)', status: '', owner_id: null };
  }
  if (targetType === 'rating') {
    const rt = db.prepare('SELECT id, stars, comment, ratee_id FROM ratings WHERE id = ?').get(targetId);
    return rt ? { label: `${rt.stars}★ "${rt.comment}"`, status: '', owner_id: rt.ratee_id } : { label: '(deleted rating)', status: '', owner_id: null };
  }
  return { label: '(unknown)', status: '', owner_id: null };
}

app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.query;
  let sql = `SELECT reports.*, users.name AS reporter_name, users.email AS reporter_email
             FROM reports JOIN users ON reports.reporter_id = users.id`;
  const params = [];
  if (['open', 'resolved', 'dismissed'].includes(status)) {
    sql += ' WHERE reports.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY reports.created_at DESC LIMIT 100';
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, target: resolveReportTarget(r.target_type, r.target_id) }));
  res.json(rows);
});

const REPORT_RESOLUTIONS = ['resolved', 'dismissed'];
app.patch('/api/admin/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const { status, note } = req.body;
  if (!REPORT_RESOLUTIONS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const cleanNote = String(note || '').slice(0, 500);
  db.prepare("UPDATE reports SET status = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?")
    .run(status, req.user.id, cleanNote, report.id);
  logModeration(req.user.id, status === 'resolved' ? 'resolve_report' : 'dismiss_report', 'report', report.id, cleanNote);
  res.json({ ok: true });
});

// Admin-initiated close — separate route from the owner-only PATCH /api/items/:id, which still
// rejects any non-owner exactly as before. Works regardless of who posted the listing.
app.patch('/api/admin/items/:id/close', requireAuth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE items SET status = 'closed' WHERE id = ?").run(item.id);
  logModeration(req.user.id, 'close_item', 'item', item.id, req.body.note || '');
  res.json({ ok: true });
});

app.patch('/api/admin/requests/:id/close', requireAuth, requireAdmin, (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE requests SET status = 'closed' WHERE id = ?").run(request.id);
  logModeration(req.user.id, 'close_request', 'request', request.id, req.body.note || '');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't ban yourself" });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const reason = String(req.body.reason || '').slice(0, 300);
  db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?').run(reason, req.params.id);
  // Immediate revocation — the requireAuth ban-check above is the defense-in-depth backstop, this
  // is the primary mechanism that actually kicks an already-logged-in user out right away.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  logModeration(req.user.id, 'ban_user', 'user', req.params.id, reason);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE users SET is_banned = 0, ban_reason = '' WHERE id = ?").run(req.params.id);
  logModeration(req.user.id, 'unban_user', 'user', req.params.id, '');
  res.json({ ok: true });
});

// ---------- Image Moderation V1: admin review queue ----------
app.get('/api/admin/images/pending', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT item_media.id, item_media.item_id, item_media.url, item_media.moderation_note, item_media.created_at,
                                   items.title AS item_title, items.user_id AS owner_id, users.name AS owner_name
                            FROM item_media
                            JOIN items ON item_media.item_id = items.id
                            JOIN users ON items.user_id = users.id
                            WHERE item_media.status = 'pending_review'
                            ORDER BY item_media.created_at ASC LIMIT 100`).all();
  res.json(rows);
});

// Serves the actual quarantined image bytes — admin-only, never reachable by a public URL (the
// file itself lives outside express.static's public uploads directory).
app.get('/api/admin/images/:id/file', requireAuth, requireAdmin, (req, res) => {
  const media = db.prepare("SELECT * FROM item_media WHERE id = ? AND status = 'pending_review'").get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(quarantineDir, path.basename(media.url));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(filePath);
});

app.post('/api/admin/images/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const media = db.prepare("SELECT * FROM item_media WHERE id = ? AND status = 'pending_review'").get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  const quarantinePath = path.join(quarantineDir, path.basename(media.url));
  try { if (fs.existsSync(quarantinePath)) fs.renameSync(quarantinePath, path.join(uploadDir, path.basename(media.url))); } catch {}
  db.prepare("UPDATE item_media SET status = 'approved', moderated_at = datetime('now'), moderated_by = ? WHERE id = ?").run(req.user.id, media.id);
  // If the item didn't have a cover photo yet (its first image was the one pending), give it one now.
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(media.item_id);
  if (item && !item.media_url) {
    db.prepare("UPDATE items SET media_url = ?, media_type = 'image' WHERE id = ?").run(media.url, item.id);
  }
  logModeration(req.user.id, 'approve_image', 'item', media.item_id, 'Approved image ' + media.id);
  res.json({ ok: true });
});

app.post('/api/admin/images/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const media = db.prepare("SELECT * FROM item_media WHERE id = ? AND status = 'pending_review'").get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  const quarantinePath = path.join(quarantineDir, path.basename(media.url));
  try { if (fs.existsSync(quarantinePath)) fs.unlinkSync(quarantinePath); } catch {}
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(media.item_id);
  const note = String(req.body.note || '').slice(0, 300);
  db.prepare('DELETE FROM item_media WHERE id = ?').run(media.id);
  if (item) notify(item.user_id, 'image_rejected', `A photo on your listing "${item.title}" didn't pass review and was removed.${note ? ' Reason: ' + note : ''}`, item.id, 'item', item.id);
  logModeration(req.user.id, 'reject_image', 'item', media.item_id, note || 'Rejected image ' + media.id);
  res.json({ ok: true });
});

app.get('/api/admin/moderation-log', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT moderation_actions.*, users.name AS admin_name
                            FROM moderation_actions JOIN users ON moderation_actions.admin_id = users.id
                            ORDER BY moderation_actions.created_at DESC LIMIT 100`).all();
  res.json(rows);
});

// ---------- 404 + error handling ----------
// Unmatched /api/* routes get a clean JSON 404 instead of falling through to Express's default
// HTML "Cannot GET /whatever" page (which is harmless info-wise but inconsistent with every other
// API response shape).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler — must be defined with 4 args (err, req, res, next) for Express to
// recognize it as an error handler rather than regular middleware. Catches: Multer errors
// (oversized file, too many files, unexpected field, rejected type from fileFilter), malformed
// JSON bodies, oversized request bodies, and anything else thrown/rejected in a route.
// Production responses never include err.message, err.stack, SQL text, or file paths — only a
// generic message. Full detail always goes to the server log (never to the client) so the issue
// is still debuggable from the server side.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `File too large (max ${Math.round(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)}MB per file)`,
      LIMIT_FILE_COUNT: `Too many files (max ${MAX_UPLOAD_FILES})`,
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field'
    };
    return res.status(400).json({ error: messages[err.code] || 'Upload error' });
  }
  if (err.message === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({ error: 'Only JPEG, PNG, or WebP images are allowed' });
  }
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed request body' });
  }
  // Busboy (used internally by multer) throws plain Errors — not MulterError — for a structurally
  // broken multipart body (truncated stream, missing/garbled boundary, etc). That's a client
  // mistake, not a server failure, so it should be a 400, not the fallback 500.
  const BUSBOY_PARSE_ERRORS = ['Unexpected end of form', 'Multipart: Boundary not found', 'Malformed part header'];
  if (typeof err.message === 'string' && BUSBOY_PARSE_ERRORS.some(m => err.message.includes(m))) {
    return res.status(400).json({ error: 'Malformed upload request' });
  }

  // Fallback: anything unexpected. Never leak err.message/stack in production.
  res.status(err.status && Number.isInteger(err.status) ? err.status : 500).json({
    error: IS_PROD ? 'Something went wrong' : (err.message || 'Something went wrong')
  });
});

app.listen(PORT, () => console.log(`Reuse Hub running at http://localhost:${PORT}`));
