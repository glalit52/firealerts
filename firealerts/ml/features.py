"""Feature definitions shared by training and serving, so the two can never drift apart."""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import date

import httpx
import numpy as np

from ..sources import terrain

log = logging.getLogger(__name__)

FEATURES = [
    "fwi", "ffmc", "dmc", "dc", "isi", "bui", "temp", "rh", "wind", "rain",
    "frac_tree", "frac_shrub", "frac_grass", "frac_crop", "frac_nonfuel",
    "elev_m", "slope_pct", "doy_sin", "doy_cos", "abs_lat", "recent_fires",
]


def landcover_fractions(classes: np.ndarray) -> dict[str, float]:
    c = np.asarray(classes).ravel()
    n = max(1, c.size)
    tree = np.isin(c, (terrain.TREE, terrain.MANGROVE)).sum() / n
    shrub = (c == terrain.SHRUB).sum() / n
    grass = np.isin(c, (terrain.GRASS, terrain.WETLAND, terrain.MOSS)).sum() / n
    crop = (c == terrain.CROP).sum() / n
    return {"frac_tree": tree, "frac_shrub": shrub, "frac_grass": grass, "frac_crop": crop, "frac_nonfuel": max(0.0, 1 - tree - shrub - grass - crop)}


def row(day: dict, static: dict, lat: float, recent_fires: float) -> list[float]:
    """One feature vector. `day` is an FWIDay dict, `static` holds land cover and terrain."""
    d = date.fromisoformat(day["date"])
    doy = d.timetuple().tm_yday
    vals = {
        **{k: day[k] for k in ("fwi", "ffmc", "dmc", "dc", "isi", "bui", "temp", "rh", "wind", "rain")},
        **{k: static[k] for k in ("frac_tree", "frac_shrub", "frac_grass", "frac_crop", "frac_nonfuel", "elev_m", "slope_pct")},
        "doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "doy_cos": math.cos(2 * math.pi * doy / 365.25),
        "abs_lat": abs(lat),
        "recent_fires": math.log1p(recent_fires),
    }
    return [float(vals[k]) for k in FEATURES]


_static_cache: dict = {}


async def cell_static(client: httpx.AsyncClient | None, lat: float, lon: float, cell_deg: float, mode: str = "auto") -> dict:
    """Land-cover fractions and terrain statistics for one grid cell (cached: they don't change)."""
    key = (round(lat, 3), round(lon, 3), round(cell_deg, 3), mode)
    if key not in _static_cache:
        if len(_static_cache) > 20000:
            _static_cache.clear()
        _static_cache[key] = await _cell_static(client, lat, lon, cell_deg, mode)
    return _static_cache[key]


async def _cell_static(client, lat, lon, cell_deg, mode):
    cell_m = cell_deg * 111320 * max(0.2, math.cos(math.radians(lat)))
    grid = terrain.Grid(lat, lon, 7, 7, cell_m / 7)
    if mode != "demo" and client is not None:
        try:
            lon_g, lat_g = grid.centres_lonlat()
            lc, elev = await asyncio.gather(
                terrain.landcover_points(client, lon_g, lat_g, grid.cell_m), terrain.elevation(client, grid, max_tiles=4)
            )
            return _static(lc, elev, grid.cell_m)
        except Exception as exc:
            if mode == "live":
                raise
            log.debug("static features fall back to synthetic (%s)", exc)
    elev = terrain.synthetic_elevation(grid)
    return _static(terrain.synthetic_landcover(grid, elev), elev, grid.cell_m)


def _static(lc: np.ndarray, elev: np.ndarray, cell_m: float) -> dict:
    slope, _ = terrain.slope_aspect(elev, cell_m)
    return {**landcover_fractions(lc), "elev_m": float(np.mean(elev)), "slope_pct": float(np.mean(slope))}
