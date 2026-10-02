// Must run before anything below reads process.env.* — without this, a production .env file
// (TRUST_PROXY, EMAIL_USER/PASS, MODERATION_PROVIDER, SIGHTENGINE_*, etc.) is silently never
// loaded, since Node itself has no built-in .env support. Safe to require even where no .env file
// exists (e.g. a dev shell that already exports real env vars): it just finds nothing to load.
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { nanoid } = require('nanoid');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
// Image pipeline quality pass: real re-encode/resize/thumbnail generation, run only on the true
// uploaded bytes AFTER moderation has already evaluated them (see processApprovedImage() below) —
// this does not change what moderation sees or how magic-byte validation works, both of which still
// run on the original file untouched. sharp is optional at runtime: if it's not installed yet (e.g.
// `npm install` hasn't been re-run after this change) or a given image fails to process for any
// reason, publishing falls back to the old plain-rename behavior rather than breaking uploads.
let sharp = null;
try { sharp = require('sharp'); } catch { /* falls back to unprocessed publish below */ }
// Web Push: optional at runtime the same way sharp/sightengine are — if VAPID keys aren't set
// (see VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY below), pushToUser() below just no-ops and the rest of
// the app behaves exactly as it did before this feature existed.
let webpush = null;
try { webpush = require('web-push'); } catch { /* push disabled until installed */ }
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const db = require('./db');
// LOCATION FOUNDATION V1: see geocoding.js for the provider abstraction itself.
const { geocodeText, reverseGeocode, searchPlaces, isGeocodingConfigured, isValidLat, isValidLng, fuzzCoordinate } = require('./geocoding');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Only trust X-Forwarded-For when we know we're actually behind a reverse proxy (set
// TRUST_PROXY=1 in that environment's config). Blindly trusting it otherwise lets a client
// spoof its own IP and dodge rate limiting entirely.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 days, matches previous cookie behavior
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------- transactional email ----------
// EMAIL PROVIDER CHANGE: switched from Gmail SMTP to Resend's HTTPS API. Confirmed live on this
// Droplet that outbound SMTP (both port 465 and 587 to smtp.gmail.com) is network-blocked —
// `cat < /dev/tcp/smtp.gmail.com/587` just hangs/times out, which is what was producing
// "[email] failed to send verification code email: Connection timeout" in prod no matter which
// Gmail port was used. That's a network-level block, not fixable from inside the app. Resend sends
// over a normal HTTPS POST (port 443, same as any other API call this server already makes to
// Sightengine) — nothing blocks that. RESEND_FROM defaults to Resend's own shared test address,
// which works immediately with zero DNS setup; switch to a "you@zineedo.in" address later by
// verifying the zineedo.in domain in the Resend dashboard and setting RESEND_FROM.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Zineedo <onboarding@resend.dev>';
const SITE_URL = process.env.SITE_URL || 'https://zineedo.in';
const EMAIL_ENABLED = !!RESEND_API_KEY;

if (!EMAIL_ENABLED && IS_PROD) {
  // Not fatal — the server still runs and /api/forgot-password still responds with the generic
  // message — but this is loud on purpose: silently-broken password resets in production are easy
  // to miss until a real user reports they never got an email.
  console.warn('[email] RESEND_API_KEY not configured — verification/password reset emails will NOT be sent.');
}

// Shared sender used by both email types below. Fire-and-forget by design (never awaited on a
// request path) — a slow or failing send must never delay or change an API response.
async function sendTransactionalEmail(toEmail, subject, text, html) {
  if (!EMAIL_ENABLED) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: toEmail, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Resend API error:', res.status, body);
    }
  } catch (err) {
    console.error('[email] failed to send via Resend:', err.message);
  }
}

// Used by /api/verify/request below. Unlike sendPasswordResetEmail, there's no "don't leak account
// existence" constraint here — the caller is already logged in as the account being verified
// (requireAuth), so there's nothing to hide by awaiting or not.
function sendVerificationCodeEmail(toEmail, code) {
  sendTransactionalEmail(
    toEmail,
    'Your Zineedo verification code',
    `Your Zineedo verification code is: ${code}\n\nEnter this in the app to verify your account. If you didn't request this, you can ignore this email.`,
    `<p>Your Zineedo verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>Enter this in the app to verify your account. If you didn't request this, you can ignore this email.</p>`
  );
}

// Callers don't await this on the request path, so a slow or failing send never delays or breaks
// the /api/forgot-password response (which must look identical whether or not the account/email
// exists, per GENERIC_RESET_MESSAGE below).
function sendPasswordResetEmail(toEmail, rawToken) {
  // Matches the frontend's checkResetTokenInUrl() in public/app.js, which looks for ?reset=TOKEN
  // on the root page (not a separate reset-password.html — no such file exists in public/).
  const resetLink = `${SITE_URL}/?reset=${encodeURIComponent(rawToken)}`;
  sendTransactionalEmail(
    toEmail,
    'Reset your Zineedo password',
    `We received a request to reset your Zineedo password. This link expires in 30 minutes:\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email.`,
    `<p>We received a request to reset your Zineedo password. This link expires in 30 minutes:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`
  );
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PROD,       // only sent over HTTPS in production; localhost dev stays usable over HTTP
    sameSite: 'lax',       // same-origin website; native mobile clients aren't affected by this browser-only policy
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  };
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// PHASE 9A: bearer-token support for a future mobile client, layered onto the exact same
// `sessions` table and hashing scheme used by web cookies -- no second sessions table, no
// separate mobile-user concept, no duplicated auth logic. A request is authenticated via
// EITHER the existing `token` cookie OR an `Authorization: Bearer <token>` header; cookie
// wins if both are somehow present. The bearer token is never accepted from a query string
// or request body -- only this one header -- so it can never leak into access logs, browser
// history, or a referrer.
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  const token = match[1].trim();
  return token ? token : null;
}
function getAuthToken(req) {
  return req.cookies.token || extractBearerToken(req);
}

// PHASE 8 HARDENING: sessions.token now stores only a SHA-256 hash of the actual session token,
// exactly the same pattern already used for password_reset_tokens.token_hash below — this file
// already had the right idea for reset tokens but never applied it to sessions, which is the more
// valuable target (a live session token IS an active login, not a one-time 30-minute-lived reset
// link). The raw token is still what's issued in the cookie and never stored anywhere; only its hash
// ever touches the database. This is defense-in-depth against a DB-read-level compromise (a leaked
// backup file, a misconfigured admin export, a future SQL-injection-class bug elsewhere) — nanoid(32)
// tokens are already unguessable, so the actual login flow is unaffected either way.
function createSession(userId) {
  const token = nanoid(32);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime('now', '+30 days'))").run(hashToken(token), userId);
  return token;
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
// PHASE 8 HARDENING: DISABLE_RATE_LIMIT=1 is an explicit, opt-in-only escape hatch used solely by
// this project's own automated test suites, several of which legitimately need to perform far more
// requests in a few seconds than any real single user would in the limiter's window (e.g.
// pagination_test.js alone creates 100+ items in one run purely to have enough fixture data to
// paginate over) — a real abusive actor doing that IS exactly what these limiters exist to catch,
// but a test harness generating fixtures is not that actor. This must never be set in a real
// deployment; nothing in this file sets it automatically, and IS_PROD/NODE_ENV are deliberately NOT
// used for this (an accidental NODE_ENV=test in a real environment must not silently disable every
// rate limit — a separate, single-purpose, unambiguously-named flag is safer to reason about).
const skipRateLimitInTest = () => process.env.DISABLE_RATE_LIMIT === '1';
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const ratingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
// "Light" per the profile design — this is a public, unauthenticated endpoint, so the limit exists
// only to blunt bulk scraping, not to gate normal browsing.
const profileLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const blockLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const accountUpdateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
const changePasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
// LOCATION PICKER (Phase 2): both endpoints below are unauthenticated-accessible (no user-specific
// data, no side effects — pure provider passthrough), so this limiter is the only thing standing
// between the app and someone hammering the geocoding provider's quota through it. 30/15min is generous enough
// for normal typing-driven search (the frontend also debounces) while blunting scripted abuse.
const locationSearchLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });
// PHASE 8 HARDENING: POST /api/items and POST /api/requests had no rate limiter at all — flagged
// as a known gap back in the Phase 3 upload-security audit but deliberately left unfixed at the
// time pending an actual hardening pass (the concern then was "what's a legitimate posting rate?",
// a product question). This isn't trying to answer that question now either — 30/hour is a
// generous ceiling well above any plausible legitimate single-user posting rate (a real person
// photographing and describing 30 separate listings in an hour is not realistic), so it only ever
// blocks scripted/automated flooding, not a real user's normal usage. Item creation is also the
// single most resource-intensive route in the app (multipart parsing, disk writes, optional
// metered moderation API call), making it the highest-value target to protect first.
const createListingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler, skip: skipRateLimitInTest });

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
// later if Zineedo needs to also defend against maliciously crafted-but-valid image files
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
  const media = db.prepare("SELECT id, url, thumb_url, media_type FROM item_media WHERE item_id = ? AND status = 'approved' ORDER BY position ASC").all(item.id);
  item.media = media;
  const pending = db.prepare("SELECT COUNT(*) AS c FROM item_media WHERE item_id = ? AND status = 'pending_review'").get(item.id);
  item.pending_media_count = pending.c;
  return stripInternalGeoFields(item);
}

