# Demo environment

A fully populated, disposable copy of ReUse Hub for exploring the site without touching real data.

## How it stays separate from production

The app code (`server.js`, `db.js`, `public/`) is 100% unchanged between real and demo mode — the
only difference is two environment variables telling it which files to use:

| | Real (`npm start`) | Demo (`npm run demo`) |
|---|---|---|
| Database | `data.sqlite` | `demo/demo.sqlite` |
| Uploaded photos | `public/uploads/` | `demo/uploads/` |
| Port | 3000 | 3300 |

Because these are separate files, nothing you do in demo mode — signups, posts, bans, deletions —
can ever reach your real data.

## Commands

```
npm run demo:seed    # populate demo/demo.sqlite with sample data (first time, or to add more)
npm run demo         # start the real server against the demo database, browsable at :3300
npm run demo:reset   # wipe demo/demo.sqlite + demo/uploads and reseed from scratch
```

## Demo accounts

Password for every account: `Demo@1234`

| Email | Who they are |
|---|---|
| admin@demo.reusehub.local | Admin — full moderation dashboard |
| rahul@demo.reusehub.local | Regular user, a few completed exchanges |
| priya@demo.reusehub.local | Regular user, posted a request that got fulfilled |
| arjun@demo.reusehub.local | Active trader, several completed exchanges both ways |
| sneha@demo.reusehub.local | Food Rescue poster |
| amit@demo.reusehub.local | Business account, Business Surplus listings |
| kavya@demo.reusehub.local | Highly rated (multiple 5-star reviews) |
| vijay@demo.reusehub.local | Has an open report against him, plus a disputed rating |
| rohit@demo.reusehub.local | Banned — try logging in to see the suspension message |

## What's populated

12 listings with real sample photos across Give & Take, Food Rescue (with pickup deadlines and an
urgent item), and Business Surplus; 3 requests (one still open); 7 completed two-sided exchanges
with ratings/tags/comments; 5 reports covering all four target types (item, request, user, rating)
in all three statuses (open, resolved, dismissed); and the moderation actions (close listing, ban
user) that produced them.
