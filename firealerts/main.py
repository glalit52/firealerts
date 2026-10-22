"""HTTP API and web app."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import __version__, ingest
from .config import settings
from .db import Alert, AreaOfInterest, Detection, IngestRun, SessionLocal, init_db, utcnow
from .geo import bbox_contains, circle_ring
from .science import spread
from .science.cluster import Hotspot, cluster
from .sources import weather

log = logging.getLogger("firealerts")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def get_session():
    with SessionLocal() as s:
        yield s


class State:
    client: httpx.AsyncClient | None = None
    task: asyncio.Task | None = None
    lock = asyncio.Lock()
    incident_cache: dict = {}


state = State()


async def run_ingest() -> IngestRun:
    async with state.lock:
        with SessionLocal() as s:
            rec = await ingest.run(s, state.client, settings)
        state.incident_cache.clear()
        return rec


async def _scheduler():
    while True:
        try:
            await run_ingest()
        except Exception:
            log.exception("scheduled ingest failed")
        await asyncio.sleep(settings.poll_minutes * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    state.client = httpx.AsyncClient(timeout=settings.http_timeout, follow_redirects=True, headers={"User-Agent": f"firealerts/{__version__}"})
    if settings.scheduler_enabled:
        state.task = asyncio.create_task(_scheduler())
    yield
    if state.task:
        state.task.cancel()
    await state.client.aclose()


app = FastAPI(title="Firealerts", version=__version__, lifespan=lifespan)


def _weather_mode() -> str:
    return settings.data_mode if settings.data_mode in ("live", "demo") else "auto"


def _parse_bbox(bbox: str | None) -> tuple[float, float, float, float] | None:
    if not bbox:
        return None
    try:
        w, s, e, n = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be 'west,south,east,north'")
    return w, s, e, n


def _query_detections(session: Session, hours: float, bbox=None, sources: list[str] | None = None) -> list[Detection]:
    q = select(Detection).where(Detection.acq_time >= utcnow() - timedelta(hours=hours))
    if bbox and bbox[0] <= bbox[2]:
        q = q.where(Detection.lon.between(bbox[0], bbox[2]), Detection.lat.between(bbox[1], bbox[3]))
    elif bbox:
        q = q.where(Detection.lat.between(bbox[1], bbox[3]))
    if sources:
        q = q.where(Detection.source.in_(sources))
    rows = session.scalars(q.order_by(Detection.acq_time.desc()).limit(200_000)).all()
    if bbox and bbox[0] > bbox[2]:
        rows = [r for r in rows if bbox_contains(bbox, r.lon, r.lat)]
    return rows


def _incidents(session: Session, hours: float):
    last = session.scalar(select(func.max(IngestRun.id))) or 0
    key = (hours, last)
    if key not in state.incident_cache:
        dets = _query_detections(session, hours)
        hs = [Hotspot(d.id, d.lat, d.lon, d.acq_time, d.source, d.frp, d.confidence, d.pixel_m) for d in dets]
        incs = cluster(hs)
        now = utcnow()
        state.incident_cache.clear()
        state.incident_cache[key] = ({i.id: i for i in incs}, {i.id: i.summary(now) for i in incs})
    return state.incident_cache[key]


# ----------------------------------------------------------------------------- status


@app.get("/api/status")
def status(session: Session = Depends(get_session)):
    last = session.scalars(select(IngestRun).order_by(IngestRun.id.desc()).limit(5)).all()
    since = utcnow() - timedelta(hours=24)
    by_source = dict(session.execute(select(Detection.source, func.count()).where(Detection.acq_time >= since).group_by(Detection.source)).all())
    latest = session.scalar(select(func.max(Detection.acq_time)))
    return {
        "version": __version__,
        "data_mode": settings.data_mode,
        "active_mode": last[0].mode if last else None,
        "poll_minutes": settings.poll_minutes,
        "detections_24h": sum(by_source.values()),
        "by_source_24h": by_source,
        "latest_detection": latest.isoformat() if latest else None,
        "runs": [r.as_dict() for r in last],
        "region_bbox": settings.bbox,
    }


@app.post("/api/ingest")
async def trigger_ingest():
    rec = await run_ingest()
    return rec.as_dict()


# ----------------------------------------------------------------------------- detections & incidents


@app.get("/api/detections")
def detections(
    bbox: str | None = None,
    hours: float = Query(24, gt=0, le=168),
    sources: str | None = None,
    session: Session = Depends(get_session),
):
    rows = _query_detections(session, hours, _parse_bbox(bbox), sources.split(",") if sources else None)
    return {"type": "FeatureCollection", "features": [r.as_feature() for r in rows]}


@app.get("/api/incidents")
def incidents(
    bbox: str | None = None,
    hours: float = Query(24, gt=0, le=168),
    min_count: int = Query(1, ge=1),
    limit: int = Query(500, ge=1, le=5000),
    session: Session = Depends(get_session),
):
    _, summaries = _incidents(session, hours)
    box = _parse_bbox(bbox)
    items = [s for s in summaries.values() if s["count"] >= min_count and (not box or bbox_contains(box, s["lon"], s["lat"]))]
    items.sort(key=lambda s: (-s["priority"], s["age_h"]))
    return {"count": len(items), "incidents": items[:limit]}


@app.get("/api/incidents/{incident_id}")
def incident(incident_id: str, hours: float = Query(24, gt=0, le=168), session: Session = Depends(get_session)):
    incs, summaries = _incidents(session, hours)
    if incident_id not in incs:
        raise HTTPException(404, "incident not found (it may have merged with another after a new pass)")
    inc = incs[incident_id]
    dets = sorted(inc.detections, key=lambda d: d.acq_time)
    timeline: dict[str, int] = {}
    for d in dets:
        k = d.acq_time.strftime("%Y-%m-%dT%H:00Z")
        timeline[k] = timeline.get(k, 0) + 1
    return {
        **summaries[incident_id],
        "timeline": [{"hour": k, "count": v} for k, v in timeline.items()],
        "detections": [
            {"id": d.id, "lat": d.lat, "lon": d.lon, "acq_time": d.acq_time.isoformat(), "source": d.source, "frp": d.frp, "confidence": d.confidence}
            for d in dets
        ],
    }


def _fuel(code: str, lat: float) -> str:
    code = spread.auto_fuel(lat) if code == "auto" else code
    if code not in spread.FUELS:
        raise HTTPException(400, f"unknown fuel type {code}; options: {', '.join(spread.FUELS)}")
    return code


async def _spread(points, lat, lon, fuel, curing, hours, members):
    try:
        fw = await weather.fire_weather(state.client, lat, lon, _weather_mode())
    except Exception as exc:
        raise HTTPException(502, f"weather unavailable: {exc}")
    horizons = [h for h in (1, 3, 6, 12, 24, 48, 72) if h <= hours]
    inp = spread.SpreadInputs(
        seed_points=points,
        weather=fw["hourly"],
        fwi_state=fw["state"],
        fuel_code=_fuel(fuel, lat),
        curing_pct=curing,
        horizons=horizons,
        members=members,
    )
    try:
        result = await asyncio.to_thread(spread.forecast, inp)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    result["weather_source"] = fw["source"]
    result["danger"] = fw["days"]
    result["current"] = fw["current"]
    return result


@app.get("/api/incidents/{incident_id}/forecast")
async def incident_forecast(
    incident_id: str,
    fuel: str = "auto",
    curing: float = Query(85, ge=0, le=100),
    hours: int = Query(24, ge=1, le=72),
    members: int = Query(32, ge=1, le=100),
    session: Session = Depends(get_session),
):
    incs, summaries = _incidents(session, 24)
    if incident_id not in incs:
        raise HTTPException(404, "incident not found")
    inc = incs[incident_id]
    front = inc.active_front()
    points = [(d.lon, d.lat, d.pixel_m) for d in front]
    s = summaries[incident_id]
    result = await _spread(points, s["lat"], s["lon"], fuel, curing, hours, members)
    result["incident"] = s
    return result


@app.get("/api/forecast/spread")
async def point_forecast(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    fuel: str = "auto",
    curing: float = Query(85, ge=0, le=100),
    hours: int = Query(24, ge=1, le=72),
    members: int = Query(32, ge=1, le=100),
):
    """What-if: spread forecast for a hypothetical ignition at a point."""
    return await _spread([(lon, lat, 100.0)], lat, lon, fuel, curing, hours, members)


# ----------------------------------------------------------------------------- fire danger


@app.get("/api/danger")
async def danger(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    try:
        fw = await weather.fire_weather(state.client, lat, lon, _weather_mode())
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


@app.get("/api/danger/grid")
async def danger_grid(bbox: str, n: int = Query(8, ge=2, le=12)):
    box = _parse_bbox(bbox)
    w, s, e, nn = box
    if e - w > 60 or nn - s > 40:
        raise HTTPException(400, "area too large; zoom in (max 60° x 40°)")
    try:
        return await weather.danger_grid(state.client, box, n, _weather_mode())
    except Exception as exc:
        raise HTTPException(502, f"weather unavailable: {exc}")


@app.get("/api/fuels")
def fuels():
    return [{"code": f.code, "name": f.name} for f in spread.FUELS.values()]


# ----------------------------------------------------------------------------- areas of interest & alerts


class AOIIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    geometry: dict | None = None
    center: tuple[float, float] | None = None  # (lat, lon) for a circular area
    radius_km: float | None = Field(default=None, gt=0, le=500)
    buffer_km: float = Field(default=0, ge=0, le=200)
    min_confidence: str = "n"
    email: str = ""
    webhook_url: str = ""
    telegram_chat_id: str = ""

    @field_validator("min_confidence")
    @classmethod
    def _conf(cls, v):
        if v not in ("l", "n", "h"):
            raise ValueError("min_confidence must be l, n or h")
        return v

    def polygon(self) -> dict:
        if self.geometry:
            if self.geometry.get("type") != "Polygon" or not self.geometry.get("coordinates"):
                raise HTTPException(400, "geometry must be a GeoJSON Polygon")
            ring = self.geometry["coordinates"][0]
            if len(ring) < 4:
                raise HTTPException(400, "polygon needs at least 3 vertices")
            return {"type": "Polygon", "coordinates": [ring]}
        if self.center and self.radius_km:
            return {"type": "Polygon", "coordinates": [circle_ring(self.center[0], self.center[1], self.radius_km)]}
        raise HTTPException(400, "provide a GeoJSON polygon or center + radius_km")


@app.get("/api/aois")
def list_aois(session: Session = Depends(get_session)):
    return [a.as_dict() for a in session.scalars(select(AreaOfInterest).order_by(AreaOfInterest.id))]


@app.post("/api/aois", status_code=201)
def create_aoi(body: AOIIn, session: Session = Depends(get_session)):
    aoi = AreaOfInterest(
        name=body.name,
        geometry=body.polygon(),
        buffer_km=body.buffer_km,
        min_confidence=body.min_confidence,
        email=body.email,
        webhook_url=body.webhook_url,
        telegram_chat_id=body.telegram_chat_id,
    )
    session.add(aoi)
    session.commit()
    return aoi.as_dict()


@app.delete("/api/aois/{aoi_id}", status_code=204)
def delete_aoi(aoi_id: int, session: Session = Depends(get_session)):
    aoi = session.get(AreaOfInterest, aoi_id)
    if not aoi:
        raise HTTPException(404, "not found")
    session.delete(aoi)
    session.commit()


@app.get("/api/aois/{aoi_id}/detections")
def aoi_detections(aoi_id: int, hours: float = Query(24, gt=0, le=168), session: Session = Depends(get_session)):
    from .alerts import match

    aoi = session.get(AreaOfInterest, aoi_id)
    if not aoi:
        raise HTTPException(404, "not found")
    hits = match(aoi, _query_detections(session, hours))
    return {"count": len(hits), "features": [dict(d.as_feature(), properties={**d.as_feature()["properties"], "distance_km": round(km, 2)}) for d, km in hits]}


@app.get("/api/alerts")
def list_alerts(limit: int = Query(100, ge=1, le=1000), session: Session = Depends(get_session)):
    return [a.as_dict() for a in session.scalars(select(Alert).order_by(Alert.id.desc()).limit(limit))]


# ----------------------------------------------------------------------------- web app

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(WEB_DIR / "index.html")