// ---------- Location Foundation V1: privacy boundary for the new coordinate columns ----------
// LOCATION FOUNDATION: items.* and request_offers.* are SQL wildcards used throughout this file, so
// the pickup_lat/pickup_lng/pickup_public_lat/pickup_public_lng/pickup_geo_precision/
// pickup_geocoded_at/pickup_geocode_status columns added in db.js would otherwise flow straight
// into every single response that selects a row with `items.*` or `request_offers.*` — including
// ones that currently bypass stripExactPickup() entirely for an authorized owner/accepted-party
// (see /api/items/:id, /api/claims/:id, /api/request-offers/:id, /api/my/request-offers-received,
// /api/my/request-offers-sent). This phase deliberately does not expose ANY coordinate via ANY API
// response yet — not even to the owner — because no frontend/search feature consumes them yet, so
// there is no reason to create a new exposure surface before it's needed. Called unconditionally,
// regardless of ownership/acceptance status, wherever an items or request_offers row reaches a
// response (see call sites below and in attachMedia() above). This is enforcement, not just
// convention — every wildcard-selecting route in this file has been checked against this function.
const INTERNAL_GEO_FIELDS = [
  'pickup_lat', 'pickup_lng', 'pickup_public_lat', 'pickup_public_lng',
  'pickup_geo_precision', 'pickup_geocoded_at', 'pickup_geocode_status'
];
function stripInternalGeoFields(row) {
  if (!row) return row;
  for (const f of INTERNAL_GEO_FIELDS) delete row[f];
  return row;
}

// ---------- Location Foundation V1: background (fire-and-forget) geocoding ----------
// Neither of these is ever awaited by a route handler — geocoding must never add latency to or be
// able to fail a signup, a profile edit, a post, or an offer. geocodeText() itself never throws
// (see geocoding.js), and the .catch(() => {}) below is a final safety net around the DB write that
// follows it, so a call site can just invoke this and move on. If GEOAPIFY_KEY isn't set, this is a
// same-tick no-op (checked before the async hop) — the app works exactly as it does today.
function backgroundGeocodeUserLocation(userId, locationText) {
  if (!isGeocodingConfigured()) return;
  geocodeText(locationText).then(result => {
    db.prepare(`UPDATE users SET location_lat = ?, location_lng = ?, location_precision = ?, location_geocoded_at = datetime('now'), location_geocode_status = ? WHERE id = ?`)
      .run(result.status === 'ok' ? result.lat : null, result.status === 'ok' ? result.lng : null,
        result.status === 'ok' ? 'city' : null, result.status, userId);
  }).catch(() => {});
}

// `table` is always one of the two literal strings 'items' or 'request_offers' passed by the call
// sites below — never derived from request input — so interpolating it into the SQL text here is
// safe. Prefers the exact pickup_address (precision 'exact'); falls back to the coarser pickup_area
// only when no address was given (precision 'approximate'). The PUBLIC point is a fuzzed/rounded
// version of the private one when an exact address was geocoded; when only the already-coarse
// pickup_area was available, there's no more-precise source to fuzz away from, so public == private
// in that case. Neither point is exposed by any API response yet (see stripInternalGeoFields above)
// — this only computes and stores them for a future radius-search feature to consume.
function backgroundGeocodePickup(table, rowId, pickupAddress, pickupArea) {
  if (!isGeocodingConfigured()) return;
  const hasAddress = !!(pickupAddress && String(pickupAddress).trim());
  const source = hasAddress ? pickupAddress : pickupArea;
  if (!source || !String(source).trim()) {
    db.prepare(`UPDATE ${table} SET pickup_geocode_status = 'skipped' WHERE id = ?`).run(rowId);
    return;
  }
  geocodeText(source).then(result => {
    if (result.status !== 'ok') {
      db.prepare(`UPDATE ${table} SET pickup_geocode_status = ? WHERE id = ?`).run(result.status, rowId);
      return;
    }
    const precision = hasAddress ? 'exact' : 'approximate';
    const pub = hasAddress ? fuzzCoordinate(result.lat, result.lng, 2) : { lat: result.lat, lng: result.lng };
    db.prepare(`UPDATE ${table} SET pickup_lat = ?, pickup_lng = ?, pickup_public_lat = ?, pickup_public_lng = ?, pickup_geo_precision = ?, pickup_geocoded_at = datetime('now'), pickup_geocode_status = 'ok' WHERE id = ?`)
      .run(result.lat, result.lng, pub.lat, pub.lng, precision, rowId);
  }).catch(() => {});
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
// actually be served from. THUMB_MAX_WIDTH/HEIGHT match the 4:3 card crop already used everywhere
// in the UI (see .card .thumb in styles.css) so the thumbnail is never re-cropped client-side —
// just scaled. FULL_MAX_WIDTH caps only genuinely huge phone-camera originals (a typical modern
// phone photo is 3000-4000px wide); anything already smaller is left at its own size
// (withoutEnlargement), so a small/already-compressed source is never blown up or re-compressed
// into looking worse.
const THUMB_MAX_WIDTH = 640, THUMB_MAX_HEIGHT = 480; // 4:3, matches .card .thumb aspect-ratio
const FULL_MAX_WIDTH = 1920; // lightbox/detail-gallery size — plenty for any screen, not the raw original
async function processApprovedImage(quarantinePath, mimetype) {
  const base = path.basename(quarantinePath, path.extname(quarantinePath));
  const isPng = mimetype === 'image/png';
  const fullName = `${base}${isPng ? '.png' : '.jpg'}`;
  const thumbName = `${base}-thumb${isPng ? '.png' : '.jpg'}`;
  if (!sharp) {
    // No image-processing library available (not installed yet) — fall back to the original,
    // unprocessed behavior: publish the file exactly as uploaded, no thumbnail variant.
    fs.renameSync(quarantinePath, path.join(uploadDir, path.basename(quarantinePath)));
    return { url: '/uploads/' + path.basename(quarantinePath), thumbUrl: null };
  }
  try {
    const source = sharp(quarantinePath).rotate(); // .rotate() with no args = auto-orient from EXIF, then strip it
    const fullPipeline = source.clone().resize({ width: FULL_MAX_WIDTH, withoutEnlargement: true });
    const thumbPipeline = source.clone().resize({ width: THUMB_MAX_WIDTH, height: THUMB_MAX_HEIGHT, fit: 'cover', withoutEnlargement: true });
    if (isPng) {
      await fullPipeline.png({ compressionLevel: 8 }).toFile(path.join(uploadDir, fullName));
      await thumbPipeline.png({ compressionLevel: 8 }).toFile(path.join(uploadDir, thumbName));
    } else {
      // jpeg and webp originals both normalize to jpeg output — one predictable format for every
      // card/lightbox consumer, mozjpeg for meaningfully smaller files at the same visual quality.
      await fullPipeline.jpeg({ quality: 87, mozjpeg: true }).toFile(path.join(uploadDir, fullName));
      await thumbPipeline.jpeg({ quality: 78, mozjpeg: true }).toFile(path.join(uploadDir, thumbName));
    }
    try { fs.unlinkSync(quarantinePath); } catch {}
    return { url: '/uploads/' + fullName, thumbUrl: '/uploads/' + thumbName };
  } catch (err) {
    // Corrupt/unusual file sharp can't decode, disk error, etc. — never let a processing failure
    // block publishing. Fall back to the pre-processing behavior for this one file.
    try {
      fs.renameSync(quarantinePath, path.join(uploadDir, path.basename(quarantinePath)));
      return { url: '/uploads/' + path.basename(quarantinePath), thumbUrl: null };
    } catch {
      return { url: '/uploads/' + path.basename(quarantinePath), thumbUrl: null };
    }
  }
}

// ---------- Web Push V1 ----------
// VAPID identifies this server to push services (Chrome/Firefox's push endpoints) without any
// third-party account — generate once with `npx web-push generate-vapid-keys` and set both env
// vars. PUSH_ENABLED mirrors the EMAIL_ENABLED/MODERATION_PROVIDER pattern elsewhere in this file:
// unset in dev, every push call below silently no-ops and the rest of the app is unaffected.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const PUSH_ENABLED = !!(webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(`mailto:${process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',')[0].trim() : 'admin@zineedo.in'}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else if (IS_PROD) {
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not configured — browser push notifications will NOT be sent.');
}

