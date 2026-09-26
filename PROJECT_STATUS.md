# Zineedo — Project Status

_Last updated: 2026-08-12_

## What this project is
Express + better-sqlite3 backend (`server.js`, `db.js`) with a vanilla JS SPA frontend
(`public/index.html`, `public/app.js`, `public/styles.css`). India-focused hyperlocal
resource-sharing marketplace: give/take items, business waste recycling, community
requests (things + services), food rescue, monthly "Community Champions" badges based on
real completed exchanges (no fake points/XP).

Runs via `npm start` from this folder in PowerShell, served at `http://localhost:3000`.

## Access setup
- This folder (`reuse-hub`) is directly connected — Claude can Read/Write/Edit files here
  with no extra steps. No need for the old Notepad/clipboard/computer-use workaround.
- Static file changes (`public/*.css`, `public/*.html`, `public/*.js`) only need a hard
  browser refresh (`Ctrl+Shift+R`) — Express serves them statically, no restart needed.
- Server-code changes (`server.js`, `db.js`) need the npm process restarted.

## Current state (all deployed and confirmed working)
- **Badges/pickup-location feature**: monthly community badges (`computeMonthlyBadges()`,
  `/api/badges/monthly`), pickup privacy (`stripExactPickup()` — approximate location shown
  publicly, exact address only to owner/accepted receiver), two-sided completion
  confirmation on claims/offers.
- **Homepage layout** (user explicitly approved this order, treat as frozen —
  do NOT redesign again without being asked):
  Header → Hero+Search → Stats strip → Monthly Community Champions → Trending →
  compact Nearby Activity (`.nearby-activity-compact` — smaller map, no subtitle) →
  Marketplace (categories sidebar + item grid + Impact Tracker sidebar) →
  Community story → Business teaser → Popular collections → Trust strip → Footer.
  User's stated design philosophy: visual style (green/lime "Organic Minimalism" v2.0
  brand) is good and should NOT be redesigned — only spacing/hierarchy/information
  architecture should be adjusted going forward.
- **Empty states**: Trending, marketplace grid, and Requests tab each show a friendly
  `.empty-state` block (icon + heading + subtext + "Post an item/request" CTA button)
  instead of a lone tiny `.empty` card when there's no data yet.
- Mobile responsive passes (P0/P1/P2) already done: header, hero, search bar, stats grid,
  impact tracker, categories scroll, empty states — all tightened for ~375-430px widths.

## Explicitly NOT done yet (next steps, per user's own priority list)
1. Real functionality/data testing — the site currently has ~0 real listings, which is why
   empty states matter so much right now.
2. Listing creation testing across all types: free, paid, exchange, food surplus, business
   surplus.
3. Food Rescue flow: urgency, available-until time, quantity, location, "I can help",
   donor/receiver confirmation.
4. Google Maps location: confirm approximate location shown publicly, exact address only
   to accepted parties, "open in Google Maps" for directions (already partially built —
   `exactPickupHtml()` / `mapsUrl()` in app.js — needs live testing).
5. Monthly Champions: verify confirmed-completion counting, food giver / reuse donor
   counts, monthly recalculation, badge assignment — needs live testing with real data.
6. Populate real marketplace: create several test accounts, post 20-30 realistic listings,
   test Trending/Near You/Categories/Search/Filters/Food Rescue end-to-end.
7. Re-test all of the above on mobile at 375px, 390px, 430px widths.

## Working style notes
- User wants concise, direct communication — minimal preamble, no over-explaining.
- User wants file edits done directly on this folder now (Read/Write/Edit tools), NOT via
  computer-use/screenshots/Notepad — that was a workaround from before folder access was
  granted and is no longer needed.
