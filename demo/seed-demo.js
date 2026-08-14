// Populates demo/demo.sqlite with a realistic, fully-populated version of the site: users,
// listings (with real sample photos), requests, completed exchanges, ratings, reports in every
// status, and admin moderation actions.
//
// How it works: this script starts the REAL server.js (unmodified) pointed at demo/demo.sqlite
// and demo/uploads via env vars, then drives it entirely through its normal HTTP API — the exact
// same signup/post/claim/confirm/rate/report/ban code paths a real user or admin hits. Nothing
// here reimplements or duplicates any business logic, so the seed data can never drift out of
// sync with how the app actually behaves.
//
// Safe to run any time: it only ever touches demo/demo.sqlite and demo/uploads, never the real
// data.sqlite or public/uploads. Run directly with `npm run demo:seed`, or via `npm run demo:reset`
// which wipes and re-runs this first.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.DEMO_PORT || '3300';
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@demo.reusehub.local';
const DEMO_PASSWORD = 'Demo@1234';

function log(msg) { console.log(msg); }

// ---------- tiny HTTP helper (native fetch, manual per-user cookie handling) ----------
function extractTokenCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  for (const c of raw) {
    const m = /(?:^|;\s*)token=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function call(token, method, urlPath, body, isForm) {
  const headers = {};
  if (token) headers['Cookie'] = 'token=' + token;
  let fetchBody;
  if (isForm) {
    fetchBody = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  const res = await fetch(BASE + urlPath, { method, headers, body: fetchBody });
  const newToken = extractTokenCookie(res);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    console.error(`  ! ${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return { ok: res.ok, status: res.status, data, token: newToken };
}

// ---------- user registry ----------
const users = {}; // handle -> { id, email, token }

async function signup(handle, name, email, account_type, location) {
  const r = await call(null, 'POST', '/api/signup', { name, email, password: DEMO_PASSWORD, account_type, location });
  if (!r.ok) throw new Error(`signup failed for ${handle}`);
  users[handle] = { id: r.data.id, email, token: r.token };
  log(`  + signed up ${name} (${handle})`);
  return users[handle];
}

function u(handle) { return users[handle]; }

// ---------- date helpers ----------
// Deliberately built from UTC getters, not local ones — the DB's own datetime('now') comparisons
// are UTC, so this guarantees the deadline is genuinely in the future no matter what timezone this
// script happens to run in.
function futureDateTimeUTC(hoursFromNow) {
  const d = new Date(Date.now() + hoursFromNow * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---------- item / request helpers ----------
const PHOTOS_DIR = path.join(__dirname, 'sample-photos');

async function postItem(handle, fields, photoFile) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (photoFile) {
    const buf = fs.readFileSync(path.join(PHOTOS_DIR, photoFile));
    fd.append('media', new Blob([buf], { type: 'image/jpeg' }), photoFile);
  }
  const r = await call(u(handle).token, 'POST', '/api/items', fd, true);
  if (!r.ok) throw new Error(`postItem failed: ${fields.title}`);
  log(`  + ${handle} posted item "${fields.title}"`);
  return r.data;
}

async function postRequest(handle, fields) {
  const r = await call(u(handle).token, 'POST', '/api/requests', fields);
  if (!r.ok) throw new Error(`postRequest failed: ${fields.title}`);
  log(`  + ${handle} posted request "${fields.title}"`);
  return r.data;
}

async function claimItem(handle, itemId, message) {
  const r = await call(u(handle).token, 'POST', `/api/items/${itemId}/claim`, { message });
  if (!r.ok) throw new Error(`claim failed`);
  return r.data.id;
}

async function acceptClaim(ownerHandle, claimId) {
  const r = await call(u(ownerHandle).token, 'PATCH', `/api/claims/${claimId}`, { status: 'accepted' });
  if (!r.ok) throw new Error('accept claim failed');
}

async function confirmClaim(handle, claimId) {
  const r = await call(u(handle).token, 'POST', `/api/claims/${claimId}/confirm`, { confirmed: true });
  if (!r.ok) throw new Error('confirm claim failed');
  return r.data;
}

async function respondToRequest(handle, requestId, fields) {
  const r = await call(u(handle).token, 'POST', `/api/requests/${requestId}/respond`, fields);
  if (!r.ok) throw new Error('respond failed');
  return r.data.id;
}

async function acceptOffer(ownerHandle, offerId) {
  const r = await call(u(ownerHandle).token, 'PATCH', `/api/request-offers/${offerId}`, { status: 'accepted' });
  if (!r.ok) throw new Error('accept offer failed');
}

async function confirmOffer(handle, offerId) {
  const r = await call(u(handle).token, 'POST', `/api/request-offers/${offerId}/confirm`, { confirmed: true });
  if (!r.ok) throw new Error('confirm offer failed');
  return r.data;
}

async function rate(handle, exchange_type, exchange_id, stars, tags, comment) {
  const r = await call(u(handle).token, 'POST', '/api/ratings', { exchange_type, exchange_id, stars, tags, comment });
  if (!r.ok) throw new Error('rate failed');
  return r.data.id;
}

async function report(handle, target_type, target_id, reason) {
  const r = await call(u(handle).token, 'POST', '/api/reports', { target_type, target_id, reason });
  if (!r.ok) throw new Error('report failed');
  // The endpoint deliberately doesn't echo back the new report's id (matches its real response
  // shape — real callers never need it) — look it up via the admin queue instead of guessing.
  const list = await call(u('admin').token, 'GET', '/api/admin/reports?status=open');
  const match = (list.data || []).find(rep => rep.target_type === target_type && rep.target_id === target_id && rep.reason === reason);
  if (!match) throw new Error(`could not locate newly created report (${target_type}:${target_id})`);
  return match.id;
}

async function resolveReport(reportId, status, note) {
  const r = await call(u('admin').token, 'PATCH', `/api/admin/reports/${reportId}`, { status, note });
  if (!r.ok) throw new Error('resolve report failed');
}

async function adminCloseItem(itemId, note) {
  const r = await call(u('admin').token, 'PATCH', `/api/admin/items/${itemId}/close`, { note });
  if (!r.ok) throw new Error('admin close item failed');
}

async function adminBanUser(userId, reason) {
  const r = await call(u('admin').token, 'POST', `/api/admin/users/${userId}/ban`, { reason });
  if (!r.ok) throw new Error('ban failed');
}

// ---------- full two-sided completion for a claim ----------
async function completeClaimExchange(giverHandle, receiverHandle, itemId) {
  const claimId = await claimItem(receiverHandle, itemId, "Hi! I'd love to take this off your hands.");
  await acceptClaim(giverHandle, claimId);
  await confirmClaim(receiverHandle, claimId);
  await confirmClaim(giverHandle, claimId);
  return claimId;
}

async function completeOfferExchange(requesterHandle, responderHandle, requestId, offerFields) {
  const offerId = await respondToRequest(responderHandle, requestId, offerFields);
  await acceptOffer(requesterHandle, offerId);
  await confirmOffer(responderHandle, offerId);
  await confirmOffer(requesterHandle, offerId);
  return offerId;
}

// ---------- main seeding sequence ----------
async function seed() {
  log('\n=== ReUse Hub demo seed ===\n');

  log('Creating accounts...');
  await signup('admin', 'Admin', ADMIN_EMAIL, 'individual', 'Pune');
  await signup('rahul', 'Rahul Sharma', 'rahul@demo.reusehub.local', 'individual', 'Koregaon Park, Pune');
  await signup('priya', 'Priya Nair', 'priya@demo.reusehub.local', 'individual', 'Baner, Pune');
  await signup('arjun', 'Arjun Mehta', 'arjun@demo.reusehub.local', 'individual', 'Viman Nagar, Pune');
  await signup('sneha', 'Sneha Kulkarni', 'sneha@demo.reusehub.local', 'individual', 'Kothrud, Pune');
  await signup('amit', 'Amit Deshpande', 'amit@demo.reusehub.local', 'business', 'Hinjewadi, Pune');
  await signup('kavya', 'Kavya Reddy', 'kavya@demo.reusehub.local', 'individual', 'Aundh, Pune');
  await signup('vijay', 'Vijay Patil', 'vijay@demo.reusehub.local', 'individual', 'Wakad, Pune');
  await signup('rohit', 'Rohit Singh', 'rohit@demo.reusehub.local', 'individual', 'Hadapsar, Pune');

  log('\nPosting listings...');
  const table = await postItem('rahul', { title: 'Wooden Dining Table', description: '4-seater, solid wood, minor scratches on top but very sturdy.', category: 'Furniture', condition: 'used', price_type: 'free' }, 'wooden-table.jpg');
  await postItem('rahul', { title: '3-Seater Sofa', description: 'Comfortable fabric sofa, moving out so must go this month.', category: 'Furniture', condition: 'used', price_type: 'exchange', exchange_for: 'A study table or bookshelf' }, 'sofa.jpg');
  const lamp = await postItem('kavya', { title: 'Study Table Lamp', description: 'LED desk lamp with adjustable brightness, barely used.', category: 'Other', condition: 'like_new', price_type: 'paid', price: '300' }, 'study-lamp.jpg');
  const laptop = await postItem('arjun', { title: 'Laptop — Working Condition', description: 'Core i5, 8GB RAM, 256GB SSD. Great for students, battery holds ~3hrs.', category: 'Computers & Laptops', condition: 'used', price_type: 'paid', price: '8000' }, 'laptop.jpg');
  const books = await postItem('priya', { title: 'Engineering Book Set', description: 'First-year engineering textbooks, all in good condition, no torn pages.', category: 'Books & Media', condition: 'used', price_type: 'free' }, 'bookset.jpg');
  const biryani = await postItem('sneha', { title: 'Veg Biryani — Surplus', description: 'Extra biryani from a family event today, freshly made, still warm. Please pick up soon!', category: 'Food (Surplus)', condition: 'new', price_type: 'free', is_edible_food: 'true', available_until: futureDateTimeUTC(6), is_urgent: 'true', food_pref: 'vegetarian' }, 'veg-biryani.jpg');
  await postItem('sneha', { title: 'Fresh Fruit Basket', description: 'Bought too much for a gathering — apples, bananas, oranges, all fresh.', category: 'Food (Surplus)', condition: 'new', price_type: 'free', is_edible_food: 'true', available_until: futureDateTimeUTC(30), food_pref: 'mixed' }, 'fruit-basket.jpg');
  await postItem('amit', { title: 'Office Chairs x10', description: 'Office relocating — 10 ergonomic chairs in good condition, available for pickup.', category: 'Office Furniture & Fixtures', condition: 'used', price_type: 'free', listing_type: 'business_waste' }, 'office-chairs.jpg');
  await postItem('amit', { title: 'CNC Metal Scrap', description: 'Clean metal scrap/offcuts from CNC machining, sorted, roughly 200kg.', category: 'Metal Scrap (CNC/Machining)', condition: 'used', price_type: 'free', listing_type: 'business_waste', is_urgent: 'true' }, 'metal-scrap.jpg');
  const mixer = await postItem('kavya', { title: 'Kitchen Mixer Grinder', description: 'Works perfectly, upgrading to a bigger one. Comes with 2 jars.', category: 'Kitchen & Appliances', condition: 'used', price_type: 'free' }, 'kitchen-mixer.jpg');
  const toys = await postItem('vijay', { title: 'Kids Toy Set', description: 'Assorted toys, my kids have outgrown them. All working, no broken pieces.', category: 'Toys & Kids', condition: 'used', price_type: 'free' }, 'kids-toys.jpg');
  const tools = await postItem('rohit', { title: 'Hand Tool Kit', description: 'Basic hand tool kit — hammer, screwdrivers, wrench set, pliers.', category: 'Tools & Equipment', condition: 'used', price_type: 'free' }, 'tool-kit.jpg');

  log('\nPosting requests...');
  const studyTableReq = await postRequest('priya', { title: 'Need a study table for my daughter', description: "She's starting school this year and I'd love a simple study table, any condition.", request_type: 'thing', category: 'Furniture', budget_type: 'free' });
  const movingReq = await postRequest('arjun', { title: 'Need help moving furniture this weekend', description: 'Moving to a new flat, need a hand carrying a sofa and a couple of boxes down two floors.', request_type: 'service', category: 'Delivery', budget_type: 'paid', budget_amount: '500' });
  const tutorReq = await postRequest('kavya', { title: 'Looking for a good tutor for my son, Class 8 Maths', description: 'Twice a week, evenings preferred. Someone patient and nearby Aundh.', request_type: 'service', category: 'Tutor', budget_type: 'paid', budget_amount: '1000' });

  log('\nRunning exchanges through to completion + ratings...');
  const claim1 = await completeClaimExchange('priya', 'arjun', books.id);
  await rate('arjun', 'claim', claim1, 5, ['item_as_described', 'good_communication'], 'Books were exactly as described, great seller!');
  await rate('priya', 'claim', claim1, 5, ['smooth_handover'], 'Quick and easy pickup, thanks!');

  const claim2 = await completeClaimExchange('kavya', 'rahul', mixer.id);
  await rate('rahul', 'claim', claim2, 5, ['item_as_described'], 'Works perfectly, very responsive!');

  const claim3 = await completeClaimExchange('kavya', 'priya', lamp.id);
  await rate('priya', 'claim', claim3, 5, ['good_communication', 'smooth_handover'], 'Kavya is wonderful to deal with, highly recommend!');

  const claim4 = await completeClaimExchange('sneha', 'vijay', biryani.id);
  await rate('vijay', 'claim', claim4, 5, ['smooth_handover'], 'Saved this food from going to waste, thank you!');

  const claim5 = await completeClaimExchange('arjun', 'rahul', laptop.id);
  await rate('rahul', 'claim', claim5, 4, ['item_as_described'], 'Good laptop, minor scratches not mentioned.');
  await rate('arjun', 'claim', claim5, 5, ['good_communication'], 'Smooth transaction, thanks!');

  const offer1 = await completeOfferExchange('priya', 'rahul', studyTableReq.id, { message: 'I have a spare study table, happy to bring it over.', pickup_type: 'my_address' });
  await rate('priya', 'offer', offer1, 5, ['smooth_handover'], 'Delivered on time, great communication!');
  await rate('rahul', 'offer', offer1, 5, ['good_communication'], 'Very sweet, thank you!');

  const offer2 = await completeOfferExchange('arjun', 'vijay', movingReq.id, { message: 'I can help this Saturday morning.', pickup_type: 'custom' });
  const disputedRatingId = await rate('arjun', 'offer', offer2, 3, [], 'Ok but showed up quite late.');
  await rate('vijay', 'offer', offer2, 5, ['good_communication'], 'Got it done, thanks!');

  log('\nCreating reports + running moderation actions...');
  // Left OPEN deliberately — gives the admin dashboard at least one still-pending item to
  // demonstrate the queue, not just a fully-cleared history.
  await report('priya', 'user', u('vijay').id, 'Vijay was rude and unresponsive after accepting, wasted my time.');

  const rep2Id = await report('rahul', 'item', toys.id, "Description doesn't match photos, seems off.");
  await resolveReport(rep2Id, 'dismissed', 'Reviewed — listing appears legitimate.');

  const rep3Id = await report('vijay', 'rating', disputedRatingId, 'This rating is unfair, I was only 10 minutes late due to traffic.');
  await resolveReport(rep3Id, 'resolved', 'Rating reviewed and left as-is per policy; thanks for the context.');

  const rep4Id = await report('amit', 'item', tools.id, 'Seller asked to pay outside the platform, feels like a scam.');
  // Investigate + act on this one: close the listing and ban Rohit, then resolve the report.
  await adminCloseItem(tools.id, 'Closed pending investigation into off-platform payment request.');
  await adminBanUser(u('rohit').id, 'Attempted to solicit off-platform payment, in violation of platform trust & safety policy.');
  await resolveReport(rep4Id, 'resolved', 'Investigated and confirmed — listing closed and account suspended.');

  const rep5Id = await report('rahul', 'request', tutorReq.id, 'Looks like a duplicate/spam posting.');
  await resolveReport(rep5Id, 'dismissed', 'Not spam — legitimate request, left active.');

  log('\n=== Seed complete ===\n');
  log('Log in as any of these at ' + BASE + ' — password for every account is: ' + DEMO_PASSWORD + '\n');
  const roster = [
    ['admin@demo.reusehub.local', 'Admin — full moderation dashboard access'],
    ['rahul@demo.reusehub.local', 'Rahul Sharma — regular user, a few completed exchanges'],
    ['priya@demo.reusehub.local', 'Priya Nair — regular user, posted a request that got fulfilled'],
    ['arjun@demo.reusehub.local', 'Arjun Mehta — active trader, several completed exchanges both ways'],
    ['sneha@demo.reusehub.local', 'Sneha Kulkarni — Food Rescue poster'],
    ['amit@demo.reusehub.local', 'Amit Deshpande — business account, Business Surplus listings'],
    ['kavya@demo.reusehub.local', 'Kavya Reddy — highly rated (multiple 5-star reviews)'],
    ['vijay@demo.reusehub.local', 'Vijay Patil — has an open report against him, plus a disputed rating'],
    ['rohit@demo.reusehub.local', 'Rohit Singh — BANNED (try logging in to see the suspension message)'],
  ];
  for (const [email, desc] of roster) log(`  ${email.padEnd(32)} ${desc}`);
  log('');
}

// ---------- process orchestration ----------
async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE + '/api/me');
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const demoDbRelative = 'demo/demo.sqlite';
  const demoUploadRelative = 'demo/uploads';
  fs.mkdirSync(path.join(ROOT, 'demo'), { recursive: true });

  log(`Starting server on port ${PORT} against ${demoDbRelative} ...`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_FILE: demoDbRelative, UPLOAD_DIR: demoUploadRelative, PORT, ADMIN_EMAILS: ADMIN_EMAIL },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    const ready = await waitForServer(15000);
    if (!ready) {
      console.error('Server did not start in time. Output so far:\n' + serverOutput);
      process.exitCode = 1;
      return;
    }
    await seed();
  } catch (e) {
    console.error('\nSeeding failed:', e.message);
    console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main();
