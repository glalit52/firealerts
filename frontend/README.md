# Firealerts web app

React 18 + TypeScript + Vite single-page app for the Firealerts API (MapLibre GL for maps, no UI framework).

```bash
npm install
npm run dev          # http://localhost:5173, proxies /api to http://localhost:8000 (VITE_DEV_PROXY_TARGET)
npm run build        # strict type-check + production build in dist/
npm test             # vitest unit tests
```

Run the backend alongside it, e.g. `cd ../backend && DATA_MODE=demo uvicorn firealerts.main:app --port 8000`.

## Environment

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | API base URL baked into the build. Empty (default) = same origin, with `/api` proxied (nginx in production, Vite in development). |
| `VITE_DEV_PROXY_TARGET` | Where `npm run dev` / `npm run preview` proxy `/api` (default `http://localhost:8000`). |

## Structure

```
src/api/        typed fetch client (bearer token + X-Org-Id + Accept-Language, 401/402 handling) and endpoint functions
src/auth/       auth context: current user, organisations, sign-in/out, org switching, UI language
src/components/ UI kit (buttons, inputs, modal, drawer, tabs, table, toasts), charts, connector form, fire statistics
src/i18n/       typed i18n: en.ts (source of truth), es.ts, pt.ts, t()/useT(), Intl formatting
src/map/        MapLibre wrapper, basemaps & imagery overlays (NASA GIBS, EOX, Esri, CARTO), wind layer, draw tool
src/pages/      landing, public live map (/live), auth flows, and the app: overview, live map (incl. fire history),
                assets, asset detail, alerts, integrations, data, settings (profile, notifications,
                organisation & billing, team, API keys), admin
src/styles/     design tokens and styles
public/         favicon, PWA manifest, icons and the hand-written service worker (sw.js)
```

## Languages (i18n)

The UI ships in English, Spanish (neutral Latin American) and Brazilian Portuguese. `src/i18n/en.ts` is the source of
truth; `es.ts` and `pt.ts` are typed as `Messages`, so a missing or extra key fails `npm run build`.

- `t("key", { name })` interpolates `{name}` (numbers are formatted for the locale); plural entries are
  `{ one, other }` and take `{ count }` (CLDR rules via `Intl.PluralRules`).
- Components call `const { t, locale } = useT()`; non-React helpers (`lib/format.ts`, constants) use the module-level
  `t`, so numbers, dates, relative times and compass points follow the current language. English keeps the original
  `en-US` number and `en-GB` date formats.
- Language choice: the signed-in user's saved language (`me.user.language`), else `localStorage.fa_lang`, else
  `navigator.languages` (es*/pt*), else English. Switchers live in the landing header, auth pages, public map, the
  account menu and Profile; changing it while signed in also sends `PATCH /api/me {"language"}`.
- The organisation's alert/e-mail language is set in Settings → Organisation (`PATCH /api/org {"settings": {"language"}}`).
- Adding a string: add the key to `en.ts`, then the translations to `es.ts` and `pt.ts` (TypeScript lists what's missing).

## Public live map

`/live` works without signing in (even when the server requires auth): detections (heatmap + age-coloured points),
incidents sorted by priority (read-only, no forecasts), wind arrows, basemap switcher and a sign-up call to action.
It reads `/api/public/*` for the current view (bbox clamped to 60°×40°). When the server reports
`meta.public_map: false` (or the public API returns 404) the page shows a "public map disabled" message.

## Map features

- **Wind** (layer switcher → Weather & overlays) on the live map, public map and asset map: `GET /api/weather/wind`
  (or `/api/public/wind`) for the view, debounced on `moveend`, bbox at least 1°×1° and at most 60°×40°. Arrows are a
  programmatic SDF image rotated to where the wind blows (direction + 180°), coloured/sized by speed, with a forecast-hour
  slider and a km/h legend.
- **Fire history** (live map → History): past detections for a date range of up to 31 days (`/api/detections?from&to&bbox`)
  plus a statistics panel (`/api/stats/fires`: daily counts and FRP, by sensor). The asset "Fire history" tab shows the
  same panel for the last 30 days around the asset.
- **Static heat sources**: incidents/detections flagged with `static_source` (volcano, gas flare/industry, persistent)
  get a chip and are hidden by default ("Hide static heat sources").

## PWA & push notifications

`public/manifest.webmanifest`, icons in `public/icons/` (rendered from `favicon.svg`) and a hand-written
`public/sw.js`: the app shell is cached for offline start (navigations network-first, hashed `/assets/*` cache-first,
`/api/*` never cached), `push` events show a notification (`{title, body, url, severity, tag}`) and clicking it focuses
or opens the URL. The worker is registered in production builds only; Settings → Notifications registers it on demand
to subscribe to Web Push (`/api/push/*`), sends test notifications, lists your devices, and lets admins enable the
organisation's "Mobile push" connector. The account menu offers "Install app" when the browser allows it.
Push needs HTTPS (or localhost) and server VAPID keys (`GET /api/push/vapid-public-key`).

Connector forms are rendered from `GET /api/meta` → `connector_types`, so new backend connectors appear without
frontend changes. Map layer URLs live in `src/map/layers.ts`.

## Production

`docker build -t firealerts-web .` builds the app and serves it with nginx (`nginx.conf`), proxying `/api` to the
`api` service; see the root `docker-compose.yml`.
