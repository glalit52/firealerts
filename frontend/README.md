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
src/api/        typed fetch client (bearer token + X-Org-Id, 401/402 handling) and endpoint functions
src/auth/       auth context: current user, organisations, sign-in/out, org switching
src/components/ UI kit (buttons, inputs, modal, drawer, tabs, table, toasts), charts, connector form
src/map/        MapLibre wrapper, basemaps & imagery overlays (NASA GIBS, EOX, Esri, CARTO), polygon/circle draw tool
src/pages/      landing, auth flows, and the app: overview, live map, assets, asset detail, alerts,
                integrations, data, settings (profile, organisation & billing, team, API keys), admin
src/styles/     design tokens and styles
```

Connector forms are rendered from `GET /api/meta` → `connector_types`, so new backend connectors appear without
frontend changes. Map layer URLs live in `src/map/layers.ts`.

## Production

`docker build -t firealerts-web .` builds the app and serves it with nginx (`nginx.conf`), proxying `/api` to the
`api` service; see the root `docker-compose.yml`.
