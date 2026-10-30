"""Detection queries and the (cached) incident clustering shared by API and worker."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..geo import bbox_contains
from ..models import Detection, IngestRun
from ..db import utcnow
from ..science.cluster import Hotspot, Incident, cluster
from . import static_sources

_cache: dict = {}


def query_detections(session: Session, hours: float, bbox=None, sources: list[str] | None = None, limit: int = 200_000, start=None, end=None) -> list[Detection]:
    if start is not None:
        q = select(Detection).where(Detection.acq_time >= start, Detection.acq_time <= (end or utcnow()))
    else:
        q = select(Detection).where(Detection.acq_time >= utcnow() - timedelta(hours=hours))
    if bbox and bbox[0] <= bbox[2]:
        q = q.where(Detection.lon.between(bbox[0], bbox[2]), Detection.lat.between(bbox[1], bbox[3]))
    elif bbox:
        q = q.where(Detection.lat.between(bbox[1], bbox[3]))
    if sources:
        q = q.where(Detection.source.in_(sources))
    rows = session.scalars(q.order_by(Detection.acq_time.desc()).limit(limit)).all()
    if bbox and bbox[0] > bbox[2]:
        rows = [r for r in rows if bbox_contains(bbox, r.lon, r.lat)]
    return rows


def incidents(session: Session, hours: float = 24) -> tuple[dict[str, Incident], dict[str, dict]]:
    last = session.scalar(select(func.max(IngestRun.id))) or 0
    key = (hours, last)
    if key not in _cache:
        dets = query_detections(session, hours)
        hs = [Hotspot(d.id, d.lat, d.lon, d.acq_time, d.source, d.frp, d.confidence, d.pixel_m) for d in dets]
        incs = cluster(hs)
        now = utcnow()
        summaries = {}
        for i in incs:
            sm = i.summary(now)
            sm["static_source"] = static_sources.classify_incident(session, sm, i.detections)
            if sm["static_source"]:
                sm["priority"] = round(sm["priority"] * 0.2)
            summaries[i.id] = sm
        if len(_cache) > 8:
            _cache.clear()
        _cache[key] = ({i.id: i for i in incs}, summaries)
    return _cache[key]


def invalidate() -> None:
    _cache.clear()


def feature(session: Session, d: Detection) -> dict:
    """Detection GeoJSON feature tagged with any static heat source it falls on."""
    f = d.as_feature()
    hit = static_sources.classify(session, d.lat, d.lon)
    f["properties"]["static_source"] = hit["type"] if hit else None
    return f
