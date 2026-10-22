# Firealerts

Satellite wildfire detection, fire-danger forecasting, **terrain-aware probabilistic fire-spread prediction** and **machine-learned ignition risk** in one self-hostable platform, with multi-tenant accounts for running it as a service.

Firealerts pulls active-fire detections from polar-orbiting and geostationary satellites, groups them into incidents and ranks them by priority. For any incident, or any hypothetical ignition point, it forecasts where the fire is likely to be over the next 1–72 hours, using real terrain and fuels, with uncertainty bands and a burn-probability map. Areas of interest send alerts by e-mail, webhook (Slack, Teams, custom) or Telegram within minutes of a detection.

## What it does

| Capability | How |
|---|---|
| **Detection, global and multi-sensor** | NASA FIRMS VIIRS (NOAA-20, NOAA-21, S-NPP · 375 m) and MODIS (1 km). Geostationary coverage every 10–15 minutes from **GOES-East/West** (Americas, read from NOAA's public AWS buckets), **Himawari-9** (Asia/Oceania, JAXA P-Tree) and **Meteosat** (Europe/Africa, EUMETSAT LSA SAF FRP-PIXEL). |
| **Incidents** | Hotspots are grouped into incidents with single-linkage clustering (2.5 km). Each has a footprint, area, FRP, per-sensor provenance and a 0–100 **priority score**. |
| **Static heat sources** | Incidents within 5 km of a Smithsonian GVP Holocene volcano, or within 2 km of a VIIRS Nightfire / World Bank GGFR gas flare or a learned persistent hotspot, are tagged `static_source`. A learned hotspot is a ~400 m cell with detections on most days of the last 30. Tagged incidents get 10 % of their priority, and area alerts skip them unless the area sets `include_static`. The web console hides them by default. |
| **Fire danger forecast** | The full **Canadian Forest Fire Weather Index System** (FFMC, DMC, DC, ISI, BUI, FWI), spun up over 45–60 days of observed weather and run 7 days ahead with Open-Meteo. It has hemisphere-correct day-length factors and EFFIS danger classes. |
| **Ignition-risk model** | Gradient-boosted trees with isotonic calibration predict P(fire detection in a cell on a day) for today and 7 days ahead. Features: FWI components, weather, WorldCover land-cover fractions, terrain, season and recent nearby fire activity. Training uses the **FIRMS archive × Open-Meteo historical weather** with a time-ordered train/test split. A transparent FWI baseline is used until you train a model. |
| **Terrain-aware spread** | Each grid cell carries an FBP fuel type derived from **ESA WorldCover 10 m** and slope and aspect from **AWS Terrain Tiles**. The FBP slope effect is converted to an equivalent wind and added vectorially to the forecast wind. Water, built-up and bare ground act as barriers. Arrival time comes from an **ordered-upwind minimum-travel-time solver** (numba) driven by the hourly wind, humidity and hourly FFMC. |
| **Exact uniform-fuel spread** | A second solver propagates the front's *support function* (exact Huygens growth for homogeneous conditions) in ~0.1 s. It sizes the terrain domain, serves as the fallback when terrain data is unavailable, and is the accuracy reference for the raster solver. |
| **Uncertainty** | Ensembles perturb wind speed (±20 %), direction (±15°) and ROS (±25 %). Outputs: P50 and P90 perimeters per horizon, P10/P50/P90 areas, the maximum run distance, a burn-probability map, an arrival-time map and a fuel map. |
| **What-if** | Click anywhere to simulate an ignition. |
| **Alerts** | Circle or polygon areas with a buffer, a minimum confidence and per-area channels, scoped to an organisation. |
| **Accounts (SaaS)** | Users, organisations, roles (viewer, member, admin, owner), e-mail invites, session tokens and API keys (stored as hashes only), scrypt passwords and login throttling. With `AUTH_REQUIRED=false` a single-user install needs no login. |
| **Offline demo** | `DATA_MODE=auto` falls back to deterministic synthetic fires, weather and terrain when feeds are unreachable. |

## Quick start

```bash
pip install -r requirements.txt
uvicorn firealerts.main:app --reload
# open http://localhost:8000
```

Or with Docker:

```bash
cp .env.example .env   # optional: FIRMS_MAP_KEY, REGION_BBOX, JAXA/LSA SAF accounts, notifications
docker compose up --build
```

### Train the ignition model for your region

```bash
# Real data: FIRMS archive (needs a free MAP_KEY) + Open-Meteo historical weather
python -m firealerts.ml.train --bbox -66,-34,-62,-29 --start 2024-01-01 --end 2025-12-31 --map-key YOUR_KEY
# Offline smoke test on the synthetic data set
python -m firealerts.ml.train --demo
```

The model is written to `MODEL_PATH`, and its test metrics against the FWI baseline are written alongside it as JSON. The API picks up a new model without a restart.

### Configuration

All settings are environment variables (see [`.env.example`](.env.example)):

- `DATA_MODE`: `live`, `demo` or `auto` (the default; live with a demo fallback).
- `FIRMS_MAP_KEY`, `REGION_BBOX`: FIRMS area API and a regional subset (recommended).
- `GOES_ENABLED`, `GOES_SATELLITES`: GOES ingestion (`goes19` = East, `goes18` = West).
- `JAXA_FTP_USER`/`JAXA_FTP_PASSWORD`: Himawari-9 wildfire product (free [P-Tree account](https://www.eorc.jaxa.jp/ptree/registration_top.html)).
- `LSASAF_USER`/`LSASAF_PASSWORD`: Meteosat FRP-PIXEL (free [LSA SAF account](https://lsa-saf.eumetsat.int/)).
- `TERRAIN_ENABLED`: the terrain-aware spread model (on by default).
- `STATIC_SOURCES`, `STATIC_RADIUS_KM`, `STATIC_VOLCANO_RADIUS_KM`, `STATIC_LEARN_*`: static heat-source flagging.
- `MODEL_PATH`: the trained ignition model.
- `AUTH_REQUIRED`, `REGISTRATION_OPEN`: accounts and multi-tenancy.
- `ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `SMTP_*`, `PUBLIC_URL`: notifications and invite links.
- `DATABASE_URL`: SQLite by default. Any SQLAlchemy URL works.

## API

Interactive docs are served at `/docs`. When `AUTH_REQUIRED=true`, send `Authorization: Bearer <session token or API key>` and optionally `X-Org-Id`.

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Feed health, per-sensor counts, recent ingest runs |
| `GET /api/detections`, `GET /api/incidents[/{id}]` | Hotspots (GeoJSON) and ranked incidents |
| `GET /api/incidents/{id}/forecast?model=auto\|raster\|uniform&fuel=&hours=&members=` | Ensemble spread forecast |
| `GET /api/forecast/spread?lat=&lon=&…` | What-if spread from a point |
| `GET /api/danger?lat=&lon=`, `GET /api/danger/grid?bbox=` | FWI series and gridded FWI forecast |
| `GET /api/risk/ignition?bbox=&n=`, `GET /api/risk/model` | Gridded ignition probability; model card |
| `GET/POST/DELETE /api/aois`, `GET /api/alerts` | Alert areas and history (per organisation) |
| `POST /api/auth/register\|login\|logout`, `GET /api/me` | Accounts |
| `GET/PATCH /api/org…`, `POST /api/org/invites`, `GET/POST/DELETE /api/keys` | Team, invites, API keys |
| `POST /api/ingest` | Run an ingest now (admin) |

## Architecture

```
firealerts/
  sources/   firms.py · goes.py · himawari.py · meteosat.py   (detections)
             weather.py (Open-Meteo + FWI driver) · terrain.py (Terrain Tiles + WorldCover COG reader) · demo.py
  science/   fwi.py (CFFWIS) · spread.py (FBP + exact support-function Huygens)
             raster_spread.py (terrain/fuel-aware ordered-upwind MTT, numba) · cluster.py
  ml/        features.py · dataset.py (FIRMS archive × weather) · model.py · train.py · risk.py
  forecasting.py  model choice, domain sizing, fallbacks
  auth.py    accounts, organisations, roles, tokens, invites
  ingest.py · alerts.py · notifiers.py · main.py (FastAPI + scheduler + web app)
web/         MapLibre GL console (no build step)
tests/       71 tests: reference values, solver accuracy, parsers, auth, API flows
```

### Validation

- **FWI:** reproduces the Van Wagner & Pickett (1985) reference day to 0.1.
- **Uniform spread:** a windless point gives exactly πr².
- **Raster spread vs the exact Huygens solution** (homogeneous fuel, 6 h): 98 % of the area in calm conditions, 93–95 % at L:B ≈ 5 (25–40 km/h) and 89 % at L:B ≈ 7.3, with run distance within 2–3 %. A plain 16-neighbour shortest-path solver recovers only ~55 % at L:B 5, which is why the ordered-upwind update is used.
- **Live data:** the GOES reader was run against current NOAA GOES-18/19 files. That run found and fixed an antimeridian longitude bug. The WorldCover reader and Terrain Tiles were checked against live AWS data (Sierras de Córdoba, Paradise CA, open ocean).
- **ML pipeline:** checked end to end on the synthetic data set with a known fire process (AUC 0.88, calibrated Brier 0.035 vs 0.133 for the baseline). Skill on real data depends on your region and period; see the model card at `/api/risk/model`.

## Limitations

These are decision-support forecasts, not operational fire-behaviour analyses.

- **Fuels:** the WorldCover-to-FBP mapping is a latitude-aware approximation (e.g. shrubland → S1 proxy, tropical forest → D1). A national fuel map should replace it where one exists.
- **Not modelled:** spotting, crown-fire transition, suppression and fuel moisture variation within a domain.
- **Raster resolution:** the grid has at most 160 × 160 cells, so large 48–72 h domains run at coarse cells (several hundred metres). When a fire reaches the domain edge the UI flags it, and areas become a lower bound.
- **Untested sources:** Himawari and Meteosat ingestion follow the providers' published formats with tolerant parsers. They haven't been tested against live files because they need registered accounts.
- **False positives:** gas flares and volcanoes appear as detections, as with every hotspot product. A static-source mask is a planned improvement.

## Development

```bash
pip install -r requirements-dev.txt
pytest -q
DATA_MODE=demo uvicorn firealerts.main:app --reload   # fully offline
```

## Data credits

NASA FIRMS (LANCE), NOAA GOES-R on AWS (NODD), JAXA Himawari Monitor P-Tree, EUMETSAT LSA SAF, Open-Meteo, ESA WorldCover 2021 (CC BY 4.0), AWS Terrain Tiles (Mapzen/Tilezen; SRTM, GMTED, ETOPO1 and others), OpenStreetMap contributors, CARTO and Esri basemaps. Please respect each provider's terms of use.