// Fire-and-forget by design, same as the email senders above — a slow or failing push must never
// delay or break the request that triggered it (a claim, an accepted offer, etc.). Sends to every
// browser/device this user has subscribed from; a subscription the push service reports as
// gone (410) or not-found (404) is deleted here so it never costs a failed send again.
function pushToUser(userId, title, body, url) {
  if (!PUSH_ENABLED) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  const payload = JSON.stringify({ title, body, url: url || '/' });
  for (const sub of subs) {
    const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    webpush.sendNotification(pushSub, payload).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('[push] send failed:', err.statusCode, err.message);
      }
    });
  }
}

// targetType/targetId tell the frontend what a click on this notification should open
// ('item' | 'request' | 'claim' | 'offer' | 'user'). Both optional — a notification without a
// target just isn't clickable, which is fine and shouldn't block the notification from firing.
// Every call also fires a browser push (see pushToUser above) with the same message, so a user who
// isn't looking at the tab right now still finds out — the in-app bell and the push notification
// are two views of the exact same event, not two separate things to keep in sync by hand.
function notify(userId, type, message, itemId, targetType, targetId) {
  db.prepare('INSERT INTO notifications (id, user_id, type, message, item_id, target_type, target_id) VALUES (?,?,?,?,?,?,?)')
    .run(nanoid(), userId, type, message, itemId || null, targetType || null, targetId || null);
  pushToUser(userId, 'Zineedo', message, '/');
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

// PHASE 8 HARDENING: CSP was previously left off entirely (see the removed comment below, kept in
// spirit here) because app.js's dynamically-generated modal markup relies on inline `style="..."`
// attributes in ~16 places. Auditing every external resource this app actually loads (index.html,
// app.js, styles.css) rather than refactoring those call sites out: there are exactly two external
// <script src> tags (both this file's own /app.js and unpkg.com's lucide-icons bundle), no inline
// <script> blocks and no inline onXxx="" HTML attributes anywhere in index.html (app.js attaches
// all its handlers via .onclick = fn / addEventListener, which CSP's script-src does not restrict
// at all — only literal inline <script> tags and eval-family calls are), and exactly two external
// non-script origins in use: fonts.googleapis.com (the Inter stylesheet) and fonts.gstatic.com (the
// actual font files it references). The frontend never calls Geoapify directly — geocoding/search/
// reverse all proxy through this same server (see /api/location/*) — so no external connect-src
// entry is needed for that. Given all of this, script-src can safely be 'self' + unpkg.com with NO
// unsafe-inline and NO unsafe-eval; style-src needs 'unsafe-inline' for the inline style attributes
// (a real, deliberate exception, not an oversight — eliminating it means refactoring every
// dynamically-built modal to use classes instead, which is out of scope for a hardening pass per
// this phase's own instructions not to undertake a frontend rewrite for this). object-src/frame-
// ancestors are locked down since nothing in this app needs plugins or to be framed by another site.
// LIMITATION: this sandbox has no real browser, so this CSP has been verified by static analysis of
// every script/style/font/image reference in the shipped files (above), plus the existing DOM test
// suite (which loads the real app.js/index.html and drives real clicks) still passing unchanged —
// but jsdom does not actually enforce Content-Security-Policy response headers, so a real browser
// has not observed this CSP in effect. A manual check in an actual browser (open the app, confirm no
// CSP violation errors in devtools console while exercising modals/uploads/location picker) is
// recommended before launch.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false // would block the unpkg.com lucide-icons <script> otherwise
}));

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
// PHASE 8 HARDENING (reliability): express.json()/express.urlencoded() only populate req.body when
// the request's Content-Type header matches what they parse — a request sent with an unexpected or
// missing Content-Type (e.g. text/plain, or a client bug) leaves req.body as `undefined`, not `{}`.
// Every route handler in this file destructures fields straight off req.body (`const { title } =
// req.body`), which throws a raw TypeError ("Cannot destructure property ... of undefined") when
// req.body is undefined — an uncaught exception that fell through to the generic 500 fallback in the
// central error handler below instead of the clean 400 a malformed request should get. This single
// middleware closes that entire class of crash for every route at once, rather than defensively
// checking `req.body || {}` at each of the ~30 call sites individually.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
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
// All legacy category values ever merged into a canonical one, flattened — used below so an EDIT to
// an old item/request that still carries a retired category name (e.g. 'Toys & Kids') isn't rejected
// just because the current dropdown no longer offers that exact string.
const ALL_LEGACY_CATEGORY_VALUES = Object.values(LEGACY_CATEGORY_MERGE).flat();

// PHASE 8 HARDENING: category was previously accepted as any non-empty string with no enum check at
// all — a launch-readiness data-integrity gap explicitly called out for this phase. This is NOT the
// ambiguous case: the frontend's own post/edit forms are `<select>` dropdowns populated from exactly
// these three canonical lists (see public/app.js: item forms use state.categories/state.businessCategories
// depending on listing_type, request forms use state.categories/state.serviceCategories depending on
// request_type) — there is no UI path today that can legitimately produce a category outside these
// lists for a brand-new post. The only reason an out-of-list value can currently reach the database
// at all is a direct API call bypassing the UI, which is exactly the case server-side validation
// exists to close. Legacy values are still accepted (see ALL_LEGACY_CATEGORY_VALUES) so editing an
// old item/request that predates a category rename doesn't newly break.
function isValidItemCategory(category, listingType) {
  const canonical = listingType === 'business_waste' ? BUSINESS_CATEGORIES : CATEGORIES;
  return canonical.includes(category) || ALL_LEGACY_CATEGORY_VALUES.includes(category);
}
function isValidRequestCategory(category, requestType) {
  const canonical = requestType === 'service' ? SERVICE_CATEGORIES : CATEGORIES;
  return canonical.includes(category) || ALL_LEGACY_CATEGORY_VALUES.includes(category);
}

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
// Ordered as a professional B2B surplus marketplace, not a waste/recycling directory: the most
// commercially relevant surplus streams (furniture, IT/electronics, machinery, packaging, retail
// fixtures, metal/wood/textile offcuts) come first; specialized byproduct/waste-stream categories
// are last so the frontend can tuck them behind a "More categories" toggle. Presentation-only
// change — same 15 values as before, just reordered. No category was added, removed, or renamed,
// so existing stored items/requests and BUSINESS_SURPLUS_CATEGORIES (a by-value subset below,
// unaffected by order) keep filtering correctly.
const BUSINESS_CATEGORIES = [
  'Office Furniture & Fixtures',
  'Electronics & IT Equipment',
  'Business Equipment & Machinery',
  'Packaging Material',
  'Retail / Event Surplus',
  'Metal Scrap (CNC/Machining)',
  'Wood Scrap & Sawdust',
  'Fabric & Textile Scrap',
  'Other Industrial Byproduct',
  // --- specialized / waste-stream categories (shown behind "More categories" on the frontend) ---
  'Cow Dung & Manure',
  'Used Cooking Oil',
  'Food & Organic Waste',
  'Paper & Cardboard Waste',
  'Plastic Scrap',
  'Construction Debris'
];
// How many of the entries above (from the start) count as "primary" and show immediately in the
// Business Surplus sidebar before a "More categories" toggle is needed to reveal the rest.
const BUSINESS_CATEGORIES_PRIMARY_COUNT = 9;
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
function getLiveSession(rawToken) {
  const tokenHash = hashToken(rawToken);
  const session = db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND (expires_at IS NULL OR expires_at >= datetime('now'))"
  ).get(tokenHash);
  if (session) return session;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  return null;
}

function requireAuth(req, res, next) {
  // PHASE 9A: token now comes from either the web cookie or an Authorization: Bearer header
  // (see getAuthToken above) -- everything else in this function is completely unchanged, so
  // web and future-mobile requests are validated by the exact same code path.
  const token = getAuthToken(req);
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
    db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
    return res.status(403).json({ error: 'Your account has been suspended.' });
  }
  req.user = user;
  req.authToken = token;
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
  next();
}

