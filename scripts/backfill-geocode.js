#!/usr/bin/env node
// ---------- Location Foundation V1: opt-in backfill for pre-existing rows ----------
//
// This is NEVER run automatically by the app itself — server.js only geocodes going forward, on
// signup/profile-edit/post/edit/offer. Every user, item, and request_offer that existed before this
// feature shipped has NULL coordinates and stays that way unless an admin explicitly runs this
// script. That's a deliberate choice, not an oversight: existing free-text locations may be
// ambiguous ("near the old cinema", a nickname for an area, a typo), and blindly geocoding all of
// them risks silently attaching a confidently-wrong coordinate to a real listing. A human should
// decide when/whether to do this, ideally after spot-checking a dry run.
//
// USAGE:
//   node scripts/backfill-geocode.js                  -> dry run: prints what WOULD be geocoded, writes nothing
//   node scripts/backfill-geocode.js --confirm         -> actually geocodes and writes to the DB
//   node scripts/backfill-geocode.js --confirm --limit=50   -> cap how many rows to process this run
//
// Requires GEOAPIFY_KEY to be set — refuses to run (even in dry-run mode, to avoid a misleading
// "0 to backfill" result) if it's missing.
//
// Rate limiting: processes rows strictly sequentially with a 1-request-per-second pace, regardless
// of Geoapify's actual allowed rate (well within its free-tier daily credit limit at this pace) —
// this is a backfill of old data, not a user-facing action, so there's no reason to run it any
// faster than the most conservative reasonable pace.
//
// Skips (never overwrites) any row that already has a non-null geocode_status, so re-running this
// script after a partial run or after new signups only ever processes rows that are still
// genuinely un-geocoded — safe to run repeatedly.

const path = require('path');
const db = require(path.join(__dirname, '..', 'db.js'));
const { geocodeText, isGeocodingConfigured, fuzzCoordinate } = require(path.join(__dirname, '..', 'geocoding.js'));

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const limitArg = args.find(a => a.startsWith('--limit='));
// better-sqlite3 can't bind Infinity as a LIMIT parameter, so "no limit" uses a very large finite
// integer instead — functionally unlimited for any realistic table size.
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Number.MAX_SAFE_INTEGER;
const PACE_MS = 1000; // 1 request/second, conservative and independent of the provider's actual limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function backfillUsers(stats) {
  const rows = db.prepare(
    "SELECT id, location FROM users WHERE location != '' AND location_geocode_status IS NULL LIMIT ?"
  ).all(LIMIT);
  for (const row of rows) {
    stats.usersConsidered++;
    if (!CONFIRM) { console.log(`[dry-run] would geocode user ${row.id} location="${row.location}"`); continue; }
    const result = await geocodeText(row.location);
    if (result.status === 'ok') {
      db.prepare(`UPDATE users SET location_lat = ?, location_lng = ?, location_precision = 'city', location_geocoded_at = datetime('now'), location_geocode_status = 'ok' WHERE id = ?`)
        .run(result.lat, result.lng, row.id);
      stats.usersOk++;
    } else {
      db.prepare('UPDATE users SET location_geocode_status = ? WHERE id = ?').run(result.status, row.id);
      stats.usersFailed++;
    }
    console.log(`user ${row.id}: "${row.location}" -> ${result.status}`);
    await sleep(PACE_MS);
  }
}

async function backfillPickup(table, stats) {
  const rows = db.prepare(
    `SELECT id, pickup_address, pickup_area FROM ${table} WHERE (pickup_address != '' OR pickup_area != '') AND pickup_geocode_status IS NULL LIMIT ?`
  ).all(LIMIT);
  for (const row of rows) {
    stats[`${table}Considered`] = (stats[`${table}Considered`] || 0) + 1;
    const hasAddress = !!(row.pickup_address && row.pickup_address.trim());
    const source = hasAddress ? row.pickup_address : row.pickup_area;
    if (!CONFIRM) { console.log(`[dry-run] would geocode ${table} ${row.id} pickup="${source}" (precision would be ${hasAddress ? 'exact' : 'approximate'})`); continue; }
    const result = await geocodeText(source);
    if (result.status === 'ok') {
      const precision = hasAddress ? 'exact' : 'approximate';
      const pub = hasAddress ? fuzzCoordinate(result.lat, result.lng, 2) : { lat: result.lat, lng: result.lng };
      db.prepare(`UPDATE ${table} SET pickup_lat = ?, pickup_lng = ?, pickup_public_lat = ?, pickup_public_lng = ?, pickup_geo_precision = ?, pickup_geocoded_at = datetime('now'), pickup_geocode_status = 'ok' WHERE id = ?`)
        .run(result.lat, result.lng, pub.lat, pub.lng, precision, row.id);
      stats[`${table}Ok`] = (stats[`${table}Ok`] || 0) + 1;
    } else {
      db.prepare(`UPDATE ${table} SET pickup_geocode_status = ? WHERE id = ?`).run(result.status, row.id);
      stats[`${table}Failed`] = (stats[`${table}Failed`] || 0) + 1;
    }
    console.log(`${table} ${row.id}: "${source}" -> ${result.status}`);
    await sleep(PACE_MS);
  }
}

async function main() {
  if (!isGeocodingConfigured()) {
    console.error('GEOAPIFY_KEY is not set. Refusing to run (even as a dry run) to avoid a misleading "nothing to backfill" result.');
    process.exit(1);
  }
  console.log(CONFIRM ? 'Running LIVE (--confirm passed) — this will write to the database.' : 'Running as a DRY RUN — nothing will be written. Pass --confirm to actually geocode.');
  if (limitArg) console.log(`Row limit for this run: ${LIMIT}`);

  const stats = { usersConsidered: 0, usersOk: 0, usersFailed: 0 };
  await backfillUsers(stats);
  await backfillPickup('items', stats);
  await backfillPickup('request_offers', stats);

  console.log('\n=== Backfill summary ===');
  console.log(JSON.stringify(stats, null, 2));
  if (!CONFIRM) console.log('\nThis was a dry run — nothing was written. Re-run with --confirm to actually geocode these rows.');
}

main().catch(err => { console.error('Backfill script crashed:', err); process.exit(1); });
