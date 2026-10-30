"""Monitored assets (forests, plantations, farms...): geometry, import and fire context."""

from __future__ import annotations

import io
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import geo
from ..db import utcnow
from ..models import Asset, Detection

_CONF_RANK = {"l": 0, "n": 1, "h": 2}


def apply_geometry(asset: Asset, geometry: dict) -> None:
    g = geo.validate_geometry(geometry)
    st = geo.geometry_stats(g)
    asset.geometry = g
    asset.area_ha = st["area_ha"]
    asset.centroid_lon, asset.centroid_lat = st["centroid"]
    asset.bbox = [round(v, 6) for v in st["bbox"]]


# ----------------------------------------------------------------------------- import


def _features_from_geojson(data: dict) -> list[dict]:
    t = data.get("type")
    if t == "FeatureCollection":
        return [f for f in data.get("features", []) if f.get("geometry")]
    if t == "Feature":
        return [data]
    if t in ("Polygon", "MultiPolygon"):
        return [{"type": "Feature", "properties": {}, "geometry": data}]
    raise ValueError("unsupported GeoJSON")


def _kml_coords(text: str) -> list[list[float]]:
    pts = []
    for tok in text.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            pts.append([float(parts[0]), float(parts[1])])
    return pts


def _features_from_kml(raw: bytes) -> list[dict]:
    root = ET.fromstring(raw)
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"
    feats = []
    for pm in root.iter(f"{ns}Placemark"):
        name_el = pm.find(f"{ns}name")
        polys = []
        for poly in pm.iter(f"{ns}Polygon"):
            outer = poly.find(f".//{ns}outerBoundaryIs//{ns}coordinates")
            if outer is None or not outer.text:
                continue
            rings = [_kml_coords(outer.text)]
            for inner in poly.findall(f".//{ns}innerBoundaryIs//{ns}coordinates"):
                if inner.text:
                    rings.append(_kml_coords(inner.text))
            polys.append(rings)
        if not polys:
            continue
        geom = {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
        props = {"name": name_el.text.strip()} if name_el is not None and name_el.text else {}
        feats.append({"type": "Feature", "properties": props, "geometry": geom})
    return feats


def _features_from_shapefile(raw: bytes) -> list[dict]:
    import shapefile

    z = zipfile.ZipFile(io.BytesIO(raw))
    names = z.namelist()
    shp = next((n for n in names if n.lower().endswith(".shp")), None)
    if not shp:
        raise ValueError("zip contains no .shp")
    base = shp[:-4]

    def member(ext):
        for n in names:
            if n.lower() == (base + ext).lower():
                return io.BytesIO(z.read(n))
        return None

    prj = member(".prj")
    if prj is not None:
        if "PROJCS" in prj.read().decode("utf-8", "replace").upper():
            raise ValueError("the shapefile is in a projected CRS; re-project it to WGS84 (EPSG:4326) before importing")
    r = shapefile.Reader(shp=member(".shp"), shx=member(".shx"), dbf=member(".dbf"))
    fields = [f[0] for f in r.fields[1:]]
    feats = []
    for sr in r.shapeRecords():
        gi = sr.shape.__geo_interface__
        if gi["type"] not in ("Polygon", "MultiPolygon"):
            continue
        props = {k: (v if isinstance(v, (int, float, str)) or v is None else str(v)) for k, v in zip(fields, sr.record)}
        feats.append({"type": "Feature", "properties": props, "geometry": gi})
    return feats


def parse_upload(filename: str, raw: bytes) -> list[dict]:
    """GeoJSON, KML, KMZ or zipped Shapefile -> list of GeoJSON features (polygons only)."""
    name = filename.lower()
    if name.endswith((".geojson", ".json")):
        feats = _features_from_geojson(json.loads(raw))
    elif name.endswith(".kml"):
        feats = _features_from_kml(raw)
    elif name.endswith(".kmz"):
        z = zipfile.ZipFile(io.BytesIO(raw))
        kml = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
        if not kml:
            raise ValueError("KMZ contains no KML")
        feats = _features_from_kml(z.read(kml))
    elif name.endswith(".zip"):
        feats = _features_from_shapefile(raw)
    else:
        raise ValueError("supported formats: .geojson, .json, .kml, .kmz, zipped shapefile (.zip)")
    feats = [f for f in feats if f["geometry"]["type"] in ("Polygon", "MultiPolygon")]
    if not feats:
        raise ValueError("no polygons found in the file")
    return feats


def feature_name(props: dict, fallback: str) -> str:
    for k in ("name", "Name", "NAME", "nombre", "title", "id", "ID"):
        if props.get(k):
            return str(props[k])[:160]
    return fallback


# ----------------------------------------------------------------------------- fire context


def detections_near(session: Session, asset: Asset, days: float = 7, radius_km: float | None = None) -> list[tuple[Detection, float]]:
    radius_km = radius_km if radius_km is not None else max(asset.buffer_km, 25.0)
    w, s, e, n = asset.bbox
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.05, math.cos(math.radians(asset.centroid_lat))))
    q = select(Detection).where(
        Detection.acq_time >= utcnow() - timedelta(days=days),
        Detection.lat.between(s - dlat, n + dlat),
        Detection.lon.between(w - dlon, e + dlon),
    )
    out = []
    for d in session.scalars(q):
        km = geo.distance_to_geometry_km(d.lon, d.lat, asset.geometry)
        if km <= radius_km:
            out.append((d, km))
    return sorted(out, key=lambda t: (t[1], -t[0].acq_time.timestamp()))


def match_detections(asset: Asset, detections: list[Detection]) -> list[tuple[Detection, float]]:
    """Detections inside the asset or its buffer that meet its confidence threshold."""
    if not asset.bbox:
        return []
    w, s, e, n = asset.bbox
    pad = asset.buffer_km / 111.0 + 0.01
    padx = pad / max(0.05, math.cos(math.radians(asset.centroid_lat)))
    min_rank = _CONF_RANK.get(asset.min_confidence, 1)
    hits = []
    for d in detections:
        if not (s - pad <= d.lat <= n + pad and w - padx <= d.lon <= e + padx):
            continue
        if _CONF_RANK.get(d.confidence, 1) < min_rank:
            continue
        km = geo.distance_to_geometry_km(d.lon, d.lat, asset.geometry)
        if km <= asset.buffer_km:
            hits.append((d, km))
    return hits


def bearing_deg(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360
