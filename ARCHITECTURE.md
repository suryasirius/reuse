# Zineedo — Architecture

_Last updated: 2026-08-20. This documents the codebase as it exists today — it's a reference, not a plan for changes._

## 1. Stack at a glance

| Layer | Technology |
|---|---|
| Backend | Node.js + Express 5 |
| Database | SQLite (via `better-sqlite3`, synchronous, WAL mode) |
| Auth | Cookie sessions (`sessions` table) + `bcryptjs` password hashing |
| File uploads | `multer` (disk storage, quarantine-first) |
| Frontend | Vanilla JS SPA — no framework, no build step |
| Styling | Single hand-written `styles.css`, CSS custom properties for design tokens |
| Icons | Lucide (loaded from CDN, `lucide.createIcons()` re-run after DOM injection) |

No React/Vue, no bundler, no ORM. `server.js` is a single monolithic Express app; `public/app.js` is a single monolithic frontend script that renders everything by string-templating HTML into `innerHTML`.

## 2. Repository layout

```
reuse-hub/
├── server.js          Express app: routes, auth, uploads, moderation (1,625 lines)
├── db.js              SQLite connection + schema (CREATE TABLE IF NOT EXISTS) + migrations
├── package.json        scripts: start, demo, demo:seed, demo:reset
├── data.sqlite         production/dev database file (gitignored)
├── quarantine/         uploaded images awaiting moderation, before they're public
├── backups/            manual DB backup snapshots
├── demo/               self-contained demo mode (own DB file, seed script, sample photos)
│   ├── run-demo.js       starts server.js against demo/demo.sqlite
│   ├── seed-demo.js      populates demo data (accounts, items, requests, etc.)
│   ├── reset-demo.js     wipes and reseeds
│   └── sample-photos/
└── public/             everything express.static serves directly
    ├── index.html        single HTML shell, all sections as empty/templated containers
    ├── app.js             the entire frontend (state, rendering, event wiring) — 2,700+ lines
    ├── styles.css          all styling — 1,600+ lines
    ├── assets/hero/         hero artwork (reuse-hero.png)
    ├── uploads/             public, approved item images (moved here from quarantine/)
    └── terms.html
```

There's no `src/`, no component folders, no separate CSS files per section — everything for a given layer lives in one file.

## 3. Backend (`server.js` + `db.js`)

### Request pipeline
`helmet()` → `express.json`/`urlencoded` (200kb limit) → `cookie-parser` → `/uploads` static (approved images only) → `/` static (`public/`) → API routes → 404 handler → error handler.

### Auth
Session-cookie based, not JWT. `POST /api/signup` / `/api/login` create a row in `sessions` (`token` = nanoid, 30-day expiry) and set an `httpOnly` cookie. `requireAuth`/`optionalAuth` middleware look up that cookie against the `sessions` table. An hourly in-process `setInterval` (`cleanupExpired`) purges expired sessions, used reset tokens, and notifications older than 90 days — no external cron.

### Rate limiting
Per-route limiters (`signupLimiter`, `loginLimiter`, `passwordResetLimiter`, `verifyLimiter`, `ratingLimiter`, `reportLimiter`, `profileLimiter`) built on `express-rate-limit`, each returning a generic response so failures never leak *why* a request was blocked.

### Route groups (all under `/api`)
- **Auth**: signup, login, logout, forgot/reset password, `/me`, verify request/confirm
- **Items**: list, urgent, single, create (multipart upload), trending, home-highlights, patch, delete, claim
- **Claims**: received/sent, patch, confirm, get single
- **Requests** (item-requests + service-requests, same table, `request_type` column): list, urgent, single, create, patch, respond
- **Request offers**: received/sent, patch, confirm, get single
- **Ratings**: submit, my-submitted
- **Users**: public profile
- **Notifications**: list, unread-count, mark-all-read, mark-one-read
- **Reports**: submit
- **Impact / badges**: `/api/impact`, `/api/badges/monthly`
- **Admin** (all `requireAuth` + `requireAdmin`): reports list/resolve, close item/request, ban/unban user, pending images list/file/approve/reject, moderation log

### Image moderation pipeline (V1)
Uploaded files land in `quarantine/` first (never directly in `public/uploads`). `moderateImage()` is provider-agnostic: with `MODERATION_PROVIDER` unset (the default), everything auto-approves; setting it to `sightengine` routes through that API. Approved files move from quarantine to `public/uploads` via `publishFromQuarantine()`; rejected/pending ones stay quarantined and show up in the admin "Flagged Images" queue. A `moderation_usage` table enforces a hard monthly API-call cap so a metered provider tier can't surprise-bill. Every admin decision (approve/reject/ban/close/etc.) is written to `moderation_actions` as an audit trail.

## 4. Database schema (SQLite, `db.js`)

