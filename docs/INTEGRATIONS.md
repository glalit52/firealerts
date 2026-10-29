# Integrations

Organisations configure integrations in **Integrations** (API: `/api/connectors`). Field definitions come from
`GET /api/meta` → `connector_types`, so the UI renders each form automatically. Secret fields are encrypted at rest.

## Notification channels

| Type | What you need | Notes |
|---|---|---|
| `email` | Recipients and/or "all members" | Uses the server's SMTP or SendGrid; a per-connector SendGrid key overrides it |
| `slack` | Incoming webhook URL (Slack app → Incoming Webhooks) | Block Kit message with an "Open in Firealerts" button |
| `teams` | Workflow / incoming webhook URL | Adaptive Card |
| `discord` | Channel webhook URL | Embed coloured by severity |
| `telegram` | Chat ID (+ bot token unless set server-wide) | Create a bot with @BotFather, add it to the group |
| `twilio_sms` / `twilio_whatsapp` | Account SID, auth token, sender, recipients | WhatsApp requires an approved sender or the Twilio sandbox |
| `pagerduty` | Events API v2 routing key | Incidents de-duplicated per alert |
| `webhook` | Endpoint URL, optional signing secret | JSON body, HMAC-SHA256 signature (see ARCHITECTURE.md) |

Use **Send test** on each connector. Routing is controlled by **notification rules** (assets × alert types × minimum severity → connectors).

## Data sources

### Built in (no credentials)

| Source | Used for |
|---|---|
| NASA FIRMS VIIRS/MODIS | Global fire detections (public 24 h files; a `FIRMS_MAP_KEY` enables regional queries and the archive) |
| NOAA GOES-18/19 ABI FDC (AWS) | 10-minute fire detections over the Americas |
| Copernicus Sentinel-2 L2A (AWS Open Data, Earth Search STAC) | NDVI / NBR / NDMI per asset, dNBR burn severity, index imagery |
| MODIS MCD64A1 (Microsoft Planetary Computer) | Monthly burned-area history per asset |
| ESA WorldCover 2021, AWS Terrain Tiles | Fuel map and slope for the terrain-aware spread model and ML features |
| Open-Meteo, NASA POWER | Weather (forecast + history; POWER as fallback) |
| OpenStreetMap Overpass | Exposure: settlements, buildings, roads around assets |
| NASA GIBS, EOX Sentinel-2 cloudless, Esri, CARTO | Map layers in the browser |

### Free accounts (server-wide, `.env`)

- **Himawari-9** wildfire product: register at JAXA P-Tree, set `JAXA_FTP_USER`/`JAXA_FTP_PASSWORD`.
- **Meteosat** FRP-PIXEL: register at EUMETSAT LSA SAF, set `LSASAF_USER`/`LSASAF_PASSWORD`.

### Per-organisation connectors

- **Google Earth Engine** (`gee`): create a Google Cloud service account with the Earth Engine API enabled and register it for Earth Engine; paste the JSON key. Enables Earth Engine burned-area history (MCD64A1), Hansen forest loss and Sentinel-2 monthly series. A server-wide key can be set with `GEE_SERVICE_ACCOUNT_JSON`.
- **Global Forest Watch** (`gfw`): request a Data API key at globalforestwatch.org → tree-cover loss by year and integrated deforestation alerts for each asset.
- **NASA FIRMS** (`firms`): your own MAP_KEY.

## Verification status

Live-tested from the development sandbox: NOAA GOES, Sentinel-2 on AWS (search, statistics, burn severity, imagery),
ESA WorldCover and AWS Terrain Tiles. Built to published specifications and tested against mocked responses (the sandbox
blocks these hosts): FIRMS, Open-Meteo, NASA POWER, Planetary Computer, Earth Engine, Global Forest Watch, Overpass,
Himawari (P-Tree), Meteosat (LSA SAF) and all notification channels. Run them once with real credentials before relying on them.
