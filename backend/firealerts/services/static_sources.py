"""False-positive filtering: volcanoes, gas flares and industrial heat sources.

Two kinds of entries:
* curated volcanoes with persistent thermal activity (lava lakes, open vents);
* sources learned from the detection archive: a ~1 km cell with detections on
  at least ``MIN_DAYS`` distinct days in the last ``WINDOW_DAYS`` is a fixed heat
  source (flare stack, steel plant, kiln, landfill...), not a wildfire. Real
  wildfires move and burn out; this is the same principle as the FIRMS
  static-source masks.
Matches are tagged on detections and incidents, de-prioritised, and excluded
from detection and threat alerts.
"""

from __future__ import annotations

import math
import time
from collections import defaultdict
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..geo import haversine_km
from ..models import Detection, StaticSource

WINDOW_DAYS = 30
MIN_DAYS = 8
CELL = 0.01  # degrees (~1 km)

# (name, lat, lon) — persistently active volcanoes that routinely appear in hotspot products.
VOLCANOES = [
    ("Kīlauea", 19.421, -155.287), ("Erta Ale", 13.600, 40.670), ("Nyiragongo", -1.520, 29.250), ("Nyamuragira", -1.408, 29.200),
    ("Ambrym", -16.250, 168.120), ("Yasur", -19.532, 169.447), ("Masaya", 11.984, -86.161), ("Etna", 37.751, 14.993),
    ("Stromboli", 38.789, 15.213), ("Popocatépetl", 19.023, -98.622), ("Villarrica", -39.420, -71.930), ("Erebus", -77.530, 167.170),
    ("Fuego", 14.473, -90.880), ("Santiaguito", 14.757, -91.552), ("Sakurajima", 31.593, 130.657), ("Merapi", -7.540, 110.446),
    ("Semeru", -8.108, 112.922), ("Piton de la Fournaise", -21.244, 55.708), ("Sabancaya", -15.787, -71.857), ("Sangay", -2.005, -78.341),
    ("Reventador", -0.077, -77.656), ("Klyuchevskoy", 56.056, 160.642), ("Shiveluch", 56.653, 161.360), ("Bagana", -6.140, 155.195),
    ("Sundhnúkur / Reykjanes", 63.880, -22.370), ("Lewotolok", -8.272, 123.505), ("Karymsky", 54.049, 159.443), ("Ebeko", 50.686, 156.014),
]

_index: dict[tuple[int, int], list[tuple[str, str, float, float, float]]] = {}
_index_built = 0.0
_INDEX_TTL = 300


def _key(lat: float, lon: float) -> tuple[int, int]:
    return int(math.floor(lat * 10)), int(math.floor(lon * 10))


def ensure_curated(session: Session) -> None:
    if session.scalar(select(func.count()).select_from(StaticSource).where(StaticSource.source == "curated")):
        return
    for name, lat, lon in VOLCANOES:
        session.add(StaticSource(kind="volcano", name=name, lat=lat, lon=lon, radius_km=6.0, source="curated"))
    session.commit()


def learn(session: Session, window_days: int = WINDOW_DAYS, min_days: int = MIN_DAYS) -> int:
    """Rebuild learned persistent sources from the archive. Returns how many were found."""
    ensure_curated(session)
    since = utcnow() - timedelta(days=window_days)
    days: dict[tuple[int, int], set] = defaultdict(set)
    sums: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0, 0])
    for lat, lon, t in session.execute(select(Detection.lat, Detection.lon, Detection.acq_time).where(Detection.acq_time >= since)):
        k = (int(math.floor(lat / CELL)), int(math.floor(lon / CELL)))
        days[k].add(t.date())
        acc = sums[k]
        acc[0] += lat
        acc[1] += lon
        acc[2] += 1
    found = []
    for k, ds in days.items():
        if len(ds) >= min_days:
            la, lo, n = sums[k]
            found.append(StaticSource(kind="persistent", name="Persistent heat source", lat=la / n, lon=lo / n, radius_km=1.5, days_detected=len(ds), source="learned"))
    session.execute(delete(StaticSource).where(StaticSource.source == "learned"))
    session.add_all(found)
    session.commit()
    invalidate()
    return len(found)


def invalidate() -> None:
    global _index_built
    _index_built = 0.0


def _build(session: Session) -> None:
    global _index, _index_built
    ensure_curated(session)
    idx: dict[tuple[int, int], list] = defaultdict(list)
    for s in session.scalars(select(StaticSource).where(StaticSource.active.is_(True))):
        reach = s.radius_km / 111.0
        for la in range(int(math.floor((s.lat - reach) * 10)), int(math.floor((s.lat + reach) * 10)) + 1):
            dlon = reach / max(0.05, math.cos(math.radians(s.lat)))
            for lo in range(int(math.floor((s.lon - dlon) * 10)), int(math.floor((s.lon + dlon) * 10)) + 1):
                idx[(la, lo)].append((s.kind, s.name, s.lat, s.lon, s.radius_km))
    _index = dict(idx)
    _index_built = time.time()


def classify(session: Session, lat: float, lon: float) -> dict | None:
    """The static source covering this point, if any."""
    if time.time() - _index_built > _INDEX_TTL:
        _build(session)
    best = None
    for kind, name, la, lo, radius in _index.get(_key(lat, lon), ()):
        d = haversine_km(lat, lon, la, lo)
        if d <= radius and (best is None or d < best["distance_km"]):
            best = {"type": kind, "name": name, "distance_km": round(d, 2)}
    return best


def classify_incident(session: Session, summary: dict, detections) -> dict | None:
    """Static if the centroid is on a source, or most of its pixels are."""
    hit = classify(session, summary["lat"], summary["lon"])
    if hit:
        return hit
    tagged = [classify(session, d.lat, d.lon) for d in detections]
    hits = [h for h in tagged if h]
    if hits and len(hits) >= 0.6 * len(tagged):
        return min(hits, key=lambda h: h["distance_km"])
    return None
