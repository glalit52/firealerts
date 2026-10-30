from __future__ import annotations

from datetime import datetime, timedelta, timezone

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


def parse_range(start: str | None, end: str | None):
    """Validate an archive date range (ISO datetimes, at most 31 days)."""
    if not start:
        return None, None
    try:
        a = datetime.fromisoformat(start.replace("Z", "+00:00"))
        b = datetime.fromisoformat(end.replace("Z", "+00:00")) if end else utcnow()
    except ValueError:
        raise HTTPException(400, "from/to must be ISO 8601 datetimes")
    a = a if a.tzinfo else a.replace(tzinfo=timezone.utc)
    b = b if b.tzinfo else b.replace(tzinfo=timezone.utc)
    if b <= a or (b - a) > timedelta(days=31):
        raise HTTPException(400, "the range must be positive and at most 31 days")
    return a, b


@router.get("/detections")
def detections(
    bbox: str | None = None,
    hours: float = Query(24, gt=0, le=168),
    sources: str | None = None,
    start: str | None = Query(None, alias="from", description="ISO start of an archive range (instead of hours)"),
    end: str | None = Query(None, alias="to"),
    session: Session = Depends(get_session),
):
    a, b = parse_range(start, end)
    rows = incident_svc.query_detections(session, hours, parse_bbox(bbox), sources.split(",") if sources else None, start=a, end=b)
    return {"type": "FeatureCollection", "features": [incident_svc.feature(session, r) for r in rows]}


@router.get("/stats/fires")
def fire_stats(bbox: str | None = None, days: int = Query(30, ge=1, le=365), session: Session = Depends(get_session)):
    """Daily detection counts and radiative power, by sensor, from the archive."""
    box = parse_bbox(bbox)
    q = select(func.date(Detection.acq_time), Detection.source, func.count(), func.coalesce(func.sum(Detection.frp), 0.0)).where(Detection.acq_time >= utcnow() - timedelta(days=days))
    if box and box[0] <= box[2]:
        q = q.where(Detection.lon.between(box[0], box[2]), Detection.lat.between(box[1], box[3]))
    elif box:
        q = q.where(Detection.lat.between(box[1], box[3]))
    daily: dict[str, list] = {}
    by_source: dict[str, int] = {}
    for d, src, n, frp in session.execute(q.group_by(func.date(Detection.acq_time), Detection.source)):
        k = str(d)
        acc = daily.setdefault(k, [0, 0.0])
        acc[0] += n
        acc[1] += float(frp or 0)
        by_source[src] = by_source.get(src, 0) + n
    rows = [{"date": k, "count": v[0], "frp": round(v[1], 1)} for k, v in sorted(daily.items())]
    return {"days": days, "total": sum(r["count"] for r in rows), "frp_total": round(sum(r["frp"] for r in rows), 1), "daily": rows, "by_source": by_source}


async def wind(http: httpx.AsyncClient, bbox: str, n: int) -> dict:
    box = parse_bbox(bbox)
    _area_ok(box)
    try:
        return await weather.wind_grid(http, box, n, alerting.weather_mode())
    except Exception as exc:
        raise HTTPException(502, f"weather unavailable: {exc}")


@router.get("/weather/wind")
async def weather_wind(bbox: str, n: int = Query(12, ge=2, le=20), http: httpx.AsyncClient = Depends(client)):
    """10 m wind vectors on a grid, every 3 h for 48 h (speed km/h, direction the wind comes from)."""
    return await wind(http, bbox, n)


@router.get("/static-sources")
def static_source_list(bbox: str | None = None, session: Session = Depends(get_session)):
    """Volcanoes and persistent heat sources excluded from alerts."""
    from ...models import StaticSource

    q = select(StaticSource).where(StaticSource.active.is_(True))
    box = parse_bbox(bbox)
    if box:
        q = q.where(StaticSource.lat.between(box[1], box[3]))
        if box[0] <= box[2]:
            q = q.where(StaticSource.lon.between(box[0], box[2]))
    return [s.as_dict() for s in session.scalars(q.limit(5000))]


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
