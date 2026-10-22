# Firealerts

Satellite wildfire detection, fire-danger forecasting and **probabilistic fire-spread prediction** in one self-hosted platform.

Firealerts pulls active-fire detections from polar-orbiting and geostationary satellites, groups them into incidents, ranks them by priority, and for any incident (or any hypothetical ignition point) forecasts where the fire is likely to be over the next 1–72 hours, along with uncertainty bands and a burn-probability map. Areas of interest send alerts by e-mail, webhook (Slack, Teams, custom) or Telegram within minutes of a detection.

![stack](https://img.shields.io/badge/python-3.11+-blue) ![license](https://img.shields.io/badge/status-alpha-orange)

## What it does

| Capability | How |
|---|---|
| **Detection, multi-sensor** | NASA FIRMS VIIRS (NOAA-20, NOAA-21, S-NPP · 375 m) and MODIS (1 km), plus **GOES-East/West ABI FDC** full-disk fire product every 10 minutes, read straight from NOAA's public AWS buckets for near-instant detection over the Americas. |
| **Incidents** | Hotspots are grouped into incidents with single-linkage clustering (2.5 km) on a spatial hash. Each incident gets a footprint, area, FRP totals, per-sensor provenance and a 0–100 **priority score** (radiative power, recency, size, growth). |
| **Fire danger forecast** | Full **Canadian Forest Fire Weather Index System** (FFMC, DMC, DC, ISI, BUI, FWI), spun up over 45–60 days of observed weather and carried 7 days into the forecast with Open-Meteo. It has latitude-correct day-length factors for both hemispheres and EFFIS danger classes. It can show a point outlook or a gridded map for the current view. |
| **Spread forecast** | Canadian **FBP System** rate of spread for 11 fuel types (BUI effect, grass curing, back-fire ROS, length-to-breadth). The front is propagated with Huygens elliptical growth driven by the hourly forecast wind and an hourly FFMC (Van Wagner 1977), so night-time slow-downs and wind shifts come through. |
| **Uncertainty** | A 32-member ensemble perturbs wind speed (±20 %), direction (±15°) and ROS (±25 %). The output has a **likely (P50) perimeter**, a **P90 envelope** for each horizon, P10/P50/P90 areas, the maximum run distance and a **burn-probability grid**. |
| **What-if** | You can click anywhere to simulate an ignition and see where it could go under the current forecast. |
| **Alerts** | Circle or polygon areas, with a buffer distance, a minimum confidence and per-area channels. Alerts are de-duplicated and only fire on detections less than 6 h old. |
| **Offline demo** | `DATA_MODE=auto` falls back to deterministic synthetic fires and weather when feeds are unreachable. The whole product works on a laptop with no keys. |

## Quick start

```bash
pip install -r requirements.txt
uvicorn firealerts.main:app --reload
# open http://localhost:8000
```

Or with Docker:

```bash
cp .env.example .env   # optional: add FIRMS_MAP_KEY, REGION_BBOX, notification settings
docker compose up --build
```

The first ingest runs at startup and then every `POLL_MINUTES`. The ↻ button forces a sync.

### Configuration

All settings are environment variables (see [`.env.example`](.env.example)):

- `DATA_MODE`: `live`, `demo` or `auto` (the default; live with a demo fallback).
- `FIRMS_MAP_KEY`: optional. Without it the public global 24 h CSVs are used. With it the FIRMS area API is used, so `REGION_BBOX` is filtered server-side.
- `REGION_BBOX`: `west,south,east,north`. This is recommended for regional deployments: it keeps the database small and makes clustering instant.
- `GOES_ENABLED`, `GOES_SATELLITES`: geostationary ingestion (`goes19` = East, `goes18` = West).
- `ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `SMTP_*`: notification channels. Per-area e-mail, webhook and Telegram chat ids are set in the UI or API.
- `DATABASE_URL`: SQLite by default. Any SQLAlchemy URL works (e.g. PostgreSQL).

## API

Interactive docs are served at `/docs`.

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Feed health, per-sensor counts, recent ingest runs |
| `GET /api/detections?hours=&bbox=&sources=` | Hotspots as GeoJSON |
| `GET /api/incidents?hours=&bbox=&min_count=` | Incidents ranked by priority |
| `GET /api/incidents/{id}` | Incident detail, detections and hourly timeline |
| `GET /api/incidents/{id}/forecast?fuel=&curing=&hours=&members=` | Ensemble spread forecast |
| `GET /api/forecast/spread?lat=&lon=&…` | What-if spread from a point |
| `GET /api/danger?lat=&lon=` | FWI series (14 days observed + 7 days forecast) and hourly weather |
| `GET /api/danger/grid?bbox=&n=` | Gridded FWI forecast |
| `GET/POST/DELETE /api/aois` | Alert areas |
| `GET /api/alerts` | Alert history |
| `POST /api/ingest` | Run an ingest now |

## Architecture

```
firealerts/
  sources/   firms.py (VIIRS/MODIS) · goes.py (ABI FDC, fixed-grid → lat/lon) · weather.py (Open-Meteo + FWI driver) · demo.py
  science/   fwi.py (CFFWIS) · spread.py (FBP + ensemble Huygens growth) · cluster.py (incidents, priority)
  ingest.py  fetch → normalise → de-duplicate → store → purge → alert
  alerts.py  area matching · notifiers.py (webhook / Telegram / SMTP)
  main.py    FastAPI app, background scheduler, static web app
web/         MapLibre GL console (no build step)
tests/       pytest: FWI reference values, spread geometry, clustering, parsers, API flow
```

**About the spread solver.** Within an hour the forecast weather is uniform over an incident. In that case the Huygens envelope of elliptical wavelets around a convex front is exactly the Minkowski sum of the front and the hourly ellipse. Firealerts stores each front as its *support function* h(θ) on 144 directions, so an hour of growth is a vector addition `h += h_ellipse`. This is exact, it can't produce tangled perimeters, and the whole ensemble runs in about 0.1 s.

## Limitations and roadmap

These are decision-support forecasts, not operational fire-behaviour analyses.

- **Fuels:** without a land-cover layer, `auto` uses C2 (boreal spruce) above 50° latitude and O1b (standing grass) elsewhere. Pick the fuel in the UI for better results. *Next:* ESA WorldCover / Copernicus fuel maps.
- **Terrain:** the slope effect isn't modelled yet. *Next:* a DEM slope factor (FBP ISF), with spatially varying spread on a raster level-set.
- **Barriers and suppression:** roads, water and containment lines aren't considered.
- **Geostationary coverage:** only GOES (the Americas) is supported today. *Next:* Himawari-9 (Asia/Oceania) and Meteosat (Europe/Africa) fire products.
- **ML ignition-risk model:** a gradient-boosted model trained on FIRMS history × FWI × land cover would produce next-day ignition probability.
- **Multi-tenant SaaS:** user accounts, organisations and a mobile push app.

## Development

```bash
pip install -r requirements-dev.txt
pytest -q
DATA_MODE=demo uvicorn firealerts.main:app --reload   # fully offline
```

## Data credits

NASA FIRMS (LANCE), NOAA GOES-R on AWS (NODD), Open-Meteo, OpenStreetMap contributors, CARTO and Esri basemaps. Please respect each provider's terms of use.