| Table | Purpose |
|---|---|
| `users` | account_type (individual/business), verification state, location |
| `items` | listings — price_type (free/paid/exchange/rent), listing_type (consumer/business_waste), status |
| `claims` | a user claiming an item |
| `sessions` | auth tokens |
| `password_reset_tokens` | hashed, time-limited reset tokens |
| `item_media` | per-item images, each with its own moderation `status` |
| `notifications` | typed, with `target_type`/`target_id` so a click knows what to open |
| `reports` | user reports against item/user/request/rating |
| `moderation_actions` | admin audit log |
| `requests` | item-requests and service-requests (`request_type`: thing/service) |
| `request_offers` | responses to requests |
| `ratings` | post-exchange trust ratings, one per (exchange, rater) via UNIQUE constraint |
| `moderation_usage` | monthly moderation-API call counter |

All tables use `TEXT` primary keys (nanoid-style IDs), not autoincrement integers. Foreign keys are declared but SQLite doesn't enforce them by default — referential integrity is maintained at the application layer in `server.js`. `db.js` also runs small ad-hoc `ALTER TABLE` migrations guarded by `PRAGMA table_info` checks (e.g. adding moderation columns to `item_media`), so there's no formal migration framework — schema changes are additive and idempotent by design.

## 5. Frontend (`public/`)

### Pattern: single-page, server-rendered-once shell
`index.html` is one static shell containing every section as an empty or lightly-templated container (`<div id="trendingSection"></div>`, etc.). `app.js` owns all rendering: it fetches from `/api/*`, builds HTML strings, and injects them via `innerHTML`. There's no virtual DOM, no diffing — re-renders replace whole chunks of markup wholesale.

### State
One global `state` object (top of `app.js`) holds `user`, `categories`, current `section` (Give&Take/Business/Requests), `requestType`, active filters, loaded `items`/`requests`, `wishlist`, and a mobile-only `view` flag (`home` vs `browse` — desktop always shows the single continuous page).

### Structure of `app.js` (~110 top-level functions)
Roughly grouped as:
- **Bootstrap**: `init()`, `api()` fetch wrapper, `closeModal`/`showModal`
- **Section loaders**: one `load*()` per homepage section (`loadTrending`, `loadUrgentRequests`, `loadServiceRequestsPreview`, `loadEcoPanel`, `loadCollections`, `loadCommunityStory`, `loadBusinessSurplusIntro/Teaser`, `loadMonthlyBadges`, `loadNearbyActivity`, etc.) — each fetches its own data and renders its own DOM region independently
- **Nav/menu**: `renderNav()`, `bindTopBar()`, `bindMoreMenu()`/`bindMobileMoreMenu()` (shared `MORE_MENU_GROUPS` data feeds both desktop dropdown and mobile sheet so they can't drift apart), `bindBottomNav()`, `setMobileView()`
- **Cards/rendering helpers**: `cardHtml()`, `requestCardHtml()`, `badgeHtml()`, `galleryHtml()`, `renderGrid()`
- **Modals**: auth (`openAuthModal`, forgot/reset password), post sheet (`openPostSheet` — the 4-option action sheet for item/exchange/item-request/service-request/business), profile sheet, contributors modal
- **Utilities**: `escapeHtml`, `timeAgo`, `debounce`, password strength meter

### Styling system
`styles.css` uses CSS custom properties for the design tokens (`--brand`, `--brand-dark`, `--pop`, `--radius-*`, `--shadow-*`, `--ease`) but section-specific rules (hero, header, cards, More menu, etc.) are hand-written per component rather than derived from a strict spacing/type scale — this is the main gap between "documented system" and "enforced system" if that's ever worth tightening.

Mobile vs desktop is handled almost entirely with `@media` queries and a `display:contents` trick on a few multi-column desktop layouts (`.marketplace-columns`, `.page-layout`) so they collapse to natural DOM-order stacking on mobile without duplicating markup.

## 6. Demo environment

`demo/` is a fully separate sandbox: `run-demo.js` starts `server.js` with `DB_FILE`/`QUARANTINE_DIR`/`UPLOAD_DIR` env vars pointed at `demo/demo.sqlite` and `demo/uploads`, so it never touches the real `data.sqlite`. `seed-demo.js` creates demo accounts (`*@demo.zineedo.local`) and sample listings via the real `/api/signup` etc. endpoints (not direct DB inserts), so the demo exercises the actual API surface. `reset-demo.js` wipes and reseeds.

## 7. What's not here

- No automated tests (`npm test` is a placeholder)
- No build/bundle step — files are served as-is
- No ORM/query builder — raw SQL via `better-sqlite3`'s synchronous API throughout
- No formal migration system — schema evolves via idempotent `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE`
- No component framework on the frontend — one script, one stylesheet, string-templated HTML

None of this is inherently wrong for the project's current size — it's a legible, low-dependency, single-maintainer-friendly setup. The main scaling risks if the codebase keeps growing are `server.js` and `app.js` both being single ~1,600–2,700 line files with no internal module boundaries — restructuring those into feature-based modules would be the natural next step if/when this becomes hard to navigate, but that's a separate decision from this document.
