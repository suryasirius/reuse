# Zineedo API Contract

This documents the actual current REST API implemented in `server.js`, as it exists today.
There is no `/api/v1` prefix and none is introduced by this document — every route lives under
the flat `/api/*` namespace it already uses. This is a snapshot of the real implementation, not
an aspirational spec; if this document and `server.js` ever disagree, `server.js` is correct and
this document is stale and should be updated (see `api_contract_test.js`, which fails automatically
when key response shapes drift from what's documented here).

## Authentication

Two mechanisms are both accepted, resolved by `getAuthToken(req)`, cookie first:

1. **Cookie** (web): `POST /api/login` or `POST /api/signup` sets an HTTP-only `token` cookie
   (`Secure` in production, `SameSite=Lax`, 30-day expiry). Sent automatically by the browser on
   every subsequent request; nothing else to do.
2. **Bearer token** (Phase 9A, for a future mobile client): send `Accept: application/json` on
   `POST /api/login`. The response body then includes a `token` field alongside the normal user
   fields. Send that token back as `Authorization: Bearer <token>` on every subsequent request.
   The existing web frontend never sends `Accept: application/json` on login, so this is purely
   additive — nothing changes for the website.

Both mechanisms authenticate against the exact same `sessions` table (tokens are stored as a
SHA-256 hash, never in plaintext) — there is no separate mobile-user concept. A bearer token is
only ever accepted from the `Authorization` header; never from a query string or request body,
so it can't leak into logs, browser history, or a referrer. `POST /api/logout` invalidates
whichever session (cookie or bearer) made the request.

Three auth tiers appear below:
- **Public** — no auth required, works logged out.
- **Optional auth** — works logged out, but behavior/fields differ if a valid session is present.
- **Auth required** — `401 { "error": "Not logged in" }` (or `"Session expired..."`/`"Invalid
  session"` for a stale/bad token) from the `requireAuth` middleware, confirmed directly in
  `server.js`, without a valid cookie or bearer token.
- **Admin required** — auth required, plus the authenticated user's `is_admin` flag (server-side,
  from the DB row — never client-asserted) must be true, or the request gets `403`.

## General conventions

- All request/response bodies are JSON (`Content-Type: application/json`) except `POST /api/items`,
  which is `multipart/form-data` (it accepts file uploads via the `media` field, up to
  `MAX_UPLOAD_FILES` files).
- Every error response is `{ "error": "<human-readable message>" }` with a non-2xx status code.
  Common codes: `400` (validation failure), `401`/redirect-equivalent (not authenticated — see each
  route), `403` (authenticated but not permitted — wrong owner, not admin, blocked, not part of an
  exchange), `404` (not found, OR deliberately indistinguishable from "not found" for privacy —
  see Privacy Rules below), `409` (a state-transition conflict, e.g. re-accepting an already-decided
  claim/offer), `429` (rate limited — `{ "error": "Too many requests. Please try again later." }`).
- Unmatched `/api/*` routes return a clean `404 { "error": "Not found" }` rather than an HTML page.
- Sort/filter query params are always resolved through a fixed server-side whitelist
  (`ITEM_SORTS`, `REQUEST_SORTS`, category lists, etc.) — an unrecognized value silently falls back
  to the existing default order rather than erroring or reaching raw SQL.
- Pagination is opt-in and additive on `GET /api/items` and `GET /api/requests`: omit `page`/`limit`
  and you get the exact same bare array response as always; send either one and you get
  `{ items|requests, page, limit, total, hasMore }` instead.

## Privacy rules enforced across the API

These are structural rules applied by nearly every route, not per-endpoint quirks:

- **Blocking is mutual and total.** If either user has blocked the other, every listing, profile,
  and detail route treats the other party's content as if it does not exist — `404`, never a
  distinguishable "blocked" error, on both sides equally.
- **Exact pickup location (`pickup_address`, `pickup_instructions`, and internal geo columns) is
  only ever visible to:** the listing's owner, or the counterparty on a claim/offer that owner has
  *accepted*. Everyone else — including a logged-out visitor, or a user who merely submitted a
  claim/offer that hasn't been accepted yet — only ever sees `pickup_area` (a coarser label).
  Internal coordinate columns (`*_lat`/`*_lng`, geocoding status fields) are never returned by any
  response at all, regardless of role — they exist only for server-side distance/radius filtering.
