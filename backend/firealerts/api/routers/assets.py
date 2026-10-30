from __future__ import annotations

import html
from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import geo, plans
from ...auth import Principal, require
from ...db import get_session, utcnow
from ...integrations import sentinel2
from ...models import ASSET_KINDS, Alert, Asset, Organization
from ...science import fwi as F
from ...services import assets as asset_svc
from ...services import audit, intel
from ...services import incidents as incident_svc
from ..deps import client

router = APIRouter(prefix="/api/assets", tags=["assets"])
DANGERS = [name for _, name in F.DANGER_CLASSES]


class AssetIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    kind: str = "forest"
    description: str = Field(default="", max_length=5000)
    tags: list[str] = Field(default_factory=list)
    geometry: dict | None = None
    center: tuple[float, float] | None = None  # (lat, lon) for a circular area
    radius_km: float | None = Field(default=None, gt=0, le=200)
    buffer_km: float = Field(default=2.0, ge=0, le=100)
    min_confidence: str = "n"
    threat_radius_km: float = Field(default=30.0, ge=0, le=200)
    risk_alerts: bool = True
    risk_min_danger: str = "high"
    properties: dict = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _kind(cls, v):
        if v not in ASSET_KINDS:
            raise ValueError(f"kind must be one of {', '.join(ASSET_KINDS)}")
        return v

    @field_validator("min_confidence")
    @classmethod
    def _conf(cls, v):
        if v not in ("l", "n", "h"):
            raise ValueError("min_confidence must be l, n or h")
        return v

    @field_validator("risk_min_danger")
    @classmethod
    def _danger(cls, v):
        if v not in DANGERS:
            raise ValueError(f"risk_min_danger must be one of {', '.join(DANGERS)}")
        return v

    def resolved_geometry(self) -> dict:
        if self.geometry:
            return self.geometry
        if self.center and self.radius_km:
            return {"type": "Polygon", "coordinates": [geo.circle_ring(self.center[0], self.center[1], self.radius_km)]}
        raise HTTPException(422, "provide a GeoJSON polygon or center + radius_km")


class AssetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    kind: str | None = None
    description: str | None = Field(default=None, max_length=5000)
    tags: list[str] | None = None
    geometry: dict | None = None
    buffer_km: float | None = Field(default=None, ge=0, le=100)
    min_confidence: str | None = None
    threat_radius_km: float | None = Field(default=None, ge=0, le=200)
    risk_alerts: bool | None = None
    risk_min_danger: str | None = None
    active: bool | None = None


def own(session: Session, asset_id: int, p: Principal) -> Asset:
    a = session.get(Asset, asset_id)
    if not a or a.org_id != p.org_id:
        raise HTTPException(404, "asset not found")
    return a


def _check_size(session: Session, p: Principal, area_ha: float) -> None:
    limit = plans.limits(session.get(Organization, p.org_id)).get("max_asset_ha")
    if limit is not None and area_ha > limit:
        raise HTTPException(402, f"assets on your plan can be up to {limit:,} ha (this one is {area_ha:,.0f} ha)")


def _create(session: Session, p: Principal, body: AssetIn, geometry: dict) -> Asset:
    a = Asset(
        org_id=p.org_id,
        name=body.name.strip(),
        kind=body.kind,
        description=body.description,
        tags=[t.strip() for t in body.tags if t.strip()][:20],
        buffer_km=body.buffer_km,
        min_confidence=body.min_confidence,
        threat_radius_km=body.threat_radius_km,
        risk_alerts=body.risk_alerts,
        risk_min_danger=body.risk_min_danger,
        properties=body.properties,
        created_by=p.user_id,
    )
    try:
        asset_svc.apply_geometry(a, geometry)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    _check_size(session, p, a.area_ha)
    session.add(a)
    return a


# ----------------------------------------------------------------------------- CRUD


