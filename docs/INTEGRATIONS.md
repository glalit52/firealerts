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
| `twilio_voice` | Account SID, auth token, caller number, phone numbers | Places a call that reads the alert twice, in the organisation's language |
| `push` | Nothing: members enable it per device in **Settings → Notifications** | Web Push (VAPID, RFC 8291) to installed PWAs and desktop browsers; expired devices are removed automatically |
| `pagerduty` | Events API v2 routing key | Incidents de-duplicated per alert |
| `webhook` | Endpoint URL, optional signing secret | JSON body, HMAC-SHA256 signature (see ARCHITECTURE.md) |

Use **Send test** on each connector. Alert texts are written in the organisation's language (English, Spanish or
Portuguese; **Settings → Organisation**), account e-mails in each user's own language.

Detections on known static heat sources (active volcanoes, plus cells that burn on most days, learned daily from the
archive, e.g. flares and industrial furnaces) are labelled on the map and never trigger alerts. Routing is controlled by **notification rules** (assets × alert types × minimum severity → connectors).

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
Himawari (P-Tree), Meteosat (LSA SAF) and all notification channels, including Web Push (the encryption and VAPID
signature are verified in tests, but no real push service was reachable). Run them once with real credentials before relying on them.
