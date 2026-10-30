# Firealerts

**Satellite wildfire intelligence for forests and the people who protect them.** A full SaaS product: organisations sign up, add their forests, and get detection, predictive and pre-fire alerts. Alerts are backed by multi-satellite fire detection, terrain-aware spread forecasts, a fire-danger and ML ignition forecast, and Sentinel-2 vegetation and burn-severity analytics.

```
frontend/   React + TypeScript web app (landing, sign-up, live map, forests, alerts, integrations, data, settings, admin)
backend/    Python FastAPI API + background worker (ingestion, forecasting, alerting, Earth-observation analytics)
docs/       Architecture, API guide, integrations, deployment, OpenAPI spec
```

## What it does

| Area | Capabilities |
|---|---|
| **Fire detection** | NASA FIRMS VIIRS (375 m) and MODIS, plus geostationary GOES-East/West, Himawari-9 and Meteosat every 10–15 min. Hotspots are clustered into incidents with a priority score. |
| **Forecasting** | Canadian FWI fire danger (7 days), a gradient-boosted ignition-probability model, and a terrain- and fuel-aware ensemble spread forecast (P50/P90 perimeters, arrival time, burn probability) driven by ESA WorldCover fuels and slope. |
| **Your forests** | Draw them or import GeoJSON / KML / KMZ / Shapefile. Each one gets nearby fires, a risk forecast, Sentinel-2 NDVI/NBR/NDMI time series and imagery, dNBR burn severity, burned-area history (MODIS / Earth Engine), forest loss (Global Forest Watch / Earth Engine), exposure (OpenStreetMap), a printable report and CSV exports. |
| **Alerts** | Detection alerts (fire inside or near), **predictive threat alerts** ("may reach your forest in ~6 h") and **pre-fire risk alerts**. They are de-duplicated and escalated, can be acknowledged or resolved, and are routed by rules to e-mail, Slack, Teams, Discord, Telegram, SMS/WhatsApp (Twilio), PagerDuty or signed webhooks. |
| **SaaS** | Sign-up with e-mail verification, password reset, organisations, roles, invites, API keys, audit log, plans with limits, Stripe billing, platform admin. |
| **Data** | PostgreSQL storage with migrations; detections archived for history and model training; exports in CSV, GeoJSON and KML; REST API with an OpenAPI spec. |

## Quick start

**Development (no accounts needed, synthetic data offline):**

```bash
cd backend && pip install -r requirements-dev.txt
DATA_MODE=demo uvicorn firealerts.main:app --reload --port 8000     # API + jobs, docs at :8000/docs
cd ../frontend && npm install && npm run dev                          # http://localhost:5173
```

**Production stack (PostgreSQL + API + worker + web):**

```bash
cp .env.example .env        # set SECRET_KEY, POSTGRES_PASSWORD, APP_URL, e-mail and data-source credentials
docker compose up --build -d
docker compose exec api python -m firealerts.cli create-user you@example.com --superuser --org "Your org"
# open http://localhost:8080
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data model, alert pipeline, security
- [Integrations](docs/INTEGRATIONS.md): every connector and data source, and how to get credentials
- [API guide](docs/API.md): authentication, examples, webhook signature verification, plus the [OpenAPI spec](docs/openapi.json)
- [Deployment](docs/DEPLOYMENT.md): Docker Compose, configuration, production checklist
- [Backend](backend/README.md) · [Frontend](frontend/README.md)

## Testing

- `backend`: `pytest -q` runs 118 tests on SQLite, and the same suite runs against PostgreSQL in CI.
- `frontend`: `npm test` runs 39 unit tests, and `npm run build` performs a strict type-check.
- An end-to-end Playwright pass (24 flows: sign-up, drawing and importing forests, asset analytics, map forecasts, integrations, alerts, data, settings, admin, invites, mobile) was run against the demo backend during development.

Live-verified against real data: NOAA GOES, Sentinel-2 on AWS, ESA WorldCover and AWS Terrain Tiles. The other providers (FIRMS, Open-Meteo, NASA POWER, Earth Engine, Global Forest Watch, Planetary Computer, Overpass, Himawari, Meteosat) and the notification channels are implemented to their published APIs and tested with mocked responses; see [Integrations](docs/INTEGRATIONS.md#verification-status).

Forecasts are decision support, not operational fire-behaviour analyses.
