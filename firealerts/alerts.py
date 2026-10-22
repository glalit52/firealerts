"""Match new detections against areas of interest and raise alerts."""

from __future__ import annotations

import logging

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .db import Alert, AreaOfInterest, Detection
from .geo import distance_to_polygon_km
from .notifiers import deliver
from .sources import static_sources
from .sources.static_sources import StaticIndex

log = logging.getLogger(__name__)

_CONF_RANK = {"l": 0, "n": 1, "h": 2}


def _bbox(ring, pad_km: float):
    pad = pad_km / 111.0 + 0.01
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return min(lons) - pad * 3, min(lats) - pad, max(lons) + pad * 3, max(lats) + pad


def match(aoi: AreaOfInterest, detections: list[Detection], statics: StaticIndex | None = None) -> list[tuple[Detection, float]]:
    """Detections inside the area (plus buffer). Static heat sources are skipped unless the area opts in."""
    ring = aoi.geometry["coordinates"][0]
    w, s, e, n = _bbox(ring, aoi.buffer_km)
    min_rank = _CONF_RANK.get(aoi.min_confidence, 1)
    skip_static = statics is not None and len(statics) and not aoi.include_static
    hits = []
    for d in detections:
        if not (s <= d.lat <= n and w <= d.lon <= e):
            continue
        if _CONF_RANK.get(d.confidence, 1) < min_rank:
            continue
        dist = distance_to_polygon_km(d.lon, d.lat, ring)
        if dist <= aoi.buffer_km and not (skip_static and statics.match(d.lat, d.lon)):
            hits.append((d, dist))
    return hits


async def process(session: Session, client: httpx.AsyncClient, cfg: Settings, new: list[Detection]) -> int:
    if not new:
        return 0
    aois = session.scalars(select(AreaOfInterest).where(AreaOfInterest.active.is_(True))).all()
    statics = static_sources.index_for(session, cfg) if aois else None
    created = 0
    for aoi in aois:
        hits = match(aoi, new, statics)
        if not hits:
            continue
        nearest = min(hits, key=lambda h: h[1])
        frps = [d.frp for d, _ in hits if d.frp is not None]
        alert = Alert(
            org_id=aoi.org_id,
            aoi_id=aoi.id,
            aoi_name=aoi.name,
            detection_ids=[d.id for d, _ in hits],
            count=len(hits),
            max_frp=max(frps) if frps else None,
            nearest_km=round(nearest[1], 2),
            lat=nearest[0].lat,
            lon=nearest[0].lon,
        )
        payload = {
            "aoi_id": aoi.id,
            "aoi_name": aoi.name,
            "count": alert.count,
            "max_frp": alert.max_frp,
            "nearest_km": alert.nearest_km,
            "lat": alert.lat,
            "lon": alert.lon,
            "sources": sorted({d.source for d, _ in hits}),
            "first_acq_time": min(d.acq_time for d, _ in hits).isoformat(),
            "url": f"{cfg.public_url}/#{alert.lat:.4f},{alert.lon:.4f},12",
        }
        alert.delivered = await deliver(client, cfg, aoi, payload)
        session.add(alert)
        created += 1
    session.commit()
    return created