- **Email addresses** are only ever included in a response to: the account's own owner (`GET
  /api/me`), the item/request owner once they've received a claim/offer (so they can contact the
  requester), or the requester/responder once their own claim/offer has been accepted (so they can
  contact the owner). A public profile (`GET /api/users/:id/profile`) never includes email,
  password hash, exact pickup fields, or a per-exchange activity log — only aggregated counts.
- **Ratings/reviews are anonymous** — the rater's identity is never included in a response; the
  ratee only ever sees stars/tags/comment.
- **A user's own general location** (set via `PATCH /api/me`) is downgraded to `'approximate'`
  precision automatically whenever it came from device GPS, regardless of what the client claims.

## Auth & account

| Method & path | Auth | Request fields | Response | Key errors |
|---|---|---|---|---|
| `POST /api/signup` | Public | `name, email, password, account_type ('individual'\|'business'), location?` | `{ id, name, email, account_type, is_verified: 0, is_admin }` + sets `token` cookie | `400` missing/invalid fields, password not 6-72 chars, email already registered |
| `POST /api/login` | Public | `email, password` | `{ id, name, email, account_type, is_verified, is_admin, token? }` (`token` only if `Accept: application/json`) + sets `token` cookie | `400` invalid email/password, `403` banned account |
| `POST /api/logout` | Optional | — | `{ ok: true }`; clears cookie if present, deletes whichever session (cookie or bearer) made the call | — |
| `POST /api/forgot-password` | Public | `email` | `{ ok: true, message }` (always identical whether or not the account exists — never leaks account existence); non-production also returns `dev_reset_token` | — |
| `POST /api/reset-password` | Public | `token, newPassword, confirmPassword` | `{ ok: true }`; revokes all existing sessions for that user | `400` missing fields, mismatch, invalid length, invalid/expired token |
| `POST /api/change-password` | Auth required | `currentPassword, newPassword, confirmPassword` | `{ ok: true }`; revokes every *other* session, keeps the current one alive | `400` missing/mismatched/wrong-length/incorrect current password |
| `POST /api/verify/request` | Auth required | — | `{ ok: true, demo_code }` (demo OTP — no real SMS/email provider wired up yet) | — |
| `POST /api/verify/confirm` | Auth required | `code` | `{ ok: true }`; sets `is_verified = 1` | `400` incorrect code |
| `GET /api/me` | Optional | — | `{ user: <full user row or null>, categories, business_categories, business_categories_primary_count, service_categories }` | — |
| `PATCH /api/me` | Auth required | `name?, location?, location_lat?, location_lng?, location_source?, location_precision?` | `{ user }` | `400` invalid name length/coords, lat/lng must arrive together |

## Location (Geoapify-backed, rate-limited)

| Method & path | Auth | Request | Response | Key errors |
|---|---|---|---|---|
| `GET /api/location/search?q=` | Public (rate-limited) | query string `q` | `{ status, results: [{ label, lat, lng, precision }] }` | `400` query too long (>200 chars) |
| `POST /api/location/reverse` | Public (rate-limited) | `lat, lng` | `{ status, label, precision }` | `400` invalid coordinates |

## Items (Give & Take / Business Surplus)

| Method & path | Auth | Request fields | Response | Key errors |
|---|---|---|---|---|
| `GET /api/items` | Optional | query: `category, price_type, q, mine, listing_type, location, urgent, sort, page?, limit?`, plus nearby params (`lat,lng,radius_km`) | bare array of items (each with `owner_name/owner_type/owner_location/owner_verified`, media attached, exact pickup stripped unless owner/`mine`), or `{ items, page, limit, total, hasMore }` if paginated | `400` malformed nearby params |
| `GET /api/items/urgent` | Optional | query: `listing_type?` | array, max 8, urgent + available only | — |
| `GET /api/items/:id` | Optional | — | full item (exact pickup only if owner or accepted requester) | `404` not found or blocked |
| `POST /api/items` | Auth required, multipart | `title, description, category, condition?, price_type?, price?, exchange_for?, rent_rate?, rent_period?, deposit?, is_recurring?, frequency?, quantity?, listing_type?, pickup_available?, pickup_type?, pickup_area?, pickup_address?, pickup_instructions?, available_until?, is_urgent?, food_pref?, is_edible_food?` + files field `media[]` | created item, media attached | `400` missing/invalid fields, invalid category, invalid file type, missing food deadline for edible listings |
| `GET /api/items-trending` | Optional | query: `listing_type?` | array, max 8, by `request_count` | — |
| `GET /api/home-highlights` | Optional | — | array of `{ key, label, icon, items[] }` groups | — |
| `PATCH /api/items/:id` | Auth required (owner only) | `status?` (`available`\|`closed` only), or any editable field (`title, description, category, ...`) | full item (owner always sees exact pickup) | `403` not your item, `400` invalid status/category, missing food deadline |
| `DELETE /api/items/:id` | Auth required (owner only) | — | `{ ok: true }`; deletes media files + thumbnails from disk | `403` not your item |
| `POST /api/items/:id/claim` | Auth required | `message?` | `{ ok: true, id }` | `400` own item / not available / past deadline, `404` not found or blocked |
| `GET /api/my/claims-received` | Auth required | — | array of claims on your items (requester email only once accepted) | — |
| `GET /api/my/claims-sent` | Auth required | — | array of your own claims | — |
| `PATCH /api/claims/:id` | Auth required (item owner) | `status` (`accepted`\|`declined`, only from `pending`) | `{ ok: true }` | `403` not your item, `409` invalid transition, `400` item no longer available |
| `POST /api/claims/:id/confirm` | Auth required (giver or receiver) | `confirmed (bool), reason?` | `{ ok: true, status, giver_confirmed, receiver_confirmed }` | `403` not part of exchange, `400` not yet accepted |
| `GET /api/claims/:id` | Auth required (giver or receiver) | — | `{ claim, item, role }` | `403` not part of exchange |

## Requests (reverse marketplace) & Request Offers

| Method & path | Auth | Request fields | Response | Key errors |
|---|---|---|---|---|
| `GET /api/requests` | Optional | query: `request_type, category, q, mine, urgent, location, sort, page?, limit?` | bare array, or `{ requests, page, limit, total, hasMore }` if paginated | — |
| `GET /api/requests/urgent` | Optional | — | array, max 8 | — |
| `GET /api/requests/:id` | Optional | — | full request (exact pickup stripped unless owner) | `404` not found or blocked |
| `POST /api/requests` | Auth required | `title, description, request_type?, category, budget_type?, budget_amount?, exchange_for?, quantity?, is_urgent?` | created request | `400` missing/invalid fields, invalid category |
| `PATCH /api/requests/:id` | Auth required (owner only) | `status?` (`open`\|`closed` only), or editable fields | updated request | `403` not your request, `400` invalid status/category |
| `POST /api/requests/:id/respond` | Auth required | `message?, offered_price?, pickup_type?, pickup_area?, pickup_address?, pickup_instructions?` | `{ ok: true, id }` | `400` own request / not open, `404` not found or blocked |
| `GET /api/my/request-offers-received` | Auth required | — | array (responder email only once accepted) | — |
| `GET /api/my/request-offers-sent` | Auth required | — | array of your own offers | — |
| `PATCH /api/request-offers/:id` | Auth required (request owner) | `status` (`accepted`\|`declined`, only from `pending`) | `{ ok: true }` | `403` not your request, `409` invalid transition, `400` request no longer open |
| `POST /api/request-offers/:id/confirm` | Auth required (giver or receiver) | `confirmed (bool), reason?` | `{ ok: true, status, giver_confirmed, receiver_confirmed }` | `403` not part of exchange, `400` not yet accepted |
| `GET /api/request-offers/:id` | Auth required (giver or receiver) | — | `{ offer, request, role }` | `403` not part of exchange |

## Ratings, profiles, notifications, blocks, reports

| Method & path | Auth | Request fields | Response | Key errors |
|---|---|---|---|---|
| `POST /api/ratings` | Auth required | `exchange_type ('claim'\|'offer'), exchange_id, stars (1-5), tags?, comment?` | `{ ok: true, id }` | `400` invalid fields/stars/already rated/not completed, `403` not part of exchange, `404` not found |
| `GET /api/ratings/my-submitted` | Auth required | — | array of `"type:id"` strings | — |
| `GET /api/users/:id/profile` | Optional (rate-limited) | — | `{ id, name, account_type, location, is_verified, member_since, avg_rating, rating_count, reuse_count, food_count, total_count, badges[], badge_month, recent_reviews[] }` — never email/password/exact pickup/per-exchange log | `404` not found or blocked |
| `GET /api/notifications` | Auth required | — | array, latest 50 | — |
| `GET /api/notifications/unread-count` | Auth required | — | `{ count }` | — |
| `POST /api/notifications/mark-all-read` | Auth required | — | `{ ok: true }` | — |
| `POST /api/notifications/:id/read` | Auth required (owner only) | — | `{ ok: true }` | `404` not found / not yours |
| `POST /api/users/:id/block` | Auth required | — | `{ ok: true }` (idempotent) | `400` can't block self, `404` user not found |
| `DELETE /api/users/:id/block` | Auth required | — | `{ ok: true }` (only removes your own block record) | — |
| `GET /api/users/blocked` | Auth required | — | array | — |
| `POST /api/reports` | Auth required (rate-limited) | `target_type ('item'\|'user'\|'request'\|'rating'), target_id, category, reason?` | `{ ok: true }` | `400` missing/invalid target_type or category |

## Public metrics

| Method & path | Auth | Response |
|---|---|---|
| `GET /api/impact` | Public | Community-wide KPI counts (completed exchanges only, two-sided confirmed) |
| `GET /api/badges/monthly` | Public | This month's `food_giver`/`reuse_donor`/`community_champion` computed badges |

## Admin (Trust & Safety) — all `requireAuth + requireAdmin`

| Method & path | Request fields | Response | Key errors |
|---|---|---|---|
| `GET /api/admin/reports?status=` | — | array with resolved `target` label per report | — |
| `PATCH /api/admin/reports/:id` | `status ('resolved'\|'dismissed'), note?` | `{ ok: true }`; logged to moderation_actions | `400` invalid status, `404` not found |
| `PATCH /api/admin/items/:id/close` | `note?` | `{ ok: true }` (closes any item, any owner) | `404` not found |
| `PATCH /api/admin/requests/:id/close` | `note?` | `{ ok: true }` | `404` not found |
| `POST /api/admin/users/:id/ban` | `reason?` | `{ ok: true }`; revokes all of that user's sessions immediately | `400` can't ban self, `404` not found |
| `POST /api/admin/users/:id/unban` | — | `{ ok: true }` | `404` not found |
| `GET /api/admin/images/pending` | — | array of pending-review media | — |
| `GET /api/admin/images/:id/file` | — | raw image bytes (quarantine dir only, never a public URL) | `404` not found |
| `POST /api/admin/images/:id/approve` | — | `{ ok: true }`; moves file out of quarantine, processes it, may set the item's cover photo | `404` not found |
| `POST /api/admin/images/:id/reject` | `note?` | `{ ok: true }`; deletes the quarantined file and the DB row, notifies the owner | `404` not found |
| `GET /api/admin/moderation-log` | — | array, latest 100 admin actions | — |

Every non-admin request to any route in this section gets `403 { "error": "Admin access required" }`
from the `requireAdmin` middleware, regardless of authentication — this is checked server-side
against `req.user.is_admin` (itself synced from `ADMIN_EMAILS` on every login), never anything the
client asserts about its own role.

## Deliberately out of scope for this document

- Static asset routes (`express.static` serving `public/`) are not part of this API contract.
- Internal helper functions (`attachMedia`, `stripExactPickup`, `notify`, etc.) are implementation
  details, not part of the contract — only the response shapes they produce are.
- No `/api/v1` versioning exists and none is introduced here, per Phase 9A's explicit scope limits.
