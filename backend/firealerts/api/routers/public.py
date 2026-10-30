"""Public, read-only fire map (no account needed). Disable with PUBLIC_MAP=false."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...config import settings
from ...db import get_session, utcnow
from ...geo import bbox_contains
from ...models import Detection, IngestRun
from ...services import incidents as incident_svc
from ..deps import client, client_ip, parse_bbox
from . import firedata

_hits: dict[str, deque] = defaultdict(deque)
LIMIT_PER_MIN = 120


def guard(request: Request) -> None:
    if not settings.public_map:
        raise HTTPException(404, "the public map is disabled on this server")
    now = time.time()
    if len(_hits) > 10000:  # forget idle callers so the table stays bounded
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > 60]:
            del _hits[k]
    q = _hits[client_ip(request)]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= LIMIT_PER_MIN:
        raise HTTPException(429, "too many requests; slow down")
    q.append(now)


router = APIRouter(prefix="/api/public", tags=["public"], dependencies=[Depends(guard)])


def _bbox_required(bbox: str | None):
    box = parse_bbox(bbox)
    if not box:
        raise HTTPException(400, "bbox is required")
    firedata._area_ok(box)
    return box


@router.get("/status")
def public_status(session: Session = Depends(get_session)):
    since = utcnow() - timedelta(hours=24)
    by_source = dict(session.execute(select(Detection.source, func.count()).where(Detection.acq_time >= since).group_by(Detection.source)).all())
    latest = session.scalar(select(func.max(Detection.acq_time)))
    last = session.scalar(select(IngestRun).order_by(IngestRun.id.desc()))
    return {
        "detections_24h": sum(by_source.values()),
        "by_source_24h": by_source,
        "latest_detection": latest.isoformat() if latest else None,
        "last_sync": last.finished_at.isoformat() if last and last.finished_at else None,
        "active_mode": last.mode if last else None,
    }


@router.get("/detections")
def public_detections(bbox: str, hours: float = Query(24, gt=0, le=48), session: Session = Depends(get_session)):
    rows = incident_svc.query_detections(session, hours, _bbox_required(bbox), limit=50_000)
    return {"type": "FeatureCollection", "features": [incident_svc.feature(session, r) for r in rows]}


@router.get("/incidents")
def public_incidents(bbox: str, min_count: int = Query(1, ge=1), limit: int = Query(300, ge=1, le=1000), session: Session = Depends(get_session)):
    box = _bbox_required(bbox)
    _, summaries = incident_svc.incidents(session, 24)
    items = [s for s in summaries.values() if s["count"] >= min_count and bbox_contains(box, s["lon"], s["lat"])]
    items.sort(key=lambda s: (-s["priority"], s["age_h"]))
    return {"count": len(items), "incidents": items[:limit]}


@router.get("/wind")
async def public_wind(bbox: str, n: int = Query(10, ge=2, le=16), http: httpx.AsyncClient = Depends(client)):
    return await firedata.wind(http, bbox, n)
