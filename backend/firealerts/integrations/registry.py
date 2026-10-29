"""Catalogue of connector types and built-in public data sources.

The frontend renders connector forms from these field definitions, so adding a
connector here (plus its implementation) is all that is needed to expose it.
Secret fields are encrypted at rest and never returned by the API.
"""

from __future__ import annotations

import httpx

from . import gee, gfw, notify

F = dict  # field definition


def field(key, label, type="text", required=True, secret=False, help="", placeholder=""):
    return F(key=key, label=label, type=type, required=required, secret=secret, help=help, placeholder=placeholder)


CONNECTOR_TYPES: dict[str, dict] = {
    "email": {
        "category": "notification",
        "label": "E-mail",
        "description": "Send alerts to addresses or to every member of the organisation.",
        "fields": [
            field("recipients", "Recipients", "list", required=False, placeholder="ops@example.com, chief@example.com"),
            field("to_members", "Also e-mail all organisation members", "bool", required=False),
            field("sendgrid_api_key", "SendGrid API key (optional, overrides the server's SMTP)", "password", required=False, secret=True),
        ],
    },
    "slack": {"category": "notification", "label": "Slack", "description": "Post to a channel through an incoming webhook.", "fields": [field("webhook_url", "Incoming webhook URL", "url", secret=True, placeholder="https://hooks.slack.com/services/…")]},
    "teams": {"category": "notification", "label": "Microsoft Teams", "description": "Post an adaptive card through a Teams workflow/incoming webhook.", "fields": [field("webhook_url", "Webhook URL", "url", secret=True)]},
    "discord": {"category": "notification", "label": "Discord", "description": "Post to a channel webhook.", "fields": [field("webhook_url", "Webhook URL", "url", secret=True)]},
    "telegram": {
        "category": "notification",
        "label": "Telegram",
        "description": "Message a chat or group from your bot.",
        "fields": [field("chat_id", "Chat ID"), field("bot_token", "Bot token (optional if the server has one)", "password", required=False, secret=True)],
    },
    "twilio_sms": {
        "category": "notification",
        "label": "SMS (Twilio)",
        "description": "Text message to one or more phone numbers.",
        "fields": [field("account_sid", "Account SID"), field("auth_token", "Auth token", "password", secret=True), field("from_number", "From number", placeholder="+15005550006"), field("to", "To numbers", "list", placeholder="+5493511234567")],
    },
    "twilio_whatsapp": {
        "category": "notification",
        "label": "WhatsApp (Twilio)",
        "description": "WhatsApp message through Twilio.",
        "fields": [field("account_sid", "Account SID"), field("auth_token", "Auth token", "password", secret=True), field("from_number", "WhatsApp sender", placeholder="+14155238886"), field("to", "To numbers", "list")],
    },
    "pagerduty": {"category": "notification", "label": "PagerDuty", "description": "Trigger incidents (Events API v2).", "fields": [field("routing_key", "Integration / routing key", "password", secret=True)]},
    "webhook": {
        "category": "notification",
        "label": "Webhook",
        "description": "POST signed JSON to your system (header X-Firealerts-Signature = sha256 HMAC of 'timestamp.body').",
        "fields": [field("url", "Endpoint URL", "url"), field("secret", "Signing secret", "password", required=False, secret=True)],
    },
    "gee": {
        "category": "data",
        "label": "Google Earth Engine",
        "description": "Burned-area history (MODIS MCD64A1), forest loss (Hansen) and Sentinel-2 time series computed in Earth Engine.",
        "fields": [field("service_account_json", "Service account key (JSON)", "textarea", secret=True), field("project", "Cloud project ID", required=False)],
    },
    "gfw": {"category": "data", "label": "Global Forest Watch", "description": "Tree-cover loss and integrated deforestation alerts for your forests.", "fields": [field("api_key", "GFW Data API key", "password", secret=True)]},
    "firms": {"category": "data", "label": "NASA FIRMS", "description": "Your own FIRMS MAP_KEY (archive queries and higher limits).", "fields": [field("map_key", "MAP_KEY", "password", secret=True)]},
}