function optionalAuth(req, res, next) {
  // PHASE 9A: same cookie-or-bearer resolution as requireAuth, so a future mobile client gets
  // identical owner/public field visibility on read routes as the website does.
  const token = getAuthToken(req);
  if (token) {
    const session = getLiveSession(token);
    if (session) {
      const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(session.user_id);
      if (user && user.is_banned) {
        // Optional-auth routes are read-only/public-facing — a banned user shouldn't get any
        // "logged in" privileges there (e.g. owner-only pickup visibility), but there's no reason
        // to hard-fail a page view, so this just quietly treats them as logged out.
        db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
      } else if (user) {
        req.user = user;
        req.authToken = token;
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
  // PHASE 8 HARDENING: type-checked alongside the existing truthiness check -- a non-string,
  // truthy value (an object/array) previously passed this check and then crashed with a raw
  // TypeError at email.toLowerCase() a few lines down (500 instead of a clean 400).
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' || !name || !email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
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
  // LOCATION FOUNDATION: fire-and-forget, after the response is already sent — never delays signup.
  if (location) backgroundGeocodeUserLocation(id, location);
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  // PHASE 8 HARDENING: `(email || '')` still evaluates to a non-string TRUTHY value like an object,
  // which then crashes at .toLowerCase() (500 instead of 400). Explicitly requiring a string first
  // closes that, and bcrypt.compareSync also requires its input to be a string (a non-string
  // password would throw there too).
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
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
  const body = { id: user.id, name: user.name, email: user.email, account_type: user.account_type, is_verified: user.is_verified, is_admin: shouldBeAdmin };
  // PHASE 9A: a future mobile client can't rely on cookies, so it opts into receiving the raw
  // session token directly in the response body by sending `Accept: application/json` on the
  // login request. The existing website never sends that header on this call (see public/app.js
  // -- it only sets Content-Type), so this is purely additive and changes nothing for the web
  // flow. The token is only ever placed here, in this one deliberate response, on this one
  // request -- never logged, never echoed by any other route, never accepted back from a query
  // string or body field.
  const acceptsJson = (req.get('Accept') || '').toLowerCase().includes('application/json');
  if (acceptsJson) body.token = token;
  res.json(body);
});

app.post('/api/logout', (req, res) => {
  // PHASE 9A: resolves whichever session (cookie or bearer) made this request, so a mobile
  // client's bearer session can be invalidated through this same existing route -- no second
  // logout mechanism.
  const token = getAuthToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
  if (req.cookies.token) res.clearCookie('token', sessionCookieOptions());
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
      // DEMO/DEV MODE: outside production we return the raw token directly (and log it) so the
      // reset flow is testable end-to-end without needing a real inbox. In production the token is
      // never logged or returned in the response — it only ever leaves the server inside the email
      // sent via sendPasswordResetEmail() (Gmail SMTP; see EMAIL_ENABLED near the top of this file).
      if (!IS_PROD) {
        console.log(`[dev] password reset token for ${email}: ${rawToken}`);
        return res.json({ ok: true, message: GENERIC_RESET_MESSAGE, dev_reset_token: rawToken });
      }
      sendPasswordResetEmail(email, rawToken);
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
  res.json({ user: req.user || null, categories: CATEGORIES, business_categories: BUSINESS_CATEGORIES, business_categories_primary_count: BUSINESS_CATEGORIES_PRIMARY_COUNT, service_categories: SERVICE_CATEGORIES });
});

// Edit Profile: only name and location are editable here. Email is intentionally left out — changing
// it would need its own re-verification flow, which doesn't exist yet, so this doesn't pretend to
// support it. account_type/is_admin/is_verified/is_banned are never client-settable.
// Precision values a USER's own discovery location may ever be tagged with. 'exact' is
// deliberately excluded — that concept belongs only to item/request pickup coordinates geocoded
// from a specific street address (see db.js). A user's general location is never treated as an
// exact, disclosable point, regardless of source (typed text, search selection, or device GPS).
const USER_LOCATION_PRECISIONS = ['city', 'neighborhood', 'approximate'];

app.patch('/api/me', requireAuth, accountUpdateLimiter, (req, res) => {
  const { name, location, location_lat, location_lng, location_source, location_precision } = req.body;
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 80) return res.status(400).json({ error: 'Name must be 1-80 characters' });
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trimmed, req.user.id);
  }

  // PHASE 2 — LOCATION PICKER: the picker always sends `location` (the human-readable label the
  // user confirmed) together with `location_lat`/`location_lng` in the same request, since it
  // already resolved the coordinate itself (via search selection or reverse-geocoded GPS) — no
  // need to re-geocode text we already have a fresh, known-good coordinate for. Both lat and lng
  // must arrive together; the server re-validates the ranges itself regardless of what the client
  // claims (per the location-foundation privacy rules — never trust client-supplied coordinates or
  // precision blindly). A plain text-only edit (no coordinates) falls back to the original
  // Phase-1 behavior: save the text, background-geocode it best-effort.
  const coordsProvided = location_lat !== undefined || location_lng !== undefined;
  if (coordsProvided) {
    if (location_lat === undefined || location_lng === undefined) {
      return res.status(400).json({ error: 'location_lat and location_lng must be provided together' });
    }
    const lat = parseFloat(location_lat), lng = parseFloat(location_lng);
    if (!isValidLat(lat) || !isValidLng(lng)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    // GPS-sourced coordinates are always downgraded to 'approximate', overriding anything the
    // client claims — a device's GPS reading is never treated as a publicly-exact point for a
    // user's general discovery location. A search-sourced selection may claim a more specific
    // precision, but only from the fixed whitelist below; anything else (including 'exact') is
    // rejected in favor of the safe default.
    const precision = location_source === 'gps'
      ? 'approximate'
      : (USER_LOCATION_PRECISIONS.includes(location_precision) ? location_precision : 'approximate');
    db.prepare(`UPDATE users SET location_lat = ?, location_lng = ?, location_precision = ?, location_geocoded_at = datetime('now'), location_geocode_status = 'ok' WHERE id = ?`)
      .run(lat, lng, precision, req.user.id);
  }

  let locationChanged = false;
  if (location !== undefined) {
    const trimmedLoc = String(location).trim();
    if (trimmedLoc.length > 120) return res.status(400).json({ error: 'Location must be under 120 characters' });
    // LOCATION FOUNDATION: only re-geocode when the text actually changed — avoids an unnecessary
    // provider request on every profile save that doesn't touch location (e.g. a name-only edit).
    // Suppressed entirely when coordinates were provided directly above — re-geocoding the label
    // text would be redundant work against a coordinate we already just saved.
    locationChanged = !coordsProvided && trimmedLoc !== req.user.location;
    db.prepare('UPDATE users SET location = ? WHERE id = ?').run(trimmedLoc, req.user.id);
  }
  const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(req.user.id);
  res.json({ user });
  if (locationChanged) backgroundGeocodeUserLocation(req.user.id, location);
});

// PHASE 2 — LOCATION PICKER: forward search suggestions. Unauthenticated-accessible (no
// user-specific data returned, no side effects) — the location picker can reasonably be shown
// before login, and gating it behind auth would add nothing privacy-relevant. Rate-limited (see
// locationSearchLimiter) since this is a direct passthrough to a metered external provider.
app.get('/api/location/search', locationSearchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ status: 'skipped', results: [] });
  if (q.length > 200) return res.status(400).json({ error: 'Search text too long' });
  const result = await searchPlaces(q);
  // Never forward raw provider metadata or internal status strings the frontend doesn't need to
  // act on beyond display — result.results already contains only label/lat/lng/precision.
  res.json({ status: result.status, results: result.results });
});

// PHASE 2 — LOCATION PICKER: reverse geocode a device-supplied coordinate into a human-readable
// label. Coordinates are validated server-side regardless of what the client sent — this is the
// one place a client gets to supply raw coordinates at all in this app, so the validation here is
// the actual security boundary, not the frontend's own range check (which exists only for a fast,
// friendly error before a round-trip).
app.post('/api/location/reverse', locationSearchLimiter, async (req, res) => {
  const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
  if (!isValidLat(lat) || !isValidLng(lng)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  const result = await reverseGeocode(lat, lng);
  res.json({ status: result.status, label: result.label, precision: result.precision });
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
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, hashToken(req.authToken));
  res.json({ ok: true });
});

