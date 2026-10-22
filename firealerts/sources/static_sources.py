"""Persistent non-wildfire heat sources: volcanoes, gas flares and learned hot cells.

Every hotspot product sees these, and left alone they top the incident list and trip
area alerts. Three lists are combined into one proximity index:

* volcanoes: the Smithsonian GVP Holocene volcano list (bundled, ``data/volcanoes.csv``)
* gas flares: the VIIRS Nightfire / World Bank GGFR global flare catalogue
  (bundled, ``data/gas_flares.csv``)
* learned persistence: ~400 m grid cells with detections on most days of the recent
  history, tracked in the ``heat_cells`` table so it outlives detection retention
"""

from __future__ import annotations

import csv
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..db import Detection, HeatCell, IngestRun
from ..geo import haversine_km

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

FLARE_KINDS = {
    "upstream": "Upstream oil/gas flare",
    "refinery": "Refinery flare",
    "gas": "Gas facility flare",
    "gpp": "Gas processing plant flare",
    "opp": "Oil processing plant flare",
    "lng": "LNG terminal flare",
}


@dataclass(frozen=True)
class StaticSource:
    type: str  # volcano / flare / persistent
    name: str
    lat: float
    lon: float
    radius_km: float


class StaticIndex:
    """Grid-hashed lookup of the nearest static source whose radius covers a point."""

    def __init__(self, sources: Iterable[StaticSource]):
        self.sources = list(sources)
        max_r = max((s.radius_km for s in self.sources), default=1.0)
        n = math.floor(360 / max(max_r / 111.0, 0.05))
        self.cell = 360 / n  # divides 360 exactly so longitude cells wrap at the antimeridian
        self.nx = n
        self.grid: dict[tuple[int, int], list[StaticSource]] = defaultdict(list)
        for s in self.sources:
            self.grid[self._key(s.lat, s.lon)].append(s)

    def __len__(self) -> int:
        return len(self.sources)

    def _key(self, lat: float, lon: float) -> tuple[int, int]:
        return math.floor(lat / self.cell), math.floor((lon + 180) / self.cell) % self.nx

    def match(self, lat: float, lon: float) -> tuple[StaticSource, float] | None:
        """The closest source within its own radius of (lat, lon), with its distance in km."""
        if not self.sources:
            return None
        gy, gx = self._key(lat, lon)
        span = math.ceil(1 / max(math.cos(math.radians(min(abs(lat) + self.cell, 89))), 1e-3))
        best: tuple[StaticSource, float] | None = None
        for dy in (-1, 0, 1):
            for dx in range(-span, span + 1):
                for s in self.grid.get((gy + dy, (gx + dx) % self.nx), ()):
                    d = haversine_km(lat, lon, s.lat, s.lon)
                    if d <= s.radius_km and (best is None or d < best[1]):
                        best = (s, d)
        return best


def _rows(name: str) -> list[dict]:
    with open(DATA_DIR / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


@lru_cache(maxsize=4)
def bundled(volcano_radius_km: float, flare_radius_km: float) -> tuple[StaticSource, ...]:
    out = [StaticSource("volcano", r["name"], float(r["lat"]), float(r["lon"]), volcano_radius_km) for r in _rows("volcanoes.csv")]
    for r in _rows("gas_flares.csv"):
        label = FLARE_KINDS.get(r["kind"], "Gas flare")
        out.append(StaticSource("flare", f"{label}, {r['country']}", float(r["lat"]), float(r["lon"]), flare_radius_km))
    return tuple(out)


# ----------------------------------------------------------------------------- learned persistence


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


CELL_M = 400.0
_DLAT = CELL_M / 111_320


def cell_of(lat: float, lon: float) -> tuple[int, int]:
    """Equal-area-ish ~400 m cells: fixed latitude rows, longitude columns scaled per row."""
    iy = math.floor((lat + 90) / _DLAT)
    nx = _row_cols(iy)
    return iy, math.floor((lon + 180) / 360 * nx) % nx


def _row_cols(iy: int) -> int:
    lat_c = -90 + (iy + 0.5) * _DLAT
    return max(1, int(360 * 111_320 * math.cos(math.radians(lat_c)) / CELL_M))


def cell_center(iy: int, ix: int) -> tuple[float, float]:
    return -90 + (iy + 0.5) * _DLAT, -180 + (ix + 0.5) * 360 / _row_cols(iy)


def record(session: Session, detections: list[Detection], window_days: int, today: date | None = None) -> int:
    """Add each detection's UTC day to its grid cell; drop cells quiet for the whole window."""
    start = (today or _utc_today()).toordinal() - window_days + 1
    by_cell: dict[str, set[int]] = defaultdict(set)
    for d in detections:
        day = d.acq_time.date().toordinal()
        if day >= start:
            iy, ix = cell_of(d.lat, d.lon)
            by_cell[f"{iy}:{ix}"].add(day)
    ids = list(by_cell)
    existing: dict[str, HeatCell] = {}
    for i in range(0, len(ids), 900):
        existing.update((c.id, c) for c in session.scalars(select(HeatCell).where(HeatCell.id.in_(ids[i : i + 900]))))
    for cid, days in by_cell.items():
        cell = existing.get(cid)
        if cell is None:
            lat, lon = cell_center(*(int(v) for v in cid.split(":")))
            cell = HeatCell(id=cid, lat=lat, lon=lon, days=[])
            session.add(cell)
        merged = sorted(d for d in set(cell.days or []) | days if d >= start)
        cell.days, cell.n_days, cell.last_day = merged, len(merged), merged[-1]
    session.execute(delete(HeatCell).where(HeatCell.last_day < start))
    return len(by_cell)


def learned(session: Session, cfg: Settings, today: date | None = None) -> list[StaticSource]:
    """Cells with detections on at least STATIC_LEARN_FRACTION of the observed days in the window.

    Observed days are the days an ingest fetched data. Nothing is learned until there are
    STATIC_LEARN_MIN_DAYS of them, so a fire that burns for a week is not mistaken for a flare.
    """
    today_o = (today or _utc_today()).toordinal()
    start = today_o - cfg.static_learn_days + 1
    since = datetime.combine(date.fromordinal(start), time(), tzinfo=timezone.utc)
    runs = session.scalars(select(IngestRun.started_at).where(IngestRun.started_at >= since, IngestRun.fetched > 0))
    observed = {r.date().toordinal() for r in runs}
    need = max(1, math.ceil(cfg.static_learn_fraction * cfg.static_learn_min_days))
    out = []
    for c in session.scalars(select(HeatCell).where(HeatCell.n_days >= need, HeatCell.last_day >= start)):
        days = {d for d in c.days if d >= start}
        obs = len(observed | days)
        if obs >= cfg.static_learn_min_days and len(days) >= cfg.static_learn_fraction * obs:
            out.append(StaticSource("persistent", f"Persistent hotspot ({len(days)} of {obs} days)", c.lat, c.lon, cfg.static_radius_km))
    return out


def index_for(session: Session, cfg: Settings, today: date | None = None) -> StaticIndex:
    if not cfg.static_sources_enabled:
        return StaticIndex([])
    return StaticIndex([*bundled(cfg.static_volcano_radius_km, cfg.static_radius_km), *learned(session, cfg, today)])