PUBLIC_SOURCES = [
    {"id": "firms", "name": "NASA FIRMS VIIRS & MODIS", "kind": "fire detection", "coverage": "global", "cadence": "~4 passes/day", "auth": "none (MAP_KEY optional)", "url": "https://firms.modaps.eosdis.nasa.gov"},
    {"id": "goes", "name": "NOAA GOES-East/West ABI FDC", "kind": "fire detection", "coverage": "Americas", "cadence": "10 min", "auth": "none", "url": "https://registry.opendata.aws/noaa-goes/"},
    {"id": "himawari", "name": "JAXA Himawari-9 wildfire (P-Tree)", "kind": "fire detection", "coverage": "Asia / Oceania", "cadence": "10 min", "auth": "free account", "url": "https://www.eorc.jaxa.jp/ptree/"},
    {"id": "meteosat", "name": "EUMETSAT LSA SAF FRP-PIXEL", "kind": "fire detection", "coverage": "Europe / Africa", "cadence": "15 min", "auth": "free account", "url": "https://lsa-saf.eumetsat.int/"},
    {"id": "sentinel2", "name": "Copernicus Sentinel-2 L2A (AWS Open Data)", "kind": "vegetation & burn severity", "coverage": "global land", "cadence": "~5 days, 10–20 m", "auth": "none", "url": "https://registry.opendata.aws/sentinel-2-l2a-cogs/"},
    {"id": "modis_burned", "name": "MODIS MCD64A1 burned area (Planetary Computer)", "kind": "fire history", "coverage": "global", "cadence": "monthly, 500 m", "auth": "none", "url": "https://planetarycomputer.microsoft.com/dataset/modis-64A1-061"},
    {"id": "worldcover", "name": "ESA WorldCover 2021", "kind": "land cover / fuels", "coverage": "global", "cadence": "static, 10 m", "auth": "none", "url": "https://esa-worldcover.org"},
    {"id": "terrain", "name": "AWS Terrain Tiles", "kind": "elevation / slope", "coverage": "global", "cadence": "static, ~30 m", "auth": "none", "url": "https://registry.opendata.aws/terrain-tiles/"},
    {"id": "open_meteo", "name": "Open-Meteo forecast & history", "kind": "weather", "coverage": "global", "cadence": "hourly", "auth": "none", "url": "https://open-meteo.com"},
    {"id": "nasa_power", "name": "NASA POWER", "kind": "weather (fallback)", "coverage": "global", "cadence": "hourly, ~3 day latency", "auth": "none", "url": "https://power.larc.nasa.gov"},
    {"id": "osm", "name": "OpenStreetMap (Overpass)", "kind": "exposure", "coverage": "global", "cadence": "live", "auth": "none", "url": "https://overpass-api.de"},
    {"id": "gibs", "name": "NASA GIBS imagery", "kind": "map layers", "coverage": "global", "cadence": "daily", "auth": "none", "url": "https://earthdata.nasa.gov/gibs"},
    {"id": "effis", "name": "Copernicus EFFIS fire danger (WMS)", "kind": "map layers", "coverage": "Europe & global", "cadence": "daily", "auth": "none", "url": "https://effis.jrc.ec.europa.eu"},
]


def secret_keys(type_: str) -> set[str]:
    return {f["key"] for f in CONNECTOR_TYPES[type_]["fields"] if f["secret"]}


def validate(type_: str, config: dict) -> dict:
    if type_ not in CONNECTOR_TYPES:
        raise ValueError(f"unknown connector type {type_}")
    clean: dict = {}
    for f in CONNECTOR_TYPES[type_]["fields"]:
        v = config.get(f["key"])
        if f["type"] == "list":
            if isinstance(v, str):
                v = [x.strip() for x in v.replace("\n", ",").split(",") if x.strip()]
            v = list(v or [])
        elif f["type"] == "bool":
            v = bool(v)
        elif v is not None:
            v = str(v).strip()
        if f["required"] and not v:
            raise ValueError(f"'{f['label']}' is required")
        if f["type"] == "url" and v and not str(v).startswith(("https://", "http://")):
            raise ValueError(f"'{f['label']}' must be an http(s) URL")
        if v not in (None, "", []):
            clean[f["key"]] = v
    if type_ == "gee":
        gee.parse_credentials(clean["service_account_json"])
    return clean


def redact(type_: str, config: dict) -> dict:
    """Config safe to return to clients: secrets replaced by a marker."""
    out = {}
    for k, v in config.items():
        out[k] = "••••••" if k in secret_keys(type_) and v else v
    return out


def merge_update(type_: str, old: dict, new: dict) -> dict:
    """Keep stored secrets when the client sends the redaction marker or leaves them blank."""
    merged = dict(new)
    for k in secret_keys(type_):
        if new.get(k) in (None, "", "••••••") and k in old:
            merged[k] = old[k]
    return merged


async def test(client: httpx.AsyncClient, type_: str, config: dict, sample: notify.Message) -> str:
    if type_ in notify.CHANNELS:
        await notify.CHANNELS[type_](client, config, sample)
        return "test notification sent"
    if type_ == "gee":
        await gee.test(config["service_account_json"], config.get("project", ""))
        return "Earth Engine credentials work"
    if type_ == "gfw":
        return await gfw.test(client, config["api_key"])
    if type_ == "firms":
        r = await client.get("https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/", params={"MAP_KEY": config["map_key"]}, timeout=30)
        r.raise_for_status()
        return f"MAP_KEY valid: {r.text[:120]}"
    raise ValueError(f"cannot test {type_}")
