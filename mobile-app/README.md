# ReUse Hub — Mobile App (Capacitor wrapper)

This is a native Android/iOS shell around the existing ReUse Hub web app. It does **not**
duplicate any frontend or backend code: `capacitor.config.json` points the native
WebView straight at your live ReUse Hub domain, so the same `public/` SPA, the same
`/api/*` routes, and the same cookie-based sessions all work unchanged inside the app.

This was scaffolded ahead of time so it's ready to build once Phase 9 (production
deployment) gives the site a real HTTPS domain. It is **not built or published yet** —
no app store submission, no signing, nothing irreversible has been done.

## Why this approach (vs. React Native / Flutter rewrite)

- Zero duplicated code — one codebase (`public/`, `server.js`) serves web and mobile.
- Every future change to the site ships to the app automatically (no app-store update
  needed for content/logic changes — only needed for native shell changes).
- Matches the project's stated philosophy of staying lightweight, not building a second
  app to maintain.
- Session cookies, CSP, and auth all keep working as-is since the app loads your real
  origin — no CORS changes needed to the backend.

## What's here

- `package.json` — Capacitor CLI + core + Android/iOS platform packages.
- `capacitor.config.json` — points the app's WebView at your production URL.
- `www/index.html` — placeholder screen, only shown if `server.url` isn't set.

## Before this can be built (do these once, later)

1. **Finish Phase 9** — this needs a real production HTTPS domain (e.g.
   `https://reusehub.example.com`). A `capacitor://` app cannot point at
   `http://localhost` or an IP-only VPS.
2. Edit `capacitor.config.json`:
   - Replace both `REPLACE_WITH_YOUR_PRODUCTION_DOMAIN` values with your real domain
     (no `https://` prefix in `allowNavigation`, e.g. just `reusehub.example.com`).
   - Set `"cleartext": true` only temporarily if you must test against plain HTTP —
     never ship that to production.
3. From this `mobile-app/` folder, with Node.js and npm installed:
   ```bash
   npm install
   npx cap add android      # generates the android/ native project
   npx cap add ios          # generates the ios/ native project (macOS + Xcode only)
   npx cap sync
   ```
4. Open and run:
   ```bash
   npx cap open android     # opens Android Studio
   npx cap open ios         # opens Xcode (macOS only)
   ```
   From there you can run on an emulator/device, set your app icon and splash screen,
   and eventually generate a signed release build for the Play Store / App Store.

## Notes / things to revisit later

- **App icon & splash screen** — currently using Capacitor's defaults. Generate real
  assets later with `@capacitor/assets` once there's a logo.
- **Push notifications** — not included. ReUse Hub's in-app notifications already work
  over the existing API; native push would be a separate, optional addition later.
- **Deep links** (e.g. tapping a shared listing link opens the app) — not configured
  yet; can be added via Capacitor's `App` plugin + Android App Links / iOS Universal
  Links once the domain is live.
- **Offline behavior** — none by design; the app is a thin online-only wrapper,
  consistent with the site's own architecture (no offline mode on web either).
- This app was intentionally scaffolded, not built, since there's no production domain
  yet and no reason to generate native build artifacts before Phase 9 finishes.
