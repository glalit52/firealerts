"""Training data: one row per (grid cell, day), label = any satellite fire detection that day.

* `live_dataset` builds it from the NASA FIRMS archive (VIIRS S-NPP standard
  product) and Open-Meteo historical weather, plus WorldCover/terrain statistics.
* `synthetic_dataset` builds a self-contained data set from the offline weather
  generator with a known, non-trivial fire process, for tests and demos.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import httpx
import numpy as np

from ..science import fwi as F
from ..sources import firms, weather
from ..sources.demo import SCENARIOS
from . import features

log = logging.getLogger(__name__)

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
SPINUP_DAYS = 60


def _cells(bbox, cell_deg):
    w, s, e, n = bbox
    nx, ny = max(1, round((e - w) / cell_deg)), max(1, round((n - s) / cell_deg))
    return [(j, i, s + (j + 0.5) * cell_deg, w + (i + 0.5) * cell_deg) for j in range(ny) for i in range(nx)]


def _recent(counts: dict, j: int, i: int, d: date, days: int = 7) -> int:
    total = 0
    for dd in range(1, days + 1):
        day = d - timedelta(days=dd)
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                total += counts.get((j + dj, i + di, day), 0)
    return total


async def firms_archive(client: httpx.AsyncClient, map_key: str, bbox, start: date, end: date, source: str = "VIIRS_SNPP_SP") -> list[dict]:
    """Archive detections in 10-day chunks (the FIRMS area API maximum)."""
    area = ",".join(f"{v:g}" for v in bbox)
    rows: list[dict] = []
    d = start
    while d <= end:
        span = min(10, (end - d).days + 1)
        url = f"{firms.BASE}/api/area/csv/{map_key}/{source}/{area}/{span}/{d.isoformat()}"
        resp = await client.get(url)
        resp.raise_for_status()
        rows += firms.parse_csv(resp.text, "VIIRS_SNPP")
        d += timedelta(days=span)
    return rows


async def archive_weather(client: httpx.AsyncClient, points, start: date, end: date, batch: int = 50) -> list[dict]:
    out = []
    for k in range(0, len(points), batch):
        chunk = points[k : k + batch]
        params = {
            "latitude": ",".join(f"{p[0]:.4f}" for p in chunk),
            "longitude": ",".join(f"{p[1]:.4f}" for p in chunk),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "hourly": weather.HOURLY_VARS,
            "timezone": "auto",
            "wind_speed_unit": "kmh",
        }
        resp = await client.get(ARCHIVE, params=params)
        resp.raise_for_status()
        data = resp.json()
        out += [weather._parse_location(loc) for loc in (data if isinstance(data, list) else [data])]
    return out


def _fwi_days(lat: float, wx: dict) -> list[dict]:
    days = weather.daily_noon(wx["hours"], wx["utc_offset"])
    series, _ = F.run_series(days, lat)
    return [d.as_dict() for d in series]


async def live_dataset(client: httpx.AsyncClient, map_key: str, bbox, start: date, end: date, cell_deg: float = 0.25):
    cells = _cells(bbox, cell_deg)
    log.info("building live data set: %d cells x %d days", len(cells), (end - start).days + 1)
    dets = await firms_archive(client, map_key, bbox, start - timedelta(days=7), end)
    w, s = bbox[0], bbox[1]
    counts: dict = defaultdict(int)
    for r in dets:
        j, i = int((r["lat"] - s) // cell_deg), int((r["lon"] - w) // cell_deg)
        counts[(j, i, r["acq_time"].date())] += 1
    wxs = await archive_weather(client, [(c[2], c[3]) for c in cells], start - timedelta(days=SPINUP_DAYS), end)
    statics = await asyncio.gather(*[features.cell_static(client, la, lo, cell_deg, mode="live") for _, _, la, lo in cells])
    return _assemble(cells, wxs, statics, counts, start, end)


def _assemble(cells, wxs, statics, counts, start: date, end: date):
    X, y, order = [], [], []
    for (j, i, la, _), wx, st in zip(cells, wxs, statics):
        for day in _fwi_days(la, wx):
            d = date.fromisoformat(day["date"])
            if not (start <= d <= end):
                continue
            X.append(features.row(day, st, la, _recent(counts, j, i, d)))
            y.append(1 if counts.get((j, i, d), 0) > 0 else 0)
            order.append(d.toordinal())
    return np.asarray(X), np.asarray(y), np.asarray(order)


def synthetic_dataset(n_cells: int = 120, n_days: int = 240, cell_deg: float = 0.25, seed: int = 7):
    """A data set with a known fire process that depends non-linearly on the features."""
    rng = random.Random(seed)
    today = datetime.now(timezone.utc).date()
    start, end = today - timedelta(days=n_days), today - timedelta(days=1)
    cells = []
    for k in range(n_cells):
        _, la0, lo0 = SCENARIOS[k % len(SCENARIOS)]
        la, lo = la0 + rng.uniform(-2, 2), lo0 + rng.uniform(-2, 2)
        cells.append((k, 0, round(la / cell_deg) * cell_deg + cell_deg / 2, round(lo / cell_deg) * cell_deg + cell_deg / 2))
    wxs = [weather.synthetic_hours(la, lo, past_days=n_days + SPINUP_DAYS, forecast_days=0) for _, _, la, lo in cells]
    statics = [asyncio.run(features.cell_static(None, la, lo, cell_deg, mode="demo")) for _, _, la, lo in cells]
    counts: dict = defaultdict(int)
    X, y, order = [], [], []
    for (j, i, la, _), wx, st in zip(cells, wxs, statics):
        human = rng.uniform(-1, 1)  # unobserved ignition pressure, the irreducible part
        for day in _fwi_days(la, wx):
            d = date.fromisoformat(day["date"])
            if not (start <= d <= end):
                continue
            recent = _recent(counts, j, i, d)
            dry_forest = st["frac_tree"] * (1 if day["dc"] > 300 else 0)
            z = (
                -9.2
                + 0.06 * day["fwi"]
                + 0.35 * math.sqrt(day["isi"])
                + 2.4 * st["frac_grass"] * (day["ffmc"] > 86)
                + 1.8 * st["frac_crop"] * math.cos(2 * math.pi * (d.timetuple().tm_yday - (220 if la >= 0 else 40)) / 365)
                + 1.6 * st["frac_shrub"]
                + 1.4 * dry_forest
                - 5.0 * st["frac_nonfuel"]
                + 0.8 * math.log1p(recent)
                - 0.25 * min(day["rain"], 12)
                + 0.7 * human
            )
            label = 1 if rng.random() < 1 / (1 + math.exp(-z)) else 0
            if label:
                counts[(j, i, d)] += 1
            X.append(features.row(day, st, la, recent))
            y.append(label)
            order.append(d.toordinal())
    return np.asarray(X), np.asarray(y), np.asarray(order)
