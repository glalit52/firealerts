"""Microsoft Planetary Computer: public STAC catalogue with anonymous SAS signing.

Used for the MODIS MCD64A1 (500 m monthly burned area) history of an asset;
Landsat Collection 2 L2 and other collections can be searched with ``search``.
"""

from __future__ import annotations

import math
import time
from datetime import date

import httpx
import numpy as np

from .. import geo
from . import cog

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
SAS = "https://planetarycomputer.microsoft.com/api/sas/v1/token"
_tokens: dict[str, tuple[float, str]] = {}
MODIS_R = 6371007.181  # sphere radius of the MODIS sinusoidal grid


async def sas_token(client: httpx.AsyncClient, collection: str) -> str:
    hit = _tokens.get(collection)
    if hit and hit[0] > time.time():
        return hit[1]
    resp = await client.get(f"{SAS}/{collection}")
    resp.raise_for_status()
    token = resp.json()["token"]
    _tokens[collection] = (time.time() + 45 * 60, token)
    return token


async def search(client: httpx.AsyncClient, collection: str, geometry: dict, start: date, end: date, limit: int = 100, query: dict | None = None) -> list[dict]:
    body = {"collections": [collection], "intersects": geometry, "datetime": f"{start.isoformat()}/{end.isoformat()}", "limit": limit}
    if query:
        body["query"] = query
    resp = await client.post(f"{STAC}/search", json=body)
    resp.raise_for_status()
    return resp.json().get("features", [])


def sinusoidal(lat, lon):
    lat_r = np.radians(np.asarray(lat, dtype=float))
    lon_r = np.radians(np.asarray(lon, dtype=float))
    return MODIS_R * lon_r * np.cos(lat_r), MODIS_R * lat_r


def burned_fraction(burn_date: np.ndarray) -> tuple[float, int]:
    """Fraction of mapped samples burned (Burn_Date 1..366), and number of mapped samples."""
    v = burn_date[np.isfinite(burn_date)]
    mapped = v[v >= 0]  # -1 unmapped, -2 water
    if mapped.size == 0:
        return 0.0, 0
    return float(((mapped >= 1) & (mapped <= 366)).sum() / mapped.size), int(mapped.size)


async def modis_burned_area(client: httpx.AsyncClient, geometry: dict, start: date, end: date, area_ha: float) -> list[dict]:
    """Monthly burned area (ha) inside the asset from MCD64A1."""
    from .sentinel2 import sample_grid

    items = await search(client, "modis-64A1-061", geometry, start, end, limit=500)
    token = await sas_token(client, "modis-64A1-061")
    lon, lat, _ = sample_grid(geometry, 1500)
    x, y = sinusoidal(lat, lon)
    months: dict[str, list[float]] = {}
    for it in items:
        href = it["assets"].get("Burn_Date", {}).get("href")
        if not href:
            continue
        c = await cog.open_cog(client, f"{href}?{token}")
        vals = (await cog.read_points(client, c, x, y, 0))[:, 0]
        frac, n = burned_fraction(vals)
        if n == 0:
            continue
        key = it["properties"]["start_datetime"][:7] if "start_datetime" in it["properties"] else it["properties"]["datetime"][:7]
        months.setdefault(key, []).append(frac)
    return [{"month": k, "burned_ha": round(max(v) * area_ha, 1)} for k, v in sorted(months.items())]