@router.get("")
def list_assets(geometry: bool = False, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    rows = session.scalars(select(Asset).where(Asset.org_id == p.org_id).order_by(Asset.name)).all()
    open_counts = dict(session.execute(select(Alert.asset_id, func.count()).where(Alert.org_id == p.org_id, Alert.status != "resolved").group_by(Alert.asset_id)).all())
    out = []
    for a in rows:
        risk = intel.latest_risk(session, a)
        today = next((r for r in risk if r["date"] == utcnow().date().isoformat()), risk[0] if risk else None)
        out.append(a.as_dict(geometry=geometry) | {"open_alerts": open_counts.get(a.id, 0), "risk_today": today})
    return out


@router.post("", status_code=201)
def create_asset(body: AssetIn, p: Principal = Depends(require("member")), session: Session = Depends(get_session)):
    plans.check(session, session.get(Organization, p.org_id), "assets")
    a = _create(session, p, body, body.resolved_geometry())
    session.flush()
    audit.record(session, p, "asset.create", a.name, id=a.id)
    session.commit()
    return a.as_dict()


@router.post("/import", status_code=201)
async def import_assets(
    file: UploadFile = File(...),
    kind: str = "forest",
    buffer_km: float = Query(2.0, ge=0, le=100),
    p: Principal = Depends(require("member")),
    session: Session = Depends(get_session),
):
    """Create assets from GeoJSON, KML/KMZ or a zipped Shapefile (one asset per polygon feature)."""
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "file too large (max 20 MB)")
    try:
        feats = asset_svc.parse_upload(file.filename or "upload", raw)
    except Exception as exc:
        raise HTTPException(422, f"could not read the file: {exc}")
    org = session.get(Organization, p.org_id)
    plans.check(session, org, "assets", adding=len(feats))
    created, errors = [], []
    for i, f in enumerate(feats[:500]):
        props = f.get("properties") or {}
        body = AssetIn(name=asset_svc.feature_name(props, f"{(file.filename or 'Imported').rsplit('.', 1)[0]} {i + 1}"), kind=kind if kind in ASSET_KINDS else "forest", buffer_km=buffer_km, properties={k: v for k, v in props.items() if isinstance(v, (str, int, float, bool)) or v is None})
        try:
            created.append(_create(session, p, body, f["geometry"]))
        except HTTPException as exc:
            errors.append({"feature": i, "error": exc.detail})
    session.flush()
    audit.record(session, p, "asset.import", file.filename or "", count=len(created))
    session.commit()
    return {"created": [a.as_dict(geometry=False) for a in created], "errors": errors}


