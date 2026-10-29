from __future__ import annotations

from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import forecasting, plans
from ...auth import Principal, require
from ...config import settings
from ...db import get_session, utcnow
from ...geo import bbox_contains
from ...ml import model, risk
from ...models import Detection, Organization
from ...science import spread
from ...services import alerting
from ...services import incidents as incident_svc
from ...sources import weather
from ..deps import client, parse_bbox

router = APIRouter(prefix="/api", tags=["fire data"], dependencies=[Depends(require("viewer"))])


def _area_ok(box) -> None:
    w, s, e, n = box
    if e - w > 60 or n - s > 40:
        raise HTTPException(400, "area too large; zoom in (max 60° x 40°)")


@router.get("/detections")
def detections(bbox: str | None = None, hours: float = Query(24, gt=0, le=168), sources: str | None = None, session: Session = Depends(get_session)):
    rows = incident_svc.query_detections(session, hours, parse_bbox(bbox), sources.split(",") if sources else None)
    return {"type": "FeatureCollection", "features": [r.as_feature() for r in rows]}


@router.get("/incidents")
def incidents(
    bbox: str | None = None,
    hours: float = Query(24, gt=0, le=168),
    min_count: int = Query(1, ge=1),
    limit: int = Query(500, ge=1, le=5000),
    session: Session = Depends(get_session),
):
    _, summaries = incident_svc.incidents(session, hours)
    box = parse_bbox(bbox)
    items = [s for s in summaries.values() if s["count"] >= min_count and (not box or bbox_contains(box, s["lon"], s["lat"]))]
    items.sort(key=lambda s: (-s["priority"], s["age_h"]))
    return {"count": len(items), "incidents": items[:limit]}


@router.get("/incidents/{incident_id}")
def incident(incident_id: str, hours: float = Query(24, gt=0, le=168), session: Session = Depends(get_session)):
    incs, summaries = incident_svc.incidents(session, hours)
    if incident_id not in incs:
        raise HTTPException(404, "incident not found (it may have merged with another after a new pass)")
    dets = sorted(incs[incident_id].detections, key=lambda d: d.acq_time)
    timeline: dict[str, int] = {}
    for d in dets:
        k = d.acq_time.strftime("%Y-%m-%dT%H:00Z")
        timeline[k] = timeline.get(k, 0) + 1
    return {
        **summaries[incident_id],
        "timeline": [{"hour": k, "count": v} for k, v in timeline.items()],
        "detections": [{"id": d.id, "lat": d.lat, "lon": d.lon, "acq_time": d.acq_time.isoformat(), "source": d.source, "frp": d.frp, "confidence": d.confidence} for d in dets],
    }


def _members(session: Session, p: Principal, requested: int) -> int:
    cap = plans.limits(session.get(Organization, p.org_id)).get("forecast_members") or 64
    return min(requested, cap)


async def _spread(http, points, lat, lon, fuel, curing, hours, members, model_):
    try:
        return await forecasting.run_spread(http, points, lat, lon, fuel, curing, hours, members, model_, alerting.weather_mode(), settings.terrain_enabled)
    except forecasting.ForecastError as exc:
        raise HTTPException(exc.status, str(exc))


@router.get("/incidents/{incident_id}/forecast")
async def incident_forecast(
    incident_id: str,
    fuel: str = "auto",
    curing: float = Query(85, ge=0, le=100),
    hours: int = Query(24, ge=1, le=72),
    members: int = Query(16, ge=1, le=100),
    model: str = "auto",
    p: Principal = Depends(require("viewer")),
    session: Session = Depends(get_session),
    http: httpx.AsyncClient = Depends(client),
):
    incs, summaries = incident_svc.incidents(session, 24)
    if incident_id not in incs:
        raise HTTPException(404, "incident not found")
    front = incs[incident_id].active_front()
    s = summaries[incident_id]
    result = await _spread(http, [(d.lon, d.lat, d.pixel_m) for d in front], s["lat"], s["lon"], fuel, curing, hours, _members(session, p, members), model)
    result["incident"] = s
    return result


@router.get("/forecast/spread")
async def point_forecast(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    fuel: str = "auto",
    curing: float = Query(85, ge=0, le=100),
    hours: int = Query(24, ge=1, le=72),
    members: int = Query(16, ge=1, le=100),
    model: str = "auto",
    p: Principal = Depends(require("viewer")),
    session: Session = Depends(get_session),
    http: httpx.AsyncClient = Depends(client),
):
    """What-if: spread forecast for a hypothetical ignition at a point."""
    return await _spread(http, [(lon, lat, 100.0)], lat, lon, fuel, curing, hours, _members(session, p, members), model)


@router.get("/danger")
async def danger(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), http: httpx.AsyncClient = Depends(client)):
    try:
        fw = await weather.fire_weather(http, lat, lon, alerting.weather_mode())
    except Exception as exc:
        raise HTTPException(502, f"weather unavailable: {exc}")
    st = fw["state"]
    return {
        "lat": lat,
        "lon": lon,
        "source": fw["source"],
        "current": fw["current"],
        "state": {"ffmc": round(st.ffmc, 1), "dmc": round(st.dmc, 1), "dc": round(st.dc, 1)},
        "days": fw["days"],
        "hourly": [h.__dict__ for h in fw["hourly"][:72]],
    }


@router.get("/danger/grid")
async def danger_grid(bbox: str, n: int = Query(8, ge=2, le=12), http: httpx.AsyncClient = Depends(client)):
    box = parse_bbox(bbox)
    _area_ok(box)
    try:
        return await weather.danger_grid(http, box, n, alerting.weather_mode())
    except Exception as exc:
        raise HTTPException(502, f"weather unavailable: {exc}")


@router.get("/risk/ignition")
async def ignition_risk(bbox: str, n: int = Query(8, ge=2, le=12), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    """Probability of at least one satellite fire detection per cell, today and for the next 7 days."""
    box = parse_bbox(bbox)
    _area_ok(box)
    since = utcnow() - timedelta(days=7)

    def recent(w_, s_, e_, n_):
        return session.scalar(select(func.count()).select_from(Detection).where(Detection.acq_time >= since, Detection.lon.between(w_, e_), Detection.lat.between(s_, n_))) or 0

    try:
        return await risk.ignition_grid(http, box, n, alerting.weather_mode(), settings.model_path, recent)
    except Exception as exc:
        raise HTTPException(502, f"risk model unavailable: {exc}")


@router.get("/risk/model")
def risk_model():
    return model.load(settings.model_path).meta


@router.get("/fuels")
def fuels():
    return [{"code": f.code, "name": f.name} for f in spread.FUELS.values()]
