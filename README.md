# ReUse Hub (prototype)

A website where users create an account and post things they don't want — old phones, computers, cars, furniture, or surplus food from a restaurant/business. Each post is categorized, and the owner sets how it's given away: **free**, **paid**, or **exchange**. Businesses can mark a post as **recurring** (daily/weekly/monthly) for things like daily leftover food. Other users browse, filter by category or offer type, and request an item; the owner accepts or declines the request.

This is a working local prototype: real accounts, a real database, and photo/video uploads — just not deployed online yet. It's built so it can move to a hosted production app (and later a mobile app) with minimal rework, since the backend is a standard REST API.

## What's included

- Sign up / log in (individual or business account)
- Post an item: title, description, category (11 built-in categories including "Food (Surplus)"), condition, quantity, photo/video upload
- Offer type: Free, Paid (set a price), or Exchange (say what you want in return)
- Recurring surplus toggle with frequency (daily/weekly/monthly) — for businesses with regular giveaways
- Browse/search all items, filter by category and offer type
- Request an item ("claim") with a message to the owner
- Owner dashboard: see requests received, accept/decline them; see requests you've sent
- Mark items as given away / closed

## How to run it

Requires [Node.js](https://nodejs.org) (v18+) installed on your computer.

1. Open a terminal in this folder.
2. Install dependencies (first time only):
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Open **http://localhost:3000** in your browser.

Data is stored locally in `data.sqlite` in this folder — it persists between restarts. Uploaded photos/videos go in `public/uploads`.

To reset all data, stop the server and delete `data.sqlite` (and the `-wal`/`-shm` files if present).

## Project structure

```
reuse-hub/
  server.js        Express API (auth, items, claims)
  db.js             SQLite schema/connection
  public/
    index.html      Single-page app shell
    app.js          All frontend logic (no build step needed)
    styles.css       Styling
    uploads/        Uploaded item photos/videos (created automatically)
```

## Notes on the current prototype vs. a production version

- Passwords are hashed (bcrypt) and sessions use a simple token in an HTTP-only cookie — fine for local testing, but before going live you'd want HTTPS, rate limiting, and email verification.
- No payment processing is wired up — "Paid" just displays a price; buyer and seller arrange payment themselves, same as Craigslist/OLX. Real payments (escrow, UPI, cards) would need a payment gateway integration later.
- No messaging/chat between users yet — requests carry a one-time message. A chat thread would be a natural next feature.
- Recurring posts are template-based (one post marked "daily", etc.) rather than auto-generating a new post every day — that automation could be added with a scheduled job once this moves to a hosted server.
- Categories are hard-coded in `server.js` (`CATEGORIES` array) — easy to edit or move to a database table later.

## Next steps toward a real product

1. Deploy this Express app to a host (Render, Railway, Fly.io, etc.) with a persistent volume or move from SQLite to Postgres.
2. Add image storage on S3/Cloudflare R2 instead of local disk.
3. Add in-app messaging and email/SMS notifications for new requests.
4. Add location-based search/maps so nearby users find each other easily.
5. Once the web version is validated, wrap it as a mobile app (React Native or a PWA) reusing the same API.
