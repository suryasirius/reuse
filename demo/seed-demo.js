// Populates demo/demo.sqlite with a large, realistic, fully-populated version of the site: many
// users, listings across every category (with real sample photos where a matching one exists),
// requests, completed exchanges, ratings, still-pending claims/offers, reports in every status,
// and admin moderation actions.
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
//
// Volume: randomized within this run (see RNG seed below) but always lands in realistic ranges —
// ~45 listings across every consumer + business category, ~14 requests, ~28 completed exchanges
// with ratings, plus several still-pending claims/offers so the moderation/inbox views aren't
// only ever showing fully-resolved history.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.DEMO_PORT || '3300';
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@demo.zineedo.local';
const DEMO_PASSWORD = 'Demo@1234';

function log(msg) { console.log(msg); }

// ---------- deterministic-ish RNG (seeded) ----------
// Plain Math.random() would make every reseed produce a different, unreproducible dataset --
// annoying when debugging a specific demo scenario. A small seeded LCG keeps the run repeatable
// (same seed -> same dataset) while still giving genuinely varied, "random-looking" data. Change
// SEED below (or set DEMO_SEED env var) to get a different dataset on demand.
let _seed = Number(process.env.DEMO_SEED || 20260926);
function rand() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function pickN(arr, n) {
  const pool = [...arr]; const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}
function randInt(min, max) { return min + Math.floor(rand() * (max - min + 1)); }
function chance(p) { return rand() < p; }

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
  users[handle] = { id: r.data.id, email, token: r.token, handle };
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
  log(`  + ${handle} posted item "${fields.title}"${photoFile ? ' [photo]' : ''}`);
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