// ---------- trust: verification (email OTP via Gmail SMTP; see EMAIL_ENABLED above) ----------
app.post('/api/verify/request', requireAuth, verifyLimiter, (req, res) => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET verify_code = ? WHERE id = ?').run(code, req.user.id);
  if (!IS_PROD) {
    // DEMO/DEV MODE: same pattern as /api/forgot-password above — return the code directly so the
    // flow is testable without needing a real inbox.
    return res.json({ ok: true, demo_code: code });
  }
  sendVerificationCodeEmail(req.user.email, code);
  res.json({ ok: true });
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
// Phase 6: every entry ends in `id ASC` as a stable secondary tiebreak. created_at only has
// whole-second precision (SQLite datetime('now')), so two rows created in the same second
// previously had no defined relative order — harmless before pagination existed (the whole result
// set always came back in one response, so a tie could only swap two rows' visual position), but
// now that a row's PAGE depends on its position in the ordering, an undefined tiebreak could let
// the same row appear on two different pages or vanish between them across two separate requests.
// `id` is a random nanoid, carries no product/ranking meaning — this is a purely technical fix for
// pagination stability, not a new ranking rule (see Phase 6 report, "Ordering").
const ITEM_SORTS = {
  newest: 'items.created_at DESC, items.id ASC',
  urgent: 'items.is_urgent DESC, items.created_at DESC, items.id ASC',
  price_low: 'items.price ASC, items.created_at DESC, items.id ASC'
};
const REQUEST_SORTS = {
  newest: 'requests.created_at DESC, requests.id ASC',
  urgent: 'requests.is_urgent DESC, requests.created_at DESC, requests.id ASC',
  price_low: 'requests.budget_amount ASC, requests.created_at DESC, requests.id ASC'
};

// ---------- Phase 5: nearby (radius) discovery ----------
// Uses items.pickup_public_lat/pickup_public_lng — the already-fuzzed/rounded coordinate computed
// by backgroundGeocodePickup() specifically for this purpose (see db.js's Location Foundation V1
// comments: "intended to eventually back radius/distance search without ever revealing the real
// pickup point"). The exact/private pickup_lat/pickup_lng are never read for this feature at all.
// stripInternalGeoFields() (via attachMedia()) still deletes every raw coordinate field from every
// response exactly as before — only a derived, rounded `distance_km` number is ever added to a row.
//
// Requests are deliberately NOT covered: the `requests` table has no pickup/location coordinate
// columns at all (only items and request_offers do — see db.js). Implementing nearby search there
// would require fabricating coordinates or a schema change, both out of scope for this phase (see
// the Phase 5 report, "Product Decisions").
//
// radius_km is REQUIRED whenever lat/lng are supplied — no default radius is assumed. "Should
// nearby search default to 5km or 10km?" is an explicit undecided product question called out in
// the Phase 5 brief, so this implementation never silently picks one; the caller must always state
// an explicit radius. MAX_NEARBY_RADIUS_KM is a conservative IMPLEMENTATION-level abuse/performance
// bound only (not a product decision) — 200km comfortably covers "same metro area or a realistic
// day-trip" for a reuse marketplace while preventing a client from requesting a near-global
// bounding-box table scan.
const MAX_NEARBY_RADIUS_KM = 200;
const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Parses/validates lat/lng/radius_km query params. { active: false } when none of the three are
// present — existing behavior (every caller today) is completely unaffected. { active: false,
// error } when the params are malformed/incomplete — callers must respond 400, never silently fall
// back to "no nearby filter" for a request that looks like it was trying to use one.
function parseNearbyParams(query) {
  const { lat, lng, radius_km } = query;
  const anyProvided = lat !== undefined || lng !== undefined || radius_km !== undefined;
  if (!anyProvided) return { active: false };
  if (lat === undefined || lng === undefined || radius_km === undefined) {
    return { active: false, error: 'lat, lng, and radius_km must all be provided together for nearby search' };
  }
  const parsedLat = parseFloat(lat), parsedLng = parseFloat(lng), parsedRadius = parseFloat(radius_km);
  if (!isValidLat(parsedLat) || !isValidLng(parsedLng)) {
    return { active: false, error: 'Invalid coordinates' };
  }
  if (!Number.isFinite(parsedRadius) || parsedRadius < 0) {
    return { active: false, error: 'radius_km must be zero or a positive number' };
  }
  if (parsedRadius > MAX_NEARBY_RADIUS_KM) {
    return { active: false, error: `radius_km cannot exceed ${MAX_NEARBY_RADIUS_KM}` };
  }
  return { active: true, lat: parsedLat, lng: parsedLng, radiusKm: parsedRadius };
}

// Degrees-per-km bounding box around (lat, lng) for a given radius — a cheap SQL-level prefilter so
// the exact Haversine distance (computed in JS below) only ever runs over a small candidate set,
// never the whole table. Longitude degrees shrink toward the poles (cos(lat) term); latitude does
// not, so no such adjustment is needed there. The Math.max(...,0.01) floor guards the near-pole
// divide-by-near-zero case (not a realistic case for this app, but keeps the math from blowing up).
function boundingBox(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  return { minLat: lat - latDelta, maxLat: lat + latDelta, minLng: lng - lngDelta, maxLng: lng + lngDelta };
}

// Applies the exact Haversine cutoff and attaches a derived `distance_km` field. Must run on the
// RAW rows (items.* still present) BEFORE attachMedia()/stripInternalGeoFields() delete
// pickup_public_lat/pickup_public_lng — distance_km is a new, separate, rounded property; the raw
// coordinates it was computed from are still stripped from the response exactly as before, so this
// adds no new coordinate exposure.
function applyNearbyFilter(rows, nearby) {
  if (!nearby.active) return rows;
  return rows
    .map(row => {
      if (!isValidLat(row.pickup_public_lat) || !isValidLng(row.pickup_public_lng)) return null;
      const distance = haversineKm(nearby.lat, nearby.lng, row.pickup_public_lat, row.pickup_public_lng);
      if (distance > nearby.radiusKm) return null;
      row.distance_km = Math.round(distance * 10) / 10;
      return row;
    })
    .filter(Boolean);
}

// ---------- Phase 6: pagination ----------
// DEFAULT_PAGE_SIZE/MAX_PAGE_SIZE are conservative IMPLEMENTATION-level defaults, not a product
// decision — the frontend today sends neither `page` nor `limit` at all (confirmed by reading
// loadItems()/loadRequests() in public/app.js: both do `state.items = items` / `state.requests =
// requests` directly against the bare array response), so these values only ever apply to a NEW
// caller that explicitly opts into paginated mode. 20/page mirrors a typical grid page; 100 is a
// hard resource-protection ceiling so no caller can request the entire table in one response even
// once pagination exists.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Never throws, never produces an unbounded/negative result — every malformed input (missing,
// empty string, "null", "abc", 0, negative, huge) safely clamps to a sane value rather than
// erroring. This mirrors this app's own established convention for query-shape params (an
// unrecognized `sort=` or empty `category=` also silently falls back rather than 400ing) — unlike
// Phase 5's nearby lat/lng/radius_km, which intentionally 400s on malformed input because acting on
// a wrong coordinate is materially worse than acting on a wrong page number.
function parsePaginationParams(query) {
  const rawPage = parseInt(query.page, 10);
  const rawLimit = parseInt(query.limit, 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  let limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? rawLimit : DEFAULT_PAGE_SIZE;
  if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;
  return { page, limit };
}

// Slices an already fully-filtered, already-ordered, in-memory row array. This is deliberately NOT
// a SQL LIMIT/OFFSET on the original query: block filtering (isBlockedEitherWay) happens in JS,
// AFTER the SQL fetch, exactly as it already did before this phase (see the block-filter line in
// both /api/items and /api/requests below) — pagination must slice AFTER that filter runs, or a
// blocked user's rows would silently consume page slots and a full page could come back short (or
// empty) even when enough *visible* records exist further down the unfiltered set. `total` and
// `hasMore` are computed from this same already-filtered array, so they cost nothing extra (no
// separate COUNT(*) query) and are always exactly accurate for what this caller is allowed to see.
function paginate(rows, page, limit) {
  const total = rows.length;
  const start = (page - 1) * limit;
  const items = rows.slice(start, start + limit);
  return { items, page, limit, total, hasMore: start + limit < total };
}

// ---------- items ----------
app.get('/api/items', optionalAuth, (req, res) => {
  expireStaleListings();
  const { category, price_type, q, mine, listing_type, location, urgent, sort } = req.query;
  // Phase 5: nearby (radius) discovery. Validated up front — a malformed/partial lat+lng+radius_km
  // combination is a 400, never a silent "ignore the geo params" fallback.
  const nearby = parseNearbyParams(req.query);
  if (nearby.error) return res.status(400).json({ error: nearby.error });
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
  // Nearby: a cheap SQL-level bounding-box prefilter (indexless but bounded by the WHERE clause
  // above too) — the exact Haversine cutoff runs in JS just below, over this already-small set.
  if (nearby.active) {
    const bbox = boundingBox(nearby.lat, nearby.lng, nearby.radiusKm);
    sql += ' AND items.pickup_public_lat IS NOT NULL AND items.pickup_public_lng IS NOT NULL AND items.pickup_public_lat BETWEEN ? AND ? AND items.pickup_public_lng BETWEEN ? AND ?';
    params.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
  }
  // Default (no/unknown sort param) preserves the exact pre-existing order — newest first —
  // so this is purely additive and can't change behavior for any caller that doesn't opt in.
  sql += ' ORDER BY ' + (ITEM_SORTS[sort] || ITEM_SORTS.newest);
  // List/browse view is always the "public" surface: never include exact pickup address/instructions
  // here, regardless of who's logged in. Exact info is only ever returned from the single-item
  // detail route below, and only to the owner or the accepted requester.
  let rows = db.prepare(sql).all(...params);
  // Must run before attachMedia() strips pickup_public_lat/pickup_public_lng off each row.
  rows = applyNearbyFilter(rows, nearby);
  rows = rows.map(attachMedia).map(stripExactPickup);
  // Block filtering only applies to the public browse path — "mine" (My Posts) is always your own
  // items, irrelevant to any block relationship you might have with someone else.
  if (!mine && req.user) rows = rows.filter(item => !isBlockedEitherWay(req.user.id, item.user_id));
  // Distance-ascending is the intuitive default for an active nearby search (see Phase 5 report,
  // "Sorting") — but only when the caller didn't explicitly ask for a different sort; an explicit
  // sort= always wins, exactly like today, nearby search or not. `id` is the same purely-technical
  // tiebreak as ITEM_SORTS, for the same reason (pagination stability, not a ranking change).
  if (nearby.active && !sort) {
    rows.sort((a, b) => a.distance_km - b.distance_km || new Date(b.created_at) - new Date(a.created_at) || a.id.localeCompare(b.id));
  }
  // Phase 6: pagination is purely additive and opt-in. Every filter above (status, listing_type,
  // category, block, moderation via attachMedia, Food Rescue expiry via expireStaleListings,
  // nearby/radius) has already run by this point — pagination only ever slices what's left, last.
  // A caller that sends neither `page` nor `limit` gets the EXACT same bare array response as
  // always (verified in the Phase 6 regression suite) — zero behavior change for the existing
  // frontend or any existing test. Only a caller that explicitly asks for a page gets the new
  // `{ items, page, limit, total, hasMore }` shape.
  const paginationRequested = req.query.page !== undefined || req.query.limit !== undefined;
  if (paginationRequested) {
    const { page, limit } = parsePaginationParams(req.query);
    return res.json(paginate(rows, page, limit));
  }
  res.json(rows);
});

// Urgent listing discovery — mirrors /api/requests/urgent exactly. Must be registered BEFORE
// /api/items/:id below, otherwise Express matches "urgent" as an :id param and this route is
// never reached (route order matters — first matching pattern wins).
// Optional listing_type filter keeps "urgent food about to spoil" (homepage) and "urgent business
// surplus" (Business Surplus page) from being mixed into one undifferentiated list — without it,
// every urgent item across both sections is returned, same as before this filter was added.
app.get('/api/items/urgent', optionalAuth, (req, res) => {
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
  let rows = db.prepare(sql).all(...params).map(attachMedia).map(stripExactPickup);
  if (req.user) rows = rows.filter(item => !isBlockedEitherWay(req.user.id, item.user_id));
  res.json(rows);
});

app.get('/api/items/:id', optionalAuth, (req, res) => {
  const item = db.prepare(`SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.email AS owner_email, users.is_verified AS owner_verified
                            FROM items JOIN users ON items.user_id = users.id WHERE items.id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  // A block relationship makes this listing simply not exist for either side — 404 rather than a
  // dedicated "blocked" error, so the blocked side can't tell the difference from a deleted listing.
  if (req.user && isBlockedEitherWay(req.user.id, item.user_id)) return res.status(404).json({ error: 'Not found' });
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

app.post('/api/items', requireAuth, createListingLimiter, upload.array('media', MAX_UPLOAD_FILES), async (req, res) => {
  const { title, description, category, condition, price_type, price, exchange_for, rent_rate, rent_period, deposit, is_recurring, frequency, quantity, listing_type, pickup_available, pickup_type, pickup_area, pickup_address, pickup_instructions,
    available_until, is_urgent, food_pref, is_edible_food } = req.body;
  const files = req.files || [];
  // PHASE 8 HARDENING: previously only checked truthiness (`!title`), which a non-empty NON-STRING
  // value (an object, an array) still passes -- that value then reached better-sqlite3's .run() as a
  // bind parameter, which only accepts numbers/strings/bigints/buffers/null and THROWS a TypeError
  // for anything else (an object/array), crashing the request with a 500 instead of a clean 400.
  // Requiring these three fields to actually be strings closes that crash path at the door.
  if (typeof title !== 'string' || typeof description !== 'string' || typeof category !== 'string' || !title || !description || !category) {
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const itemListingType = listing_type === 'business_waste' ? 'business_waste' : 'consumer';
  if (!isValidItemCategory(category, itemListingType)) {
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: 'Invalid category for this listing type' });
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
    if (decision.status === 'approved') {
      const { url, thumbUrl } = await processApprovedImage(f.path, f.mimetype);
      mediaResults.push({ url, thumbUrl, status: decision.status, note: decision.note });
    } else {
      // Still quarantined — no processing yet (nothing to display publicly until an admin approves
      // it via /api/admin/images/:id/approve, which now runs the same processApprovedImage step).
      mediaResults.push({ url: '/uploads/' + f.filename, thumbUrl: null, status: decision.status, note: decision.note });
    }
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
    db.prepare("INSERT INTO item_media (id, item_id, url, thumb_url, media_type, position, status, moderation_note, moderated_at, moderated_by) VALUES (?,?,?,?,?,?,?,?, datetime('now'), 'auto')")
      .run(nanoid(), id, m.url, m.thumbUrl || null, 'image', i, m.status, m.note);
  });
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.json(attachMedia(item));
  // LOCATION FOUNDATION: fire-and-forget, after the response is already sent.
  backgroundGeocodePickup('items', id, pickup_address, pickup_area);
});

// AUDIT FIX: this route had no optionalAuth and never applied isBlockedEitherWay, so a blocked
// user's items could still surface in the Trending strip even though the same block hides them
// from /api/items and /api/items/urgent — inconsistent with the "this listing simply doesn't
// exist for either side" rule stated everywhere else in this file. optionalAuth added so req.user
// is populated when a session cookie is present; behavior for a logged-out request is unchanged.
app.get('/api/items-trending', optionalAuth, (req, res) => {
  const { listing_type } = req.query;
  let rows = db.prepare(`SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location
                            FROM items JOIN users ON items.user_id = users.id
                            WHERE items.status != 'closed' AND items.request_count > 0 AND items.listing_type = ?
                            ORDER BY items.request_count DESC, items.created_at DESC
                            LIMIT 8`).all(listing_type === 'business_waste' ? 'business_waste' : 'consumer').map(attachMedia).map(stripExactPickup);
  if (req.user) rows = rows.filter(item => !isBlockedEitherWay(req.user.id, item.user_id));
  res.json(rows);
});

// ---------- homepage priority sections: Education & Children's Needs, then Construction Site Leftovers ----------
// AUDIT FIX: same gap as /api/items-trending above — no optionalAuth, no block filtering. Added
// for consistency; a logged-out request's response is unchanged.
app.get('/api/home-highlights', optionalAuth, (req, res) => {
  expireStaleListings();
  const result = HOME_HIGHLIGHT_GROUPS.map(group => {
    const placeholders = group.categories.map(() => '?').join(',');
    let rows = db.prepare(`SELECT items.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
                              FROM items JOIN users ON items.user_id = users.id
                              WHERE items.status != 'closed' AND items.listing_type = 'consumer' AND items.category IN (${placeholders})
                              ORDER BY items.created_at DESC
                              LIMIT 8`).all(...group.categories).map(attachMedia).map(stripExactPickup);
    if (req.user) rows = rows.filter(item => !isBlockedEitherWay(req.user.id, item.user_id));
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
    // PHASE 8 HARDENING: this previously accepted ANY string with zero validation — a client could
    // PATCH status to an arbitrary value, or (more seriously) directly to 'claimed', a value that's
    // supposed to only ever be set by the system when a claim is actually accepted (see PATCH
    // /api/claims/:id above). That would leave an item marked claimed with no corresponding accepted
    // claim — an inconsistent state nothing else in this file expects. items.status's own schema
    // comment (db.js) documents exactly three values: available | claimed | closed. 'claimed' is
    // system-managed only; the owner-facing transitions here are exactly the two this route's own
    // existing code already handles by name below ('available' to repost, 'closed' to end a
    // listing) — both already exercised by the existing test suite, so this whitelist changes
    // nothing for any currently-passing case, it only rejects what was never a valid transition.
    const OWNER_ITEM_STATUSES = ['available', 'closed'];
    if (!OWNER_ITEM_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${OWNER_ITEM_STATUSES.join(', ')}` });
    }
    db.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, req.params.id);
    // Reposting (marking available again) resets the expiry clock.
    if (status === 'available') db.prepare(`UPDATE items SET expires_at = datetime('now', '+${LISTING_LIFETIME_DAYS} days') WHERE id = ?`).run(req.params.id);
  }
  // Full edit: only applied when title is present, so a status-only PATCH (e.g. "mark closed") still works unchanged.
  if (title !== undefined) {
    const newPriceType = price_type || item.price_type;
    const newCategory = category || item.category;
    if (category !== undefined && !isValidItemCategory(newCategory, item.listing_type)) {
      return res.status(400).json({ error: 'Invalid category for this listing type' });
    }
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
  // LOCATION FOUNDATION: only re-geocode when pickup_address/pickup_area actually changed (mirrors
  // the same "preserve if undefined" convention used above) — avoids re-geocoding on every edit that
  // doesn't touch pickup location (e.g. a title/description-only edit).
  const newPickupAddress = pickup_address !== undefined ? pickup_address : item.pickup_address;
  const newPickupArea = pickup_area !== undefined ? pickup_area : item.pickup_area;
  if (newPickupAddress !== item.pickup_address || newPickupArea !== item.pickup_area) {
    backgroundGeocodePickup('items', req.params.id, newPickupAddress, newPickupArea);
  }
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
    // BUG FIX (Phase 3 upload security audit): m.thumb_url (the separate thumbnail variant
    // generated by processApprovedImage()) was never unlinked here — only the full-size m.url —
    // so every item deletion silently left an orphaned "-thumb.jpg/.png" file on disk forever.
    // Pending-review media (never processed, no thumbnail generated yet) simply has thumb_url
    // null/undefined, so this is a no-op for that case, matching existing best-effort semantics.
    if (m.thumb_url) {
      const thumbFilePath = path.join(__dirname, 'public', m.thumb_url);
      fs.unlink(thumbFilePath, () => {});
    }
  });
  res.json({ ok: true });
});

