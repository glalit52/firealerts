"""NASA FIRMS active-fire detections (VIIRS 375 m and MODIS 1 km).

Without a MAP_KEY the public global 24 h CSV files are used; with one, the area
API is queried, which supports regional subsets.
"""

from __future__ import annotations

import csv
import io
import logging
from datetime import datetime, timezone

import httpx

from ..config import Settings

log = logging.getLogger(__name__)

BASE = "https://firms.modaps.eosdis.nasa.gov"

PUBLIC_CSV = {
    "VIIRS_NOAA20": f"{BASE}/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv",
    "VIIRS_NOAA21": f"{BASE}/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv",
    "VIIRS_SNPP": f"{BASE}/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv",
    "MODIS": f"{BASE}/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv",
}

API_SOURCE = {
    "VIIRS_NOAA20": "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21": "VIIRS_NOAA21_NRT",
    "VIIRS_SNPP": "VIIRS_SNPP_NRT",
    "MODIS": "MODIS_NRT",
    "LANDSAT": "LANDSAT_NRT",
}


def _confidence(raw: str) -> str:
    raw = (raw or "").strip().lower()
    if raw in {"l", "low"}:
        return "l"
    if raw in {"h", "high"}:
        return "h"
    if raw in {"n", "nominal"}:
        return "n"
    try:  # MODIS: 0-100
        v = float(raw)
    except ValueError:
        return "n"
    return "l" if v < 30 else ("h" if v >= 80 else "n")


def _float(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def parse_csv(text: str, source: str) -> list[dict]:
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            hhmm = row["acq_time"].strip().zfill(4)
            t = datetime.strptime(f"{row['acq_date']} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        scan = _float(row.get("scan")) or 0.0
        track = _float(row.get("track")) or 0.0
        default_px = 1000.0 if source == "MODIS" else (30.0 if source == "LANDSAT" else 375.0)
        pixel_m = max(scan, track) * 1000 if scan and track else default_px
        bright = _float(row.get("bright_ti4")) or _float(row.get("brightness"))
        out.append(
            {
                "id": f"{source}:{t:%Y%m%d%H%M}:{lat:.4f}:{lon:.4f}",
                "source": source,
                "satellite": (row.get("satellite") or "").strip(),
                "lat": lat,
                "lon": lon,
                "acq_time": t,
                "frp": _float(row.get("frp")),
                "brightness": bright,
                "confidence": _confidence(row.get("confidence", "")),
                "daynight": (row.get("daynight") or "").strip()[:1],
                "pixel_m": pixel_m,
            }
        )
    return out


def source_url(cfg: Settings, source: str) -> str:
    if cfg.firms_map_key and source in API_SOURCE:
        area = ",".join(str(v) for v in cfg.bbox) if cfg.bbox else "world"
        return f"{BASE}/api/area/csv/{cfg.firms_map_key}/{API_SOURCE[source]}/{area}/1"
    if source not in PUBLIC_CSV:
        raise ValueError(f"{source} needs FIRMS_MAP_KEY")
    return PUBLIC_CSV[source]


async def fetch(client: httpx.AsyncClient, cfg: Settings, source: str) -> list[dict]:
    resp = await client.get(source_url(cfg, source))
    resp.raise_for_status()
    if resp.text.lstrip().lower().startswith(("invalid", "<")):
        raise RuntimeError(f"FIRMS returned an error for {source}: {resp.text[:120]}")
    return parse_csv(resp.text, source)
