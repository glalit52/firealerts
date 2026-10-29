"""Group hotspots into fire incidents and score them."""

from __future__ import annotations

import hashlib
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..geo import LocalProjection, convex_hull, haversine_km, polygon_area


@dataclass
class Hotspot:
    id: str
    lat: float
    lon: float
    acq_time: datetime
    source: str
    frp: float | None = None
    confidence: str = "n"
    pixel_m: float = 375.0


@dataclass
class Incident:
    id: str
    detections: list[Hotspot] = field(default_factory=list)

    @property
    def first_seen(self) -> datetime:
        return min(d.acq_time for d in self.detections)

    @property
    def last_seen(self) -> datetime:
        return max(d.acq_time for d in self.detections)

    def active_front(self, window_h: float = 12.0) -> list[Hotspot]:
        """Detections close in time to the latest one: the best estimate of the current front.

        Fine-resolution polar-orbiter pixels (375 m–1 km) are preferred over 2 km
        geostationary pixels when both are available in the window.
        """
        last = self.last_seen
        recent = [d for d in self.detections if (last - d.acq_time).total_seconds() <= window_h * 3600]
        fine = [d for d in recent if d.pixel_m < 2000]
        return fine or recent

    def summary(self, now: datetime | None = None) -> dict:
        now = now or datetime.now(timezone.utc)
        dets = self.detections
        lat = sum(d.lat for d in dets) / len(dets)
        lon = sum(d.lon for d in dets) / len(dets)
        frps = [d.frp for d in dets if d.frp is not None]
        frp_sum = sum(frps)
        proj = LocalProjection(lat, lon)
        corners = []
        for d in dets:
            x, y = proj.to_xy(d.lon, d.lat)
            h = d.pixel_m / 2
            corners += [(x - h, y - h), (x + h, y - h), (x + h, y + h), (x - h, y + h)]
        hull = convex_hull(corners)
        area_ha = polygon_area(hull) / 1e4
        ring = [list(proj.to_lonlat(x, y)) for x, y in hull]
        ring = [[round(a, 5), round(b, 5)] for a, b in ring]
        if ring:
            ring.append(ring[0])
        age_h = (now - self.last_seen).total_seconds() / 3600
        recent = [d for d in dets if (now - d.acq_time).total_seconds() <= 6 * 3600]
        growth = len(recent) / len(dets)
        score = (
            40 * min(1.0, math.log10(1 + frp_sum) / 3)
            + 25 * math.exp(-max(age_h, 0) / 6)
            + 20 * min(1.0, len(dets) / 30)
            + 15 * growth
        )
        return {
            "id": self.id,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "count": len(dets),
            "sources": sorted({d.source for d in dets}),
            "first_seen": self.first_seen.isoformat(),
            "last_seen": self.last_seen.isoformat(),
            "age_h": round(age_h, 2),
            "frp_sum": round(frp_sum, 1),
            "frp_max": round(max(frps), 1) if frps else None,
            "area_ha": round(area_ha, 1),
            "high_confidence": sum(1 for d in dets if d.confidence == "h"),
            "recent_6h": len(recent),
            "priority": round(score),
            "status": "active" if age_h <= 12 else "cooling",
            "hull": {"type": "Polygon", "coordinates": [ring]} if len(ring) >= 4 else None,
        }


def cluster(hotspots: list[Hotspot], eps_km: float = 2.5) -> list[Incident]:
    """Single-linkage clustering (DBSCAN with min_samples=1) on a spatial hash grid."""
    if not hotspots:
        return []
    cell = eps_km / 111.0
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, h in enumerate(hotspots):
        grid[(int(math.floor(h.lat / cell)), int(math.floor(h.lon / cell)))].append(i)

    parent = list(range(len(hotspots)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for (gy, gx), members in grid.items():
        lat_c = (gy + 0.5) * cell
        # Longitude cells shrink with latitude: widen the search accordingly.
        span = int(math.ceil(1 / max(math.cos(math.radians(min(abs(lat_c), 89))), 1e-3)))
        for dy in (-1, 0, 1):
            for dx in range(-span, span + 1):
                other = grid.get((gy + dy, gx + dx))
                if not other:
                    continue
                for i in members:
                    hi = hotspots[i]
                    for j in other:
                        if j <= i:
                            continue
                        hj = hotspots[j]
                        if haversine_km(hi.lat, hi.lon, hj.lat, hj.lon) <= eps_km:
                            ri, rj = find(i), find(j)
                            if ri != rj:
                                parent[rj] = ri

    groups: dict[int, list[Hotspot]] = defaultdict(list)
    for i, h in enumerate(hotspots):
        groups[find(i)].append(h)
    incidents = []
    for dets in groups.values():
        first = min(dets, key=lambda d: (d.acq_time, d.id))
        iid = hashlib.sha1(first.id.encode()).hexdigest()[:12]
        incidents.append(Incident(iid, dets))
    return incidents