// ---------- claims / requests ----------
app.post('/api/items/:id/claim', requireAuth, (req, res) => {
  expireStaleListings();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.user_id === req.user.id) return res.status(400).json({ error: "Can't claim your own item" });
  // 404 (not 403) to match the same "this listing simply doesn't exist for you" treatment used on
  // the detail route above — doesn't confirm to the client that a block is the specific reason.
  if (isBlockedEitherWay(req.user.id, item.user_id)) return res.status(404).json({ error: 'Not found' });
  // Defense-in-depth: expireStaleListings() above should already have closed this if it passed
  // its deadline, but re-check the raw field too in case a claim lands in the narrow race window
  // between that closing pass and this request. Scoped only to the new available_until field so
  // this doesn't change claim behavior for any listing that isn't using Food Rescue deadlines.
  // Checked BEFORE the general status check below so an expired food listing keeps this specific,
  // more informative message rather than the generic one.
  if (item.available_until && item.available_until < db.prepare("SELECT datetime('now') AS n").get().n) {
    return res.status(400).json({ error: 'This food is past its pickup deadline and can no longer be requested' });
  }
  // BUG FIX (Food Rescue Phase 1 testing): a claim submitted after the item already moved to
  // 'claimed' (owner accepted someone else) or 'closed' was previously accepted with no check at
  // all — this route only ever validated self-claim/block/expiry, never item.status itself. A
  // 'claimed' item still appears in public browse (only 'closed' is excluded, see GET /api/items),
  // so anyone could keep submitting claims against food that's already been given away. This
  // mirrors the state-consistency check CLAIM_TRANSITIONS already enforces one step later (on
  // PATCH /api/claims/:id) — that route guards against re-processing a claim after its own status
  // has moved; this route was missing the equivalent guard against the ITEM having moved.
  if (item.status !== 'available') {
    return res.status(400).json({ error: 'This item is no longer available' });
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
  // BUG FIX (Phase 2 cross-cutting audit): CLAIM_TRANSITIONS only guards against re-processing
  // THIS claim's own status — it never checked the ITEM's status. If more than one pending claim
  // exists on the same item (duplicate claims are currently allowed; see the audit report), the
  // owner could accept a SECOND claim after already accepting a first one, since the second claim
  // row is still "pending" on its own. Both could then independently reach "completed", inflating
  // completed_requests for what is really one item exchanged once. Declining is unaffected — an
  // owner must always be able to decline/clean up a stale duplicate claim regardless of the item's
  // status. This reuses the exact same rule/message already enforced at claim-creation time
  // (POST /api/items/:id/claim) — an item must be "available" to become newly claimed.
  if (status === 'accepted' && item.status !== 'available') {
    return res.status(400).json({ error: 'This item is no longer available' });
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
  // BUG FIX (Notifications Phase 1 Step 5 testing): a caller who already confirmed calling this
  // route again with confirmed:true re-ran the UPDATE and re-fired the exchange_confirmed
  // notification to the other party on every repeat call, with no guard — the same duplicate-
  // notification bug class the CLAIM_TRANSITIONS state-machine guard was added to prevent for
  // accept/decline. If this party's own field is already set, treat it as a no-op repeat.
  if (claim[field]) {
    return res.json({ ok: true, status: claim.status, giver_confirmed: !!claim.giver_confirmed, receiver_confirmed: !!claim.receiver_confirmed });
  }
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
  // can reach this response. LOCATION FOUNDATION: this route builds `item` from a raw
  // `SELECT * FROM items` rather than attachMedia() (which now strips the new coordinate columns),
  // so stripInternalGeoFields() must be applied explicitly here too — unconditionally, same as
  // everywhere else, since no coordinate is exposed via any API response yet.
  res.json({ claim, item: stripInternalGeoFields(claim.status === 'accepted' || claim.status === 'completed' ? item : stripExactPickup(item)), role: isGiver ? 'giver' : 'receiver' });
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
app.get('/api/users/:id/profile', optionalAuth, profileLimiter, (req, res) => {
  const user = db.prepare('SELECT id, name, account_type, location, is_verified, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (req.user && isBlockedEitherWay(req.user.id, user.id)) return res.status(404).json({ error: 'Not found' });

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

// ---------- web push subscription management ----------
// Public (no auth) — the public key itself isn't secret, it's embedded in every subscribe call the
// frontend makes, same as any other client-side config value.
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!PUSH_ENABLED) return res.status(404).json({ error: 'Push notifications are not configured' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Upsert by endpoint (unique per browser install): re-subscribing the same browser (e.g. after
// clearing the permission and re-granting it) just refreshes the row's owner/keys instead of
// erroring on the UNIQUE constraint or piling up duplicate rows for one real device.
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !endpoint || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?')
      .run(req.user.id, keys.p256dh, keys.auth, existing.id);
  } else {
    db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?)')
      .run(nanoid(), req.user.id, endpoint, keys.p256dh, keys.auth);
  }
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (typeof endpoint === 'string' && endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  }
  res.json({ ok: true });
});

// ---------- blocks (Trust & Safety) ----------
// Separate from `reports` below: a block is a personal relationship the blocker controls directly
// (no admin involvement, no moderation queue). Bidirectional in effect — see isBlockedEitherWay().
function isBlockedEitherWay(userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const row = db.prepare(
    'SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
  ).get(userIdA, userIdB, userIdB, userIdA);
  return !!row;
}

app.post('/api/users/:id/block', requireAuth, blockLimiter, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) return res.status(400).json({ error: "You can't block yourself" });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // INSERT OR IGNORE against the unique (blocker_id, blocked_id) index makes a repeat click on
  // "Block" idempotent rather than a 500/constraint-violation error.
  db.prepare('INSERT OR IGNORE INTO blocks (id, blocker_id, blocked_id) VALUES (?,?,?)')
    .run(nanoid(), req.user.id, targetId);
  res.json({ ok: true });
});

app.delete('/api/users/:id/block', requireAuth, blockLimiter, (req, res) => {
  // Scoped to blocker_id = req.user.id — a user can only ever remove their OWN block record, never
  // someone else's (there is no path here for user A to unblock on behalf of user B).
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.get('/api/users/blocked', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT users.id, users.name, users.account_type, users.is_verified, blocks.created_at AS blocked_at
     FROM blocks JOIN users ON blocks.blocked_id = users.id
     WHERE blocks.blocker_id = ? ORDER BY blocks.created_at DESC`
  ).all(req.user.id);
  res.json(rows);
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
app.get('/api/requests', optionalAuth, (req, res) => {
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
  let rows = db.prepare(sql).all(...params);
  if (!mine && req.user) rows = rows.filter(r => !isBlockedEitherWay(req.user.id, r.user_id));
  // Phase 6: same opt-in, additive pagination as /api/items — see the extended comment there.
  // Requests have no geographic coordinates (confirmed in Phase 5), so there is no distance-sort
  // interaction to preserve here; block/status filtering above still always runs before this.
  const paginationRequested = req.query.page !== undefined || req.query.limit !== undefined;
  if (paginationRequested) {
    const { page, limit } = parsePaginationParams(req.query);
    const paged = paginate(rows, page, limit);
    return res.json({ requests: paged.items, page: paged.page, limit: paged.limit, total: paged.total, hasMore: paged.hasMore });
  }
  res.json(rows);
});

// Homepage priority section #1: urgent requests across both thing/service types.
app.get('/api/requests/urgent', optionalAuth, (req, res) => {
  expireStaleListings();
  let rows = db.prepare(`SELECT requests.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.is_verified AS owner_verified
                            FROM requests JOIN users ON requests.user_id = users.id
                            WHERE requests.status = 'open' AND requests.is_urgent = 1
                            ORDER BY requests.created_at DESC
                            LIMIT 8`).all();
  if (req.user) rows = rows.filter(r => !isBlockedEitherWay(req.user.id, r.user_id));
  res.json(rows);
});

app.get('/api/requests/:id', optionalAuth, (req, res) => {
  const request = db.prepare(`SELECT requests.*, users.name AS owner_name, users.account_type AS owner_type, users.location AS owner_location, users.email AS owner_email, users.is_verified AS owner_verified
                               FROM requests JOIN users ON requests.user_id = users.id WHERE requests.id = ?`).get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (req.user && isBlockedEitherWay(req.user.id, request.user_id)) return res.status(404).json({ error: 'Not found' });
  // owner_email must only ever reach the requester themselves — anyone browsing/considering
  // offering help sees name/location/verified status only, never the requester's email. Contact
  // only ever happens through an accepted request_offer (see /api/my/request-offers-received),
  // never by reading it straight off the request.
  const isOwner = req.user && req.user.id === request.user_id;
  res.json(isOwner ? request : stripExactPickup(request));
});

app.post('/api/requests', requireAuth, createListingLimiter, (req, res) => {
  const { title, description, request_type, category, budget_type, budget_amount, exchange_for, quantity, is_urgent } = req.body;
  // PHASE 8 HARDENING: mirrors the identical fix on POST /api/items above -- reject a non-string
  // title/description/category with a clean 400 instead of letting an object/array reach
  // better-sqlite3's .run() and crash with a raw TypeError (500).
  if (typeof title !== 'string' || typeof description !== 'string' || typeof category !== 'string' || !title || !description || !category) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const reqType = request_type === 'service' ? 'service' : 'thing';
  if (!isValidRequestCategory(category, reqType)) {
    return res.status(400).json({ error: 'Invalid category for this request type' });
  }
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
  if (status) {
    // PHASE 8 HARDENING: mirrors the identical fix on PATCH /api/items/:id above. requests.status's
    // schema comment documents open | fulfilled | closed; 'fulfilled' is system-managed only (set
    // when an offer is accepted via PATCH /api/request-offers/:id), never something the requester
    // should be able to set directly by PATCHing their own request. The only owner-facing
    // transitions this route ever exercised are 'closed' (the only value the frontend currently
    // sends) and 'open' (documented, symmetric with items' 'available' repost case) — both allowed.
    const OWNER_REQUEST_STATUSES = ['open', 'closed'];
    if (!OWNER_REQUEST_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${OWNER_REQUEST_STATUSES.join(', ')}` });
    }
    db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, req.params.id);
  }
  if (title !== undefined) {
    const newBudgetType = budget_type || request.budget_type;
    const newCategory = category || request.category;
    if (category !== undefined && !isValidRequestCategory(newCategory, request.request_type)) {
      return res.status(400).json({ error: 'Invalid category for this request type' });
    }
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
  if (isBlockedEitherWay(req.user.id, request.user_id)) return res.status(404).json({ error: 'Not found' });
  // BUG FIX (Requests Phase 1 testing): mirrors the identical fix already applied to
  // POST /api/items/:id/claim — this route never checked request.status at all, so a request
  // already 'fulfilled' (offer accepted) or manually 'closed' kept accepting brand-new offers with
  // 200. A request that goes back to 'open' after a not_completed reversal is unaffected by this
  // check (it IS 'open' again by then), so the legitimate re-response flow keeps working.
  if (request.status !== 'open') {
    return res.status(400).json({ error: 'This request is no longer open' });
  }
  const id = nanoid();
  const { pickup_type, pickup_area, pickup_address, pickup_instructions } = req.body;
  db.prepare('INSERT INTO request_offers (id, request_id, responder_id, message, offered_price, pickup_type, pickup_area, pickup_address, pickup_instructions) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, request.id, req.user.id, req.body.message || '', parseFloat(req.body.offered_price) || 0,
      sanitizePickupType(pickup_type), pickup_area || '', pickup_address || '', pickup_instructions || '');
  db.prepare('UPDATE requests SET offer_count = offer_count + 1 WHERE id = ?').run(request.id);
  notify(request.user_id, 'new_offer', `${req.user.name} can help with "${request.title}"`, null, 'offer', id);
  res.json({ ok: true, id });
  // LOCATION FOUNDATION: fire-and-forget, after the response is already sent.
  backgroundGeocodePickup('request_offers', id, pickup_address, pickup_area);
});