async function declineClaim(ownerHandle, claimId) {
  const r = await call(u(ownerHandle).token, 'PATCH', `/api/claims/${claimId}`, { status: 'declined' });
  if (!r.ok) throw new Error('decline claim failed');
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

async function report(handle, target_type, target_id, category, reason) {
  const r = await call(u(handle).token, 'POST', '/api/reports', { target_type, target_id, category, reason });
  if (!r.ok) throw new Error('report failed');
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

async function completeClaimExchange(giverHandle, receiverHandle, itemId, message) {
  const claimId = await claimItem(receiverHandle, itemId, message || "Hi! I'd love to take this off your hands.");
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

// ---------- rating flavor pools (picked at random per completed exchange) ----------
const POSITIVE_TAGS = ['item_as_described', 'good_communication', 'smooth_handover', 'on_time', 'friendly'];
const POSITIVE_COMMENTS = [
  'Exactly as described, smooth pickup, thank you!',
  'Great experience, would deal with again.',
  'Very responsive and easy to coordinate with.',
  'Item was in better condition than expected!',
  'Quick reply and hassle-free handover.',
  'Really appreciate this, saved me a trip to the store.',
  'Everything went smoothly, thanks so much.',
  'Kind and punctual, no complaints at all.',
];
const MIXED_COMMENTS = [
  'Good overall, showed up a little later than planned.',
  'Item was fine, minor wear not mentioned upfront.',
  'Communication could have been quicker but got there in the end.',
];

function randomPositiveRating() {
  return { stars: randInt(4, 5), tags: pickN(POSITIVE_TAGS, randInt(1, 3)), comment: pick(POSITIVE_COMMENTS) };
}
function randomMixedRating() {
  return { stars: 3, tags: [], comment: pick(MIXED_COMMENTS) };
}

// ---------- main seeding sequence ----------
async function seed() {
  log('\n=== Zineedo demo seed (large dataset, seed=' + _seed + ') ===\n');

  log('Creating accounts...');
  await signup('admin', 'Admin', ADMIN_EMAIL, 'individual', 'Pune');
  const peopleRoster = [
    ['rahul', 'Rahul Sharma', 'individual', 'Koregaon Park, Pune'],
    ['priya', 'Priya Nair', 'individual', 'Baner, Pune'],
    ['arjun', 'Arjun Mehta', 'individual', 'Viman Nagar, Pune'],
    ['sneha', 'Sneha Kulkarni', 'individual', 'Kothrud, Pune'],
    ['amit', 'Amit Deshpande', 'business', 'Hinjewadi, Pune'],
    ['kavya', 'Kavya Reddy', 'individual', 'Aundh, Pune'],
    ['vijay', 'Vijay Patil', 'individual', 'Wakad, Pune'],
    ['rohit', 'Rohit Singh', 'individual', 'Hadapsar, Pune'],
    ['neha', 'Neha Joshi', 'individual', 'Kharadi, Pune'],
    ['suresh', 'Suresh Iyer', 'individual', 'Yerawada, Pune'],
    ['divya', 'Divya Rao', 'individual', 'Shivajinagar, Pune'],
    ['karan', 'Karan Malhotra', 'individual', 'Magarpatta, Pune'],
    ['meera', 'Meera Pillai', 'individual', 'Wagholi, Pune'],
    ['anil', 'Anil Kumar', 'individual', 'Katraj, Pune'],
    ['rajesh', 'Rajesh Industries', 'business', 'Chakan MIDC, Pune'],
    ['pooja', 'Pooja Bhatia', 'individual', 'Camp, Pune'],
  ];
  for (const [handle, name, type, loc] of peopleRoster) await signup(handle, name, `${handle}@demo.zineedo.local`, type, loc);

  const individuals = peopleRoster.filter(p => p[2] === 'individual').map(p => p[0]);
  const businesses = peopleRoster.filter(p => p[2] === 'business').map(p => p[0]);
  const everyone = [...individuals, ...businesses];

  function otherThan(handle) { return pick(everyone.filter(h => h !== handle)); }

  log('\nPosting listings (Give & Take)...');
  const CONSUMER_SPECS = [
    { category: 'Furniture', title: 'Wooden Dining Table', description: '4-seater, solid wood, minor scratches on top but very sturdy.', photo: 'wooden-dining-table.jpg' },
    { category: 'Furniture', title: '3-Seater Sofa', description: 'Comfortable fabric sofa, moving out so must go this month.', photo: '3-seater-sofa.jpg', priceType: 'exchange', exchangeFor: 'A study table or bookshelf' },
    { category: 'Furniture', title: 'Study Table + Chair Set', description: 'Compact study table with matching chair, great for a small room.', photo: 'study-table---chair-set.jpg' },
    { category: 'Food (Surplus)', title: 'Veg Biryani — Surplus', description: 'Extra biryani from a family event today, freshly made, still warm. Please pick up soon!', photo: 'veg-biryani---surplus.jpg', edible: true, urgentHours: 6 },
    { category: 'Food (Surplus)', title: 'Fresh Fruit Basket', description: 'Bought too much for a gathering — apples, bananas, oranges, all fresh.', photo: 'fresh-fruit-basket.jpg', edible: true, urgentHours: 30 },
    { category: 'Food (Surplus)', title: 'Homemade Sweets Box', description: 'Leftover mithai from Diwali, sealed box, best eaten within 2 days.', photo: 'homemade-sweets-box.jpg', edible: true, urgentHours: 40 },
    { category: 'Electronics & Phones', title: 'Old Android Phone', description: 'Works fine, screen has a small crack in the corner, comes with charger.', photo: 'old-android-phone.jpg' },
    { category: 'Electronics & Phones', title: 'Bluetooth Speaker', description: 'Portable speaker, good bass, battery lasts about 5 hours.', photo: 'bluetooth-speaker.jpg' },
    { category: 'Computers & Laptops', title: 'Laptop — Working Condition', description: 'Core i5, 8GB RAM, 256GB SSD. Great for students, battery holds ~3hrs.', photo: 'laptop---working-condition.jpg' },
    { category: 'Computers & Laptops', title: 'USB Keyboard + Mouse Combo', description: 'Barely used, upgraded to wireless. Both in great condition.', photo: 'usb-keyboard---mouse-combo.jpg' },
    { category: 'Education & School Supplies', title: 'Engineering Book Set', description: 'First-year engineering textbooks, all in good condition, no torn pages.', photo: 'engineering-book-set.jpg' },
    { category: 'Education & School Supplies', title: 'School Bag + Stationery Set', description: 'Barely used school bag with a full stationery kit, good for a young student.', photo: 'school-bag---stationery-set.jpg' },
    { category: 'Construction Materials', title: 'Leftover Ceramic Tiles', description: 'About 15 sq. ft. of leftover tiles from a bathroom renovation, single batch.', photo: 'leftover-ceramic-tiles.jpg' },
    { category: 'Baby & Kids', title: 'Kids Toy Set', description: 'Assorted toys, my kids have outgrown them. All working, no broken pieces.', photo: 'kids-toy-set.jpg' },
    { category: 'Baby & Kids', title: 'Baby Stroller', description: 'Lightweight foldable stroller, used for about a year, still sturdy.', photo: 'baby-stroller.jpg' },
    { category: 'Kitchen & Appliances', title: 'Kitchen Mixer Grinder', description: 'Works perfectly, upgrading to a bigger one. Comes with 2 jars.', photo: 'kitchen-mixer-grinder.jpg' },
    { category: 'Kitchen & Appliances', title: 'Electric Kettle', description: 'Auto shut-off kettle, used daily until recently, no issues.', photo: 'electric-kettle.jpg' },
    { category: 'Clothing & Accessories', title: 'Winter Jacket Bundle', description: 'A few winter jackets, mixed sizes, gently used, freshly washed.', photo: 'winter-jacket-bundle.jpg' },
    { category: 'Tools & Equipment', title: 'Hand Tool Kit', description: 'Basic hand tool kit — hammer, screwdrivers, wrench set, pliers.', photo: 'hand-tool-kit.jpg' },
    { category: 'Tools & Equipment', title: 'Cordless Drill', description: 'Works well, comes with two batteries and a charger.', photo: 'cordless-drill.jpg' },
    { category: 'Books & Media', title: 'Novel Collection (20 books)', description: 'Mixed fiction novels, good condition, great for a weekend read.', photo: 'novel-collection--20-books.jpg' },
    { category: 'Vehicles', title: "Kid's Bicycle", description: 'For ages 6-9, a few scuffs but rides great, recently serviced.', photo: 'kid-s-bicycle.jpg' },
    { category: 'Event Items & Decorations', title: 'Birthday Decoration Set', description: 'Balloons, banners and lights from a recent party, used once.', photo: 'birthday-decoration-set.jpg' },
    { category: 'Other', title: 'Study Table Lamp', description: 'LED desk lamp with adjustable brightness, barely used.', photo: 'study-table-lamp.jpg' },
    { category: 'Other', title: 'Yoga Mat + Blocks', description: 'Barely used yoga mat with two foam blocks, non-slip surface.', photo: 'yoga-mat---blocks.jpg' },
  ];

  const BUSINESS_SPECS = [
    { category: 'Office Furniture & Fixtures', title: 'Office Chairs x10', description: 'Office relocating — 10 ergonomic chairs in good condition, available for pickup.', photo: 'office-chairs-x10.jpg' },
    { category: 'Office Furniture & Fixtures', title: 'Reception Desk', description: 'L-shaped reception desk, minor wear, from a recently closed branch.', photo: 'reception-desk.jpg' },
    { category: 'Electronics & IT Equipment', title: 'Old Desktop Monitors x6', description: '19-inch monitors, all power on and display fine, decommissioned during an upgrade.', photo: 'old-desktop-monitors-x6.jpg' },
    { category: 'Business Equipment & Machinery', title: 'Industrial Sewing Machine', description: 'Used, in working condition, replaced with a newer model.', photo: 'industrial-sewing-machine.jpg' },
    { category: 'Packaging Material', title: 'Cardboard Boxes (bulk)', description: 'Assorted sizes, used once for inbound shipments, still sturdy.', photo: 'cardboard-boxes--bulk.jpg' },
    { category: 'Retail / Event Surplus', title: 'Display Shelving Units', description: 'Retail shelving from a store refit, good condition, various sizes.', photo: 'display-shelving-units.jpg' },
    { category: 'Metal Scrap (CNC/Machining)', title: 'CNC Metal Scrap', description: 'Clean metal scrap/offcuts from CNC machining, sorted, roughly 200kg.', photo: 'cnc-metal-scrap.jpg', urgentHours: null },
    { category: 'Metal Scrap (CNC/Machining)', title: 'Aluminum Turnings', description: 'Clean aluminum turnings from a machining run, dry and sorted.', photo: 'aluminum-turnings.jpg' },
    { category: 'Wood Scrap & Sawdust', title: 'Sawdust — Bulk Bags', description: 'Fine sawdust from a woodworking shop, several bags available, dry storage.', photo: 'sawdust---bulk-bags.jpg' },
    { category: 'Fabric & Textile Scrap', title: 'Textile Offcuts', description: 'Mixed cotton offcuts from a garment unit, clean and sorted by size.', photo: 'textile-offcuts.jpg' },
    { category: 'Other Industrial Byproduct', title: 'Rubber Trimmings', description: 'Rubber trimmings from a manufacturing line, dry and bagged.', photo: 'rubber-trimmings.jpg' },
    { category: 'Cow Dung & Manure', title: 'Cow Dung — Farm Surplus', description: 'Surplus cow dung from our dairy operation, good for composting.', photo: 'cow-dung---farm-surplus.jpg' },
    { category: 'Used Cooking Oil', title: 'Used Cooking Oil (bulk)', description: 'Filtered used cooking oil from our kitchen, collected weekly.', photo: 'used-cooking-oil--bulk.jpg' },
    { category: 'Food & Organic Waste', title: 'Vegetable Trimmings (bulk)', description: 'Daily vegetable trimmings from our kitchen, good for composting or feed.', photo: 'vegetable-trimmings--bulk.jpg' },
    { category: 'Paper & Cardboard Waste', title: 'Office Paper Waste (bulk)', description: 'Shredded and loose paper waste from our office, collected monthly.', photo: 'office-paper-waste--bulk.jpg' },
    { category: 'Plastic Scrap', title: 'PET Bottle Scrap (bulk)', description: 'Clean, sorted PET bottle scrap from our packaging line.', photo: 'pet-bottle-scrap--bulk.jpg' },
    { category: 'Construction Debris', title: 'Mixed Construction Debris', description: 'Leftover debris from a small renovation — bricks, tile offcuts, minor rubble.', photo: 'mixed-construction-debris.jpg' },
  ];

  const postedConsumer = [];
  for (const spec of CONSUMER_SPECS) {
    const owner = pick(individuals);
    const fields = {
      title: spec.title, description: spec.description, category: spec.category,
      condition: pick(['new', 'like_new', 'used']),
      price_type: spec.priceType || pick(['free', 'free', 'free', 'paid', 'exchange']),
      listing_type: 'consumer',
    };
    if (fields.price_type === 'paid') fields.price = String(randInt(150, 9000));
    if (fields.price_type === 'exchange') fields.exchange_for = spec.exchangeFor || 'Open to offers, message me with what you have.';
    if (spec.edible) {
      fields.is_edible_food = 'true';
      fields.available_until = futureDateTimeUTC(spec.urgentHours || 24);
      fields.food_pref = pick(['vegetarian', 'mixed', 'vegan']);
      if (chance(0.5)) fields.is_urgent = 'true';
    } else if (chance(0.15)) {
      fields.is_urgent = 'true';
    }
    const item = await postItem(owner, fields, spec.photo || undefined);
    postedConsumer.push({ ...item, owner, category: spec.category });
  }

  log('\nPosting listings (Business Surplus)...');
  const postedBusiness = [];
  for (const spec of BUSINESS_SPECS) {
    const owner = pick(businesses.length ? businesses : ['amit']);
    const fields = {
      title: spec.title, description: spec.description, category: spec.category,
      condition: pick(['new', 'used']),
      price_type: pick(['free', 'free', 'paid']),
      listing_type: 'business_waste',
    };
    if (fields.price_type === 'paid') fields.price = String(randInt(500, 15000));
    if (chance(0.2)) fields.is_urgent = 'true';
    const item = await postItem(owner, fields, spec.photo || undefined);
    postedBusiness.push({ ...item, owner, category: spec.category });
  }

  const allItems = [...postedConsumer, ...postedBusiness];

  log('\nPosting requests...');
  const REQUEST_SPECS = [
    { owner: 'priya', title: 'Need a study table for my daughter', description: "She's starting school this year and I'd love a simple study table, any condition.", type: 'thing', category: 'Furniture', budgetType: 'free' },
    { owner: 'arjun', title: 'Need help moving furniture this weekend', description: 'Moving to a new flat, need a hand carrying a sofa and a couple of boxes down two floors.', type: 'service', category: 'Delivery', budgetType: 'paid', budget: 500 },
    { owner: 'kavya', title: 'Looking for a good tutor for my son, Class 8 Maths', description: 'Twice a week, evenings preferred. Someone patient and nearby Aundh.', type: 'service', category: 'Tutor', budgetType: 'paid', budget: 1000 },
    { owner: 'neha', title: 'Looking for a working microwave', description: 'Any condition is fine, just needs to heat food properly.', type: 'thing', category: 'Kitchen & Appliances', budgetType: 'free' },
    { owner: 'suresh', title: 'Need a plumber for a leaking tap', description: 'Kitchen tap has been leaking for a week, needs a quick fix.', type: 'service', category: 'Plumber', budgetType: 'paid', budget: 400 },
    { owner: 'divya', title: 'Want to borrow/take a bookshelf', description: 'Small bookshelf for a home office corner, any style works.', type: 'thing', category: 'Furniture', budgetType: 'exchange', exchangeFor: 'A box of assorted paperbacks' },
    { owner: 'karan', title: 'Need an electrician for a socket install', description: 'Two new sockets needed in a home office, straightforward job.', type: 'service', category: 'Electrician', budgetType: 'paid', budget: 600 },
    { owner: 'meera', title: 'Looking for kids clothes, age 4-5', description: 'My daughter is growing fast, happy to take any gently used clothes.', type: 'thing', category: 'Baby & Kids', budgetType: 'free' },
    { owner: 'anil', title: 'Need a cleaner for a one-time deep clean', description: 'Moving out soon, need a thorough one-time clean of a 2BHK.', type: 'service', category: 'Cleaning', budgetType: 'paid', budget: 1500 },
    { owner: 'pooja', title: 'Want a working desktop or laptop for my son', description: 'For online classes, any working condition is appreciated.', type: 'thing', category: 'Computers & Laptops', budgetType: 'free' },
    { owner: 'rohit', title: 'Looking for a carpenter for a small repair', description: 'A cupboard hinge needs fixing, small job.', type: 'service', category: 'Carpenter', budgetType: 'paid', budget: 350 },
    { owner: 'vijay', title: 'Need packing boxes for a move', description: 'Moving in two weeks, looking for sturdy used boxes, any size.', type: 'thing', category: 'Other', budgetType: 'free' },
    { owner: 'rahul', title: 'Looking for a photographer for a small event', description: 'Small family function, need a couple hours of coverage.', type: 'service', category: 'Photography', budgetType: 'paid', budget: 2000 },
    { owner: 'sneha', title: 'Want a working fridge, small size', description: 'For a small kitchen, any brand, just needs to actually cool.', type: 'thing', category: 'Kitchen & Appliances', budgetType: 'free' },
  ];

  const postedRequests = [];
  for (const spec of REQUEST_SPECS) {
    const fields = {
      title: spec.title, description: spec.description, request_type: spec.type, category: spec.category,
      budget_type: spec.budgetType,
    };
    if (spec.budgetType === 'paid') fields.budget_amount = String(spec.budget);
    if (spec.budgetType === 'exchange') fields.exchange_for = spec.exchangeFor;
    if (chance(0.15)) fields.is_urgent = 'true';
    const reqObj = await postRequest(spec.owner, fields);
    postedRequests.push({ ...reqObj, owner: spec.owner });
  }

  log('\nRunning claim exchanges through to completion + ratings...');
  // Complete roughly 60% of consumer items via a claim; the rest stay live/browsable so the site
  // isn't ONLY full of completed history.
  const consumerToComplete = pickN(postedConsumer, Math.round(postedConsumer.length * 0.6));
  let completedClaims = 0;
  for (const item of consumerToComplete) {
    const claimant = otherThan(item.owner);
    const claimId = await completeClaimExchange(item.owner, claimant, item.id);
    completedClaims++;
    const giverRating = chance(0.85) ? randomPositiveRating() : randomMixedRating();
    await rate(claimant, 'claim', claimId, giverRating.stars, giverRating.tags, giverRating.comment);
    if (chance(0.7)) {
      const receiverRating = randomPositiveRating();
      await rate(item.owner, 'claim', claimId, receiverRating.stars, receiverRating.tags, receiverRating.comment);
    }
  }
  log(`  (${completedClaims} claim exchanges completed and rated)`);

  // Business Surplus listings need completed exchanges too, otherwise the Impact Tracker's
  // waste-diverted stat stays at zero and the Business Surplus section never shows any
  // transaction history. Any user (individual or business) can claim a business_waste listing --
  // there's no account_type restriction on claiming, confirmed in server.js.
  const businessToComplete = pickN(postedBusiness, Math.round(postedBusiness.length * 0.5));
  for (const item of businessToComplete) {
    const claimant = otherThan(item.owner);
    const claimId = await completeClaimExchange(item.owner, claimant, item.id, 'Interested in picking this up for our own use — is it still available?');
    completedClaims++;
    const r1 = randomPositiveRating();
    await rate(claimant, 'claim', claimId, r1.stars, r1.tags, r1.comment);
    if (chance(0.6)) {
      const r2 = randomPositiveRating();
      await rate(item.owner, 'claim', claimId, r2.stars, r2.tags, r2.comment);
    }
  }
  log(`  (${businessToComplete.length} of those were Business Surplus listings)`);

  log('\nLeaving a few claims pending / declined for realistic inbox variety...');
  const remainingConsumer = postedConsumer.filter(i => !consumerToComplete.includes(i));
  const pendingPool = pickN(remainingConsumer, Math.min(4, remainingConsumer.length));
  for (const item of pendingPool) {
    const claimant = otherThan(item.owner);
    await claimItem(claimant, item.id, 'Hi, is this still available? I would love to take it.');
  }
  if (remainingConsumer.length > pendingPool.length) {
    const declineTarget = remainingConsumer.find(i => !pendingPool.includes(i));
    if (declineTarget) {
      const claimant = otherThan(declineTarget.owner);
      const claimId = await claimItem(claimant, declineTarget.id, 'Interested — can I pick this up tomorrow?');
      await declineClaim(declineTarget.owner, claimId);
      log('  (one claim was declined, for status variety)');
    }
  }

  log('\nRunning offer exchanges through to completion + ratings...');
  const requestsToComplete = pickN(postedRequests, Math.round(postedRequests.length * 0.55));
  let completedOffers = 0;
  const disputedRatingIds = [];
  for (const reqItem of requestsToComplete) {
    const responder = otherThan(reqItem.owner);
    const offerFields = { message: 'I can help with this — let me know what works for you.', pickup_type: pick(['my_address', 'custom']) };
    const offerId = await completeOfferExchange(reqItem.owner, responder, reqItem.id, offerFields);
    completedOffers++;
    const requesterRating = chance(0.8) ? randomPositiveRating() : randomMixedRating();
    const rId = await rate(reqItem.owner, 'offer', offerId, requesterRating.stars, requesterRating.tags, requesterRating.comment);
    if (requesterRating.stars <= 3) disputedRatingIds.push({ ratingId: rId, aboutHandle: responder });
    if (chance(0.7)) {
      const responderRating = randomPositiveRating();
      await rate(responder, 'offer', offerId, responderRating.stars, responderRating.tags, responderRating.comment);
    }
  }
  log(`  (${completedOffers} offer exchanges completed and rated)`);

  log('\nLeaving a few offers pending for realistic inbox variety...');
  const remainingRequests = postedRequests.filter(r => !requestsToComplete.includes(r));
  const pendingOfferPool = pickN(remainingRequests, Math.min(3, remainingRequests.length));
  for (const reqItem of pendingOfferPool) {
    const responder = otherThan(reqItem.owner);
    await respondToRequest(responder, reqItem.id, { message: 'I can take care of this, happy to discuss details.', pickup_type: 'custom' });
  }

  log('\nCreating reports + running moderation actions...');
  // Left OPEN deliberately — gives the admin dashboard at least one still-pending item to
  // demonstrate the queue, not just a fully-cleared history.
  await report('priya', 'user', u('vijay').id, 'harassment', 'Vijay was rude and unresponsive after accepting, wasted my time.');

  const toolsListing = allItems.find(i => i.title === 'Hand Tool Kit') || postedConsumer[0];
  const rep2Id = await report('rahul', 'item', toolsListing.id, 'inappropriate_content', "Description doesn't match photos, seems off.");
  await resolveReport(rep2Id, 'dismissed', 'Reviewed — listing appears legitimate.');

  if (disputedRatingIds.length) {
    const disputed = disputedRatingIds[0];
    const rep3Id = await report(disputed.aboutHandle, 'rating', disputed.ratingId, 'other', 'This rating is unfair, there was a reasonable delay due to traffic.');
    await resolveReport(rep3Id, 'resolved', 'Rating reviewed and left as-is per policy; thanks for the context.');
  }

  const rep4Id = await report('amit', 'item', toolsListing.id, 'scam_fraud', 'Seller asked to pay outside the platform, feels like a scam.');
  await adminCloseItem(toolsListing.id, 'Closed pending investigation into off-platform payment request.');
  await adminBanUser(u('rohit').id, 'Attempted to solicit off-platform payment, in violation of platform trust & safety policy.');
  await resolveReport(rep4Id, 'resolved', 'Investigated and confirmed — listing closed and account suspended.');

  const tutorReq = postedRequests.find(r => r.title.includes('tutor for my son'));
  if (tutorReq) {
    const rep5Id = await report('rahul', 'request', tutorReq.id, 'suspicious_request', 'Looks like a duplicate/spam posting.');
    await resolveReport(rep5Id, 'dismissed', 'Not spam — legitimate request, left active.');
  }

  log('\n=== Seed complete ===\n');
  log(`Posted ${allItems.length} listings (${postedConsumer.length} Give & Take / Food Rescue, ${postedBusiness.length} Business Surplus), ${postedRequests.length} requests, ${completedClaims + completedOffers} completed exchanges.`);
  log('\nLog in as any of these at ' + BASE + ' — password for every account is: ' + DEMO_PASSWORD + '\n');
  const roster = [
    ['admin@demo.zineedo.local', 'Admin — full moderation dashboard access'],
    ['rahul@demo.zineedo.local', 'Rahul Sharma — regular user'],
    ['priya@demo.zineedo.local', 'Priya Nair — regular user'],
    ['arjun@demo.zineedo.local', 'Arjun Mehta — active trader'],
    ['sneha@demo.zineedo.local', 'Sneha Kulkarni — Food Rescue poster'],
    ['amit@demo.zineedo.local', 'Amit Deshpande — business account, Business Surplus listings'],
    ['kavya@demo.zineedo.local', 'Kavya Reddy — regular user'],
    ['vijay@demo.zineedo.local', 'Vijay Patil — has an open report against him'],
    ['rohit@demo.zineedo.local', 'Rohit Singh — BANNED (try logging in to see the suspension message)'],
    ['neha@demo.zineedo.local', 'Neha Joshi — regular user'],
    ['suresh@demo.zineedo.local', 'Suresh Iyer — regular user'],
    ['divya@demo.zineedo.local', 'Divya Rao — regular user'],
    ['karan@demo.zineedo.local', 'Karan Malhotra — regular user'],
    ['meera@demo.zineedo.local', 'Meera Pillai — regular user'],
    ['anil@demo.zineedo.local', 'Anil Kumar — regular user'],
    ['rajesh@demo.zineedo.local', 'Rajesh Industries — business account, Business Surplus listings'],
    ['pooja@demo.zineedo.local', 'Pooja Bhatia — regular user'],
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
    // DISABLE_RATE_LIMIT=1 is the documented escape hatch (server.js, Phase 8 hardening) for
    // exactly this situation: an automated script making many signups/logins back-to-back, which
    // the real signup/login rate limiters (10/hour, 10/15min) would otherwise correctly block as
    // suspicious. This only affects THIS temporary, internal seeding server process -- the demo
    // server real users interact with (run-demo.js) and the production server are never touched.
    env: { ...process.env, DB_FILE: demoDbRelative, UPLOAD_DIR: demoUploadRelative, PORT, ADMIN_EMAILS: ADMIN_EMAIL, DISABLE_RATE_LIMIT: '1' },
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
