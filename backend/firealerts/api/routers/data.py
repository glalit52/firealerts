"""Exports: detections, alerts and assets as CSV, GeoJSON or KML."""

from __future__ import annotations

import csv
import io
import json
from datetime import timedelta
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...auth import Principal, require
from ...db import get_session, utcnow
from ...geo import polygons
from ...models import Alert, Asset, AssetObservation, AssetRisk, Detection
from ...services import incidents as incident_svc
from ..deps import parse_bbox

router = APIRouter(prefix="/api", tags=["data"])
FORMATS = "^(csv|geojson|kml)$"


def _download(body: str | bytes, filename: str, media: str) -> Response:
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _csv(rows: list[dict], fields: list[str]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def _kml_doc(name: str, placemarks: list[str]) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>{escape(name)}</name>{"".join(placemarks)}</Document></kml>'


def _kml_polygon(geometry: dict) -> str:
    parts = []
    for poly in polygons(geometry):
        rings = ["<outerBoundaryIs><LinearRing><coordinates>" + " ".join(f"{x},{y}" for x, y in poly[0]) + "</coordinates></LinearRing></outerBoundaryIs>"]
        for hole in poly[1:]:
            rings.append("<innerBoundaryIs><LinearRing><coordinates>" + " ".join(f"{x},{y}" for x, y in hole) + "</coordinates></LinearRing></innerBoundaryIs>")
        parts.append("<Polygon>" + "".join(rings) + "</Polygon>")
    return parts[0] if len(parts) == 1 else "<MultiGeometry>" + "".join(parts) + "</MultiGeometry>"


@router.get("/export/detections.{fmt}", dependencies=[Depends(require("viewer"))])
def export_detections(fmt: str, bbox: str | None = None, hours: float = Query(24, gt=0, le=24 * 31), session: Session = Depends(get_session)):
    if fmt not in ("csv", "geojson", "kml"):
        raise HTTPException(400, "format must be csv, geojson or kml")
    rows = incident_svc.query_detections(session, hours, parse_bbox(bbox), limit=100_000)
    stamp = utcnow().strftime("%Y%m%d%H%M")
    if fmt == "geojson":
        return _download(json.dumps({"type": "FeatureCollection", "features": [r.as_feature() for r in rows]}), f"detections-{stamp}.geojson", "application/geo+json")
    if fmt == "kml":
        pms = [f"<Placemark><name>{escape(r.source)} {r.acq_time:%Y-%m-%d %H:%M}</name><description>FRP {r.frp or ''} MW, confidence {r.confidence}</description><Point><coordinates>{r.lon},{r.lat}</coordinates></Point></Placemark>" for r in rows]
        return _download(_kml_doc("Firealerts detections", pms), f"detections-{stamp}.kml", "application/vnd.google-earth.kml+xml")
    data = [r.as_feature()["properties"] | {"lat": r.lat, "lon": r.lon} for r in rows]
    return _download(_csv(data, ["id", "acq_time", "lat", "lon", "source", "satellite", "frp", "brightness", "confidence", "daynight", "pixel_m"]), f"detections-{stamp}.csv", "text/csv")


@router.get("/export/alerts.csv")
def export_alerts(days: int = Query(90, ge=1, le=3650), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    rows = session.scalars(select(Alert).where(Alert.org_id == p.org_id, Alert.created_at >= utcnow() - timedelta(days=days)).order_by(Alert.created_at.desc())).all()
    names = {a.id: a.name for a in session.scalars(select(Asset).where(Asset.org_id == p.org_id))}
    data = [r.as_dict() | {"asset_name": names.get(r.asset_id, ""), "deliveries": len(r.deliveries or [])} for r in rows]
    return _download(_csv(data, ["id", "created_at", "type", "severity", "status", "asset_name", "title", "lat", "lon", "acknowledged_at", "resolved_at", "deliveries"]), "alerts.csv", "text/csv")


@router.get("/export/assets.{fmt}")
def export_assets(fmt: str, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    rows = session.scalars(select(Asset).where(Asset.org_id == p.org_id).order_by(Asset.name)).all()
    if fmt == "geojson":
        fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": a.geometry, "properties": a.as_dict(geometry=False)} for a in rows]}
        return _download(json.dumps(fc), "assets.geojson", "application/geo+json")
    if fmt == "kml":
        pms = [f"<Placemark><name>{escape(a.name)}</name><description>{escape(a.kind)} · {a.area_ha:.1f} ha</description>{_kml_polygon(a.geometry)}</Placemark>" for a in rows]
        return _download(_kml_doc("Firealerts assets", pms), "assets.kml", "application/vnd.google-earth.kml+xml")
    if fmt == "csv":
        return _download(_csv([a.as_dict(geometry=False) | {"lon": a.centroid_lon, "lat": a.centroid_lat} for a in rows], ["id", "name", "kind", "area_ha", "lat", "lon", "buffer_km", "tags", "created_at"]), "assets.csv", "text/csv")
    raise HTTPException(400, "format must be csv, geojson or kml")


@router.get("/export/assets/{asset_id}/timeseries.csv")
def export_timeseries(asset_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    a = session.get(Asset, asset_id)
    if not a or a.org_id != p.org_id:
        raise HTTPException(404, "asset not found")
    obs = {o.date.isoformat(): o for o in session.scalars(select(AssetObservation).where(AssetObservation.asset_id == a.id))}
    risk = {r.date.isoformat(): r for r in session.scalars(select(AssetRisk).where(AssetRisk.asset_id == a.id))}
    rows = []
    for d in sorted(set(obs) | set(risk)):
        o, r = obs.get(d), risk.get(d)
        rows.append({"date": d, "ndvi": o.ndvi if o else "", "nbr": o.nbr if o else "", "ndmi": o.ndmi if o else "", "cloud_pct": o.cloud_pct if o else "", "fwi": r.fwi if r else "", "danger": r.danger if r else "", "ignition_p": r.ignition_p if r else ""})
    return _download(_csv(rows, ["date", "ndvi", "nbr", "ndmi", "cloud_pct", "fwi", "danger", "ignition_p"]), f"asset-{a.id}-timeseries.csv", "text/csv")


@router.get("/data/usage")
def usage(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    asset_ids = select(Asset.id).where(Asset.org_id == p.org_id)
    return {
        "assets": session.scalar(select(func.count()).select_from(Asset).where(Asset.org_id == p.org_id)),
        "alerts": session.scalar(select(func.count()).select_from(Alert).where(Alert.org_id == p.org_id)),
        "observations": session.scalar(select(func.count()).select_from(AssetObservation).where(AssetObservation.asset_id.in_(asset_ids))),
        "risk_snapshots": session.scalar(select(func.count()).select_from(AssetRisk).where(AssetRisk.asset_id.in_(asset_ids))),
        "platform_detections": session.scalar(select(func.count()).select_from(Detection)),
    }