app.get('/api/my/request-offers-received', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT request_offers.*, requests.title AS request_title, users.name AS responder_name, users.email AS responder_email, users.is_verified AS responder_verified
                            FROM request_offers JOIN requests ON request_offers.request_id = requests.id JOIN users ON request_offers.responder_id = users.id
                            WHERE requests.user_id = ? ORDER BY request_offers.created_at DESC`).all(req.user.id);
  // Exact pickup location for an offer is only shown to the request owner once that offer is
  // accepted — same rule as items (approximate only while still deciding between offers).
  // LOCATION FOUNDATION: request_offers.* also now carries the new coordinate columns — stripped
  // unconditionally, same as everywhere else, regardless of acceptance status.
  res.json(rows.map(r => stripInternalGeoFields((r.status === 'accepted' || r.status === 'completed') ? r : stripExactPickup(r))));
});

app.get('/api/my/request-offers-sent', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT request_offers.*, requests.title AS request_title, requests.status AS request_status
                            FROM request_offers JOIN requests ON request_offers.request_id = requests.id
                            WHERE request_offers.responder_id = ? ORDER BY request_offers.created_at DESC`).all(req.user.id);
  // LOCATION FOUNDATION: this is the responder's own submitted offer, so pickup_address itself was
  // already safe to return here — but the new coordinate columns are stripped anyway, since no
  // response anywhere exposes them yet in this phase.
  res.json(rows.map(stripInternalGeoFields));
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
  // BUG FIX (Phase 2 cross-cutting audit): mirrors the identical fix already applied to
  // PATCH /api/claims/:id — OFFER_TRANSITIONS only guards this offer's own status, never the
  // parent request's status, so a second (duplicate) pending offer could still be accepted after
  // the request was already fulfilled by a different offer. Declining is unaffected.
  if (status === 'accepted' && request.status !== 'open') {
    return res.status(400).json({ error: 'This request is no longer open' });
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
  // BUG FIX (Notifications Phase 1 Step 5 testing): mirrors the identical fix already applied to
  // POST /api/claims/:id/confirm — repeated confirmed:true calls from an already-confirmed party
  // were re-firing exchange_confirmed to the other party on every call. No-op if already set.
  if (offer[field]) {
    return res.json({ ok: true, status: offer.status, giver_confirmed: !!offer.giver_confirmed, receiver_confirmed: !!offer.receiver_confirmed });
  }
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
  // LOCATION FOUNDATION: same unconditional strip as every other request_offers.*-selecting route.
  res.json({ offer: stripInternalGeoFields(offer.status === 'accepted' || offer.status === 'completed' ? offer : stripExactPickup(offer)), request, role: isGiver ? 'giver' : 'receiver' });
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

app.post('/api/admin/images/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const media = db.prepare("SELECT * FROM item_media WHERE id = ? AND status = 'pending_review'").get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  const quarantinePath = path.join(quarantineDir, path.basename(media.url));
  // Same processing as the auto-approve path (POST /api/items) — resize/thumbnail generation, with
  // the same fallback-to-plain-rename if sharp isn't available or the file fails to process.
  let publishedUrl = media.url, thumbUrl = null;
  if (fs.existsSync(quarantinePath)) {
    const mimetype = quarantinePath.endsWith('.png') ? 'image/png' : quarantinePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const result = await processApprovedImage(quarantinePath, mimetype);
    publishedUrl = result.url;
    thumbUrl = result.thumbUrl;
  }
  db.prepare("UPDATE item_media SET status = 'approved', url = ?, thumb_url = ?, moderated_at = datetime('now'), moderated_by = ? WHERE id = ?")
    .run(publishedUrl, thumbUrl, req.user.id, media.id);
  // If the item didn't have a cover photo yet (its first image was the one pending), give it one now.
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(media.item_id);
  if (item && !item.media_url) {
    db.prepare("UPDATE items SET media_url = ?, media_type = 'image' WHERE id = ?").run(publishedUrl, item.id);
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

// PHASE 8 HARDENING: operational visibility for the two failure modes that previously had no log
// line at all — an unhandled promise rejection (silently swallowed by default in modern Node,
// meaning a real bug could run forever unnoticed) and an uncaught synchronous exception (Node's
// default behavior already prints a stack trace and exits, but with no consistent log prefix to grep
// for). Neither handler changes existing behavior beyond adding a clear log line: an uncaught
// exception still exits the process afterward (matching Node's own default — this app has no
// in-memory state worth trying to preserve through a crash; every durable fact already lives in
// SQLite), and an unhandled rejection is logged but does not exit, since Node doesn't either by
// default and changing that here could turn an unrelated minor bug into a full outage.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err);
  process.exit(1);
});

const server = app.listen(PORT, () => console.log(`Zineedo running at http://localhost:${PORT}`));

// PHASE 8 HARDENING: this process previously had no shutdown handling at all — SIGTERM/SIGINT
// (what any process manager or `docker stop` sends) would hard-kill the process mid-request rather
// than letting in-flight requests finish, and never explicitly closed the SQLite connection or the
// hourly cleanup interval. server.close() stops accepting new connections and lets active ones
// finish naturally; the interval is already .unref()'d (see cleanupExpired above) so it was never
// actually keeping the process alive, but clearing it explicitly here is still the correct, complete
// shutdown rather than relying on that as an implicit side effect. db.close() flushes SQLite's WAL
// file cleanly rather than leaving it to whatever happens on process exit. A 10s hard-exit fallback
// guards against a request that never finishes (e.g. a stuck upstream call) blocking shutdown forever.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, closing server...`);
  const forceExit = setTimeout(() => {
    console.error('[shutdown] graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  server.close(() => {
    try { db.close(); } catch (err) { console.error('[shutdown] error closing database:', err); }
    console.log('[shutdown] closed cleanly');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