@router.get("/{asset_id}")
def get_asset(asset_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    return own(session, asset_id, p).as_dict()


@router.patch("/{asset_id}")
def update_asset(asset_id: int, body: AssetPatch, p: Principal = Depends(require("member")), session: Session = Depends(get_session)):
    a = own(session, asset_id, p)
    data = body.model_dump(exclude_unset=True)
    if "kind" in data and data["kind"] not in ASSET_KINDS:
        raise HTTPException(422, "invalid kind")
    if "min_confidence" in data and data["min_confidence"] not in ("l", "n", "h"):
        raise HTTPException(422, "invalid min_confidence")
    if "risk_min_danger" in data and data["risk_min_danger"] not in DANGERS:
        raise HTTPException(422, "invalid risk_min_danger")
    if "geometry" in data and data["geometry"]:
        try:
            asset_svc.apply_geometry(a, data.pop("geometry"))
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        _check_size(session, p, a.area_ha)
    for k, v in data.items():
        if v is not None:
            setattr(a, k, v)
    audit.record(session, p, "asset.update", a.name, id=a.id)
    session.commit()
    return a.as_dict()


@router.delete("/{asset_id}", status_code=204)
def delete_asset(asset_id: int, p: Principal = Depends(require("member")), session: Session = Depends(get_session)):
    a = own(session, asset_id, p)
    audit.record(session, p, "asset.delete", a.name, id=a.id)
    session.delete(a)
    session.commit()


# ----------------------------------------------------------------------------- intelligence


@router.get("/{asset_id}/summary")
def summary(asset_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    a = own(session, asset_id, p)
    near = asset_svc.detections_near(session, a, days=7)
    inside_24h = [d for d, km in near if km == 0 and d.acq_time >= utcnow() - timedelta(hours=24)]
    buffer_24h = [d for d, km in near if 0 < km <= a.buffer_km and d.acq_time >= utcnow() - timedelta(hours=24)]
    _, summaries = incident_svc.incidents(session, 24)
    nearby = []
    for s in summaries.values():
        km = geo.distance_to_geometry_km(s["lon"], s["lat"], a.geometry)
        if km <= max(a.threat_radius_km, 50):
            nearby.append({**{k: s[k] for k in ("id", "lat", "lon", "count", "frp_sum", "area_ha", "status", "last_seen", "priority")}, "distance_km": round(km, 2), "bearing_deg": round(asset_svc.bearing_deg(a.centroid_lat, a.centroid_lon, s["lat"], s["lon"]))})
    nearby.sort(key=lambda x: x["distance_km"])
    alerts = session.scalars(select(Alert).where(Alert.asset_id == a.id, Alert.status != "resolved").order_by(Alert.created_at.desc()).limit(10)).all()
    veg = intel.vegetation(session, a, days=120)
    return {
        "asset": a.as_dict(geometry=False),
        "fires": {
            "inside_24h": len(inside_24h),
            "buffer_24h": len(buffer_24h),
            "within_25km_7d": len(near),
            "nearest": {"km": round(near[0][1], 2), "acq_time": near[0][0].acq_time.isoformat(), "source": near[0][0].source, "lat": near[0][0].lat, "lon": near[0][0].lon} if near else None,
        },
        "incidents_nearby": nearby[:10],
        "risk": intel.latest_risk(session, a),
        "vegetation": {"latest": veg["latest"], "trend": veg["trend"]},
        "open_alerts": [x.as_dict() for x in alerts],
    }


@router.get("/{asset_id}/detections")
def asset_detections(asset_id: int, days: float = Query(7, gt=0, le=365), radius_km: float | None = Query(None, ge=0, le=200), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    a = own(session, asset_id, p)
    hits = asset_svc.detections_near(session, a, days=days, radius_km=radius_km)
    return {"type": "FeatureCollection", "features": [d.as_feature() | {"properties": d.as_feature()["properties"] | {"distance_km": round(km, 2)}} for d, km in hits[:5000]]}


@router.get("/{asset_id}/risk")
async def asset_risk(asset_id: int, refresh: bool = False, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    a = own(session, asset_id, p)
    if refresh or intel.risk_is_stale(session, a):
        try:
            await intel.compute_risk(session, http, a, alert=False)
        except Exception as exc:
            raise HTTPException(502, f"risk computation failed: {exc}")
    return {"days": intel.latest_risk(session, a)}


@router.get("/{asset_id}/vegetation")
def asset_vegetation(asset_id: int, days: int = Query(365, ge=7, le=3650), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    return intel.vegetation(session, own(session, asset_id, p), days)


@router.post("/{asset_id}/vegetation/refresh")
async def refresh_vegetation(asset_id: int, days: int = Query(120, ge=7, le=730), p: Principal = Depends(require("member")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    a = own(session, asset_id, p)
    try:
        res = await intel.refresh_vegetation(session, http, a, days=days)
    except Exception as exc:
        raise HTTPException(502, f"Sentinel-2 unavailable: {exc}")
    return res | intel.vegetation(session, a, days)


@router.get("/{asset_id}/scenes")
async def scenes(asset_id: int, days: int = Query(90, ge=7, le=730), max_cloud: float = Query(60, ge=0, le=100), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    a = own(session, asset_id, p)
    end = utcnow().date()
    try:
        found = await sentinel2.search(http, a.geometry, end - timedelta(days=days), end, max_cloud=max_cloud, limit=40)
    except Exception as exc:
        raise HTTPException(502, f"Sentinel-2 search failed: {exc}")
    return [s.as_dict() for s in found]


async def _scene(http, a: Asset, scene_id: str | None, near_date: str | None, before: bool | None = None, days: int = 365):
    end = utcnow().date()
    found = await sentinel2.search(http, a.geometry, end - timedelta(days=days), end, max_cloud=60, limit=60)
    if scene_id:
        s = next((x for x in found if x.id == scene_id), None)
        if not s:
            raise HTTPException(404, f"scene {scene_id} not found for this asset in the last {days} days")
        return s
    if near_date:
        s = sentinel2.nearest(found, intel.parse_day(near_date), before)
    else:
        s = sentinel2.best_recent(found)
    if not s:
        raise HTTPException(404, "no suitable Sentinel-2 scene found")
    return s


@router.get("/{asset_id}/imagery")
async def imagery(asset_id: int, index: str = Query("ndvi", pattern="^(ndvi|nbr|ndmi)$"), scene_id: str | None = None, date: str | None = None, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    a = own(session, asset_id, p)
    try:
        sc = await _scene(http, a, scene_id, date)
        return await sentinel2.render(http, a.geometry, sc, index)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"imagery failed: {exc}")


class BurnSeverityIn(BaseModel):
    pre_date: str | None = None
    post_date: str | None = None
    pre_scene_id: str | None = None
    post_scene_id: str | None = None


@router.post("/{asset_id}/burn-severity")
async def burn_severity(asset_id: int, body: BurnSeverityIn, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    """dNBR burn severity between a pre-fire and a post-fire Sentinel-2 scene."""
    a = own(session, asset_id, p)
    try:
        post = await _scene(http, a, body.post_scene_id, body.post_date, before=False if body.post_date else None)
        pre_default = (post.date - timedelta(days=30)).isoformat()
        pre = await _scene(http, a, body.pre_scene_id, body.pre_date or pre_default, before=True)
        if pre.date >= post.date:
            raise HTTPException(422, "the pre-fire scene must be older than the post-fire scene")
        res = await sentinel2.burn_severity(http, a.geometry, pre, post, a.area_ha)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"burn severity failed: {exc}")
    intel.store(session, a, "burn_severity", f"{pre.id}|{post.id}", "Sentinel-2 L2A", {k: v for k, v in res.items() if k != "image"})
    return res


@router.get("/{asset_id}/history")
async def history(asset_id: int, years: int = Query(5, ge=1, le=20), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    return await intel.burn_history(session, http, own(session, asset_id, p), years)


@router.get("/{asset_id}/forest-loss")
async def forest_loss(asset_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    return await intel.forest_loss(session, http, own(session, asset_id, p))


@router.get("/{asset_id}/exposure")
async def exposure(asset_id: int, radius_km: float = Query(10, gt=0, le=50), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    return await intel.exposure(session, http, own(session, asset_id, p), radius_km)


@router.get("/{asset_id}/report", response_class=HTMLResponse)
def report(asset_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    """Printable situation report (save as PDF from the browser)."""
    a = own(session, asset_id, p)
    s = summary(asset_id, p, session)
    esc = html.escape
    def pct(v):
        return "" if v is None else f"{v * 100:.1f}%"

    risk_rows = "".join(
        "<tr><td>{}{}</td><td>{:.0f}</td><td>{}</td><td>{}</td></tr>".format(esc(r["date"]), " (forecast)" if r["forecast"] else "", r["fwi"], esc(r["danger"].replace("_", " ")), pct(r["ignition_p"]))
        for r in s["risk"]
    )
    inc_rows = "".join(f"<tr><td>{i['distance_km']:.1f} km</td><td>{i['bearing_deg']}°</td><td>{i['count']}</td><td>{i['frp_sum']:.0f}</td><td>{esc(i['status'])}</td></tr>" for i in s["incidents_nearby"])
    alert_rows = "".join(f"<tr><td>{esc(x['created_at'][:16].replace('T', ' '))}</td><td>{esc(x['severity'])}</td><td>{esc(x['title'])}</td><td>{esc(x['status'])}</td></tr>" for x in s["open_alerts"])
    veg = s["vegetation"]["latest"]
    ndvi_kpi = "–" if not veg else "{:.2f}".format(veg["ndvi"])
    ndvi_date = "" if not veg else " ({})".format(esc(veg["date"]))
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>{esc(a.name)} · Firealerts report</title>
<style>@media print{{button{{display:none}}}}body{{font:14px/1.5 Inter,Arial,sans-serif;color:#1b1f27;max-width:860px;margin:32px auto;padding:0 16px}}h1{{margin:0}}table{{width:100%;border-collapse:collapse;margin:8px 0 20px}}td,th{{border-bottom:1px solid #ddd;padding:6px;text-align:left}}.muted{{color:#667}}.kpi{{display:inline-block;margin-right:28px}}.kpi b{{font-size:22px;display:block}}</style></head><body>
<h1>{esc(a.name)}</h1><div class="muted">{esc(a.kind.replace('_', ' '))} · {a.area_ha:,.1f} ha · centroid {a.centroid_lat:.4f}, {a.centroid_lon:.4f} · generated {utcnow():%Y-%m-%d %H:%M} UTC</div>
<h2>Situation</h2><div class="kpi"><b>{s['fires']['inside_24h']}</b>detections inside (24 h)</div><div class="kpi"><b>{s['fires']['buffer_24h']}</b>in {a.buffer_km:g} km buffer (24 h)</div><div class="kpi"><b>{s['fires']['within_25km_7d']}</b>within 25 km (7 d)</div><div class="kpi"><b>{ndvi_kpi}</b>latest NDVI{ndvi_date}</div>
<h2>Fire danger</h2><table><tr><th>Date</th><th>FWI</th><th>Danger</th><th>Ignition probability</th></tr>{risk_rows or '<tr><td colspan=4 class=muted>Not computed yet</td></tr>'}</table>
<h2>Fires nearby</h2><table><tr><th>Distance</th><th>Bearing</th><th>Pixels</th><th>FRP MW</th><th>Status</th></tr>{inc_rows or '<tr><td colspan=5 class=muted>None</td></tr>'}</table>
<h2>Open alerts</h2><table><tr><th>Time (UTC)</th><th>Severity</th><th>Alert</th><th>Status</th></tr>{alert_rows or '<tr><td colspan=4 class=muted>None</td></tr>'}</table>
<p class="muted">Sources: NASA FIRMS, NOAA GOES, Copernicus Sentinel-2, Open-Meteo, ESA WorldCover. Forecasts are decision support, not operational fire-behaviour analyses.</p>
<p><button onclick="window.print()">Print / save as PDF</button></p></body></html>"""
    return HTMLResponse(doc)
