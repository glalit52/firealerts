"""Spread-forecast orchestration: weather, terrain, model choice and fallbacks."""

from __future__ import annotations

import asyncio
import logging
import math

import httpx
import numpy as np

from .science import raster_spread, spread
from .sources import terrain, weather

log = logging.getLogger(__name__)

MAX_CELLS = 160  # per side of the terrain grid
MIN_HALF_M, MAX_HALF_M = 3000.0, 60000.0


class ForecastError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def plan_grid(lat: float, lon: float, uniform: dict) -> terrain.Grid:
    """Size the terrain grid from the uniform model's P90 envelope, with margin."""
    proj = terrain.Grid(lat, lon, 1, 1, 1).proj
    half = MIN_HALF_M
    for f in uniform["perimeters"]["features"]:
        if f["properties"]["kind"] != "p90":
            continue
        for x, y in (proj.to_xy(c[0], c[1]) for c in f["geometry"]["coordinates"][0]):
            half = max(half, abs(x) * 1.25 + 1500, abs(y) * 1.25 + 1500)
    half = min(half, MAX_HALF_M)
    cell = max(30.0, 2 * half / MAX_CELLS)
    n = int(math.ceil(2 * half / cell))
    return terrain.Grid(lat, lon, n, n, cell)


def _fuel_codes(lc: np.ndarray, lat: float, override: str | None) -> np.ndarray:
    lut = {c: spread.fuel_for_landcover(c, lat) for c in terrain.LANDCOVER_NAMES}
    codes = np.vectorize(lambda c: lut.get(int(c)) or "", otypes=[object])(lc)
    if override:
        codes[codes != ""] = override
    return raster_spread.fuel_index(codes)


async def run_spread(
    client: httpx.AsyncClient | None,
    points: list[tuple[float, float, float]],
    lat: float,
    lon: float,
    fuel: str = "auto",
    curing: float = 85.0,
    hours: int = 24,
    members: int = 32,
    model: str = "auto",
    mode: str = "auto",
    terrain_enabled: bool = True,
) -> dict:
    if fuel != "auto" and fuel not in spread.FUELS:
        raise ForecastError(400, f"unknown fuel type {fuel}; options: auto, {', '.join(spread.FUELS)}")
    if model not in ("auto", "raster", "uniform"):
        raise ForecastError(400, "model must be auto, raster or uniform")
    try:
        fw = await weather.fire_weather(client, lat, lon, mode)
    except Exception as exc:
        raise ForecastError(502, f"weather unavailable: {exc}")
    horizons = [h for h in (1, 3, 6, 12, 24, 48, 72) if h <= hours]
    uniform_fuel = spread.auto_fuel(lat) if fuel == "auto" else fuel

    def uniform_inputs(n_members: int) -> spread.SpreadInputs:
        return spread.SpreadInputs(points, fw["hourly"], fw["state"], uniform_fuel, curing, horizons, n_members)

    try:
        uniform = await asyncio.to_thread(spread.forecast, uniform_inputs(members if model == "uniform" else 8))
    except ValueError as exc:
        raise ForecastError(422, str(exc))

    result = None
    note = None
    if model != "uniform" and terrain_enabled:
        try:
            grid = plan_grid(lat, lon, uniform)
            tr = await terrain.load(client, grid, mode)
            slope, upslope = terrain.slope_aspect(tr["elevation"], grid.cell_m)
            fidx = _fuel_codes(tr["landcover"], lat, None if fuel == "auto" else fuel)
            inp = raster_spread.RasterInputs(grid, fidx, slope, upslope, points, fw["hourly"], fw["state"], curing, horizons, min(members, 32))
            result = await asyncio.to_thread(raster_spread.forecast_raster, inp)
            lc = tr["landcover"]
            classes, counts = np.unique(lc, return_counts=True)
            result["terrain"] = {
                "source": tr["source"],
                "cell_m": round(grid.cell_m),
                "size_km": round(grid.nx * grid.cell_m / 1000, 1),
                "elevation_m": [round(float(tr["elevation"].min())), round(float(tr["elevation"].max()))],
                "slope_pct_p50": round(float(np.percentile(slope, 50)), 1),
                "slope_pct_p90": round(float(np.percentile(slope, 90)), 1),
                "landcover": {terrain.LANDCOVER_NAMES.get(int(c), str(c)): round(100 * int(n) / lc.size, 1) for c, n in zip(classes, counts)},
            }
        except Exception as exc:
            if model == "raster":
                raise ForecastError(502, f"terrain model failed: {exc}")
            log.warning("terrain-aware forecast failed (%s); using uniform model", exc)
            note = f"Terrain-aware model unavailable ({type(exc).__name__}); showing uniform-fuel forecast."
    if result is None:
        result = uniform if model == "uniform" else await asyncio.to_thread(spread.forecast, uniform_inputs(members))
        result["model"] = "uniform"
    result["model_note"] = note
    result["weather_source"] = fw["source"]
    result["danger"] = fw["days"]
    result["current"] = fw["current"]
    return result
