# Architecture

```
            ┌──────────────── browser ────────────────┐
            │  React SPA (frontend/)                  │
            │  MapLibre · NASA GIBS / EOX / Esri tiles│
            └───────────────┬─────────────────────────┘
                            │ HTTPS  /api/*  (Bearer token, X-Org-Id)
┌───────────────────────────▼──────────────────────────────────────────────┐
│ nginx (web container) ── serves the SPA, proxies /api to the API         │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────┐      ┌────────────────────────────┐
│ API  (FastAPI, firealerts.main)       │      │ Worker (firealerts.worker) │
│ routers: auth · org · assets · alerts │      │ ingest every 10 min        │
│ integrations · fire data · exports ·  │      │ threat check (forecasts)   │
│ admin                                 │      │ asset risk every 6 h       │
│ services: alerting · intel · assets · │      │ Sentinel-2 refresh daily   │
│ incidents · email · audit             │      │ digests · cleanup          │
└──────────────┬────────────────────────┘      └─────────────┬──────────────┘
               │            SQLAlchemy / Alembic             │
               └──────────────────┬──────────────────────────┘
                         ┌────────▼────────┐
                         │  PostgreSQL 16  │  (SQLite for development)
                         └─────────────────┘
```

Both processes run the same Python package. The API stays stateless and can be
scaled horizontally; run exactly **one** worker. For a single-container install
set `SCHEDULER_ENABLED=true` and the API runs the jobs itself.

## Backend package layout

| Path | Responsibility |
|---|---|
| `api/` | App factory, CORS/GZip, routers per domain (`routers/*.py`), dependencies |
| `auth.py`, `security.py` | Principal resolution (token → user → organisation → role), scrypt passwords, SHA-256 token hashing, Fernet encryption of connector secrets, HMAC webhook signing |
| `models.py`, `db.py`, `migrations/` | ORM models and Alembic migrations (run automatically at start-up) |
| `plans.py` | Plan limits (assets, members, connectors, API keys, forecast members, max asset size) → HTTP 402 |
| `services/alerting.py` | Alert engine: detection / threat / risk alerts, de-duplication, escalation, routing rules, delivery log |
| `services/intel.py` | Asset intelligence: risk snapshots, Sentinel-2 vegetation, burned-area history, forest loss, exposure (with result caching) |
| `services/assets.py` | Geometry validation, GeoJSON/KML/KMZ/Shapefile import, detection matching |
| `integrations/` | External APIs: `cog` (COG reader), `sentinel2`, `planetary`, `gee`, `gfw`, `osm`, `nasa_power`, `notify` (channels), `registry` (connector catalogue) |
| `sources/` | Fire feeds (FIRMS, GOES, Himawari, Meteosat, demo), weather (Open-Meteo + NASA POWER fallback), terrain & land cover |
| `science/` | FWI system, FBP spread (uniform exact + terrain-aware raster), clustering |
| `ml/` | Ignition-risk features, dataset builder, model training and serving |
| `worker.py`, `cli.py` | Background scheduler; operations CLI |

## Data model

- **Organization** (plan, settings) ─< **Membership** >─ **User** (roles viewer/member/admin/owner; superusers for platform admin)
- **AuthToken** (sessions 30 days, API keys; hashes only) · **EmailToken** (verify/reset, single use) · **Invite** (14 days)
- **Asset** (forest, plantation, …; GeoJSON (Multi)Polygon, area, centroid, bbox, monitoring settings) ─< **AssetObservation** (Sentinel-2 NDVI/NBR/NDMI per scene) · **AssetRisk** (daily FWI + ignition probability) · **AssetAnalysis** (cached external analyses)
- **Alert** (type, severity, status, dedupe key, data, delivery log) · **Connector** (encrypted config) · **NotificationRule** (assets × types × min severity → connectors)
- **Detection** (archived satellite fire pixels, global) · **IngestRun** · **AuditLog**

## Alert pipeline

1. Ingest stores new detections; `on_new_detections` matches fresh ones (< 6 h) against every active asset and buffer → *detection* alerts (inside: high/critical, buffer: moderate), merged per asset for 12 h.
2. `check_threats` forecasts spread for active incidents within each asset's threat radius (12-member ensemble, 24 h) → *threat* alert with ETA if the median perimeter reaches the asset (critical ≤ 6 h, high ≤ 24 h) or *moderate* if only the P90 envelope does.
3. The risk job computes FWI and ignition probability for each asset → *risk* alert when the next 3 days reach the asset's danger threshold.
4. Routing: the organisation's enabled rules select connectors; with no rules, moderate+ alerts go to every channel. An alert re-notifies only when its severity escalates. Every delivery is logged on the alert.

## Security notes

- Secrets for connectors are encrypted with a key derived from `SECRET_KEY` and never returned to clients (redacted as `••••••`).
- Tokens are random 256-bit values; only SHA-256 digests are stored. Password reset signs out every session.
- Login, verification and reset endpoints are throttled; forgot-password never reveals whether an account exists.
- Every query is scoped by organisation; cross-organisation access returns 404. Superusers can act in any organisation for support.
- Outgoing webhooks are signed: `X-Firealerts-Signature: sha256=HMAC(secret, "<X-Firealerts-Timestamp>.<body>")`.
