"""Asset intelligence: risk snapshots, Sentinel-2 vegetation, fire history, forest loss, exposure."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

import httpx
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import utcnow
from ..integrations import gee, gfw, osm, planetary, sentinel2
from ..ml import features, model
from ..models import Asset, AssetAnalysis, AssetObservation, AssetRisk, Detection
from ..sources import weather
from . import alerting
from . import connectors as conn_svc

log = logging.getLogger(__name__)


# ----------------------------------------------------------------------------- risk


async def compute_risk(session: Session, client: httpx.AsyncClient, asset: Asset, alert: bool = True) -> list[dict]:
    """FWI (observed + 7-day forecast) and ignition probability at the asset; stored as AssetRisk rows."""
    fw = await weather.fire_weather(client, asset.centroid_lat, asset.centroid_lon, alerting.weather_mode())
    days = fw["days"][-8:]
    m = model.load(settings.model_path)
    static = await features.cell_static(client, asset.centroid_lat, asset.centroid_lon, 0.25, alerting.weather_mode())
    since = utcnow() - timedelta(days=7)
    pad = 0.125
    recent = session.scalar(
        select(func.count()).select_from(Detection).where(
            Detection.acq_time >= since,
            Detection.lat.between(asset.centroid_lat - pad, asset.centroid_lat + pad),
            Detection.lon.between(asset.centroid_lon - pad, asset.centroid_lon + pad),
        )
    ) or 0
    import numpy as np

    X = np.asarray([features.row(d, static, asset.centroid_lat, recent if not d["forecast"] else recent / 7) for d in days])
    probs = m.predict_proba(X) if len(X) else []
    out = []
    session.execute(delete(AssetRisk).where(AssetRisk.asset_id == asset.id, AssetRisk.date >= date.fromisoformat(days[0]["date"])))
    for d, p in zip(days, probs):
        d = {**d, "ignition_p": round(float(p), 4)}
        out.append(d)
        session.add(
            AssetRisk(
                asset_id=asset.id,
                date=date.fromisoformat(d["date"]),
                fwi=d["fwi"],
                danger=d["danger"],
                ignition_p=d["ignition_p"],
                forecast=d["forecast"],
                data={k: d[k] for k in ("temp", "rh", "wind", "rain", "ffmc", "dmc", "dc", "isi", "bui")} | {"weather_source": fw["source"], "model": m.meta.get("kind")},
            )
        )
    session.flush()
    if alert:
        await alerting.raise_risk_alert(session, client, asset, out)
    session.commit()
    return out


def latest_risk(session: Session, asset: Asset) -> list[dict]:
    today = utcnow().date()
    rows = session.scalars(select(AssetRisk).where(AssetRisk.asset_id == asset.id, AssetRisk.date >= today - timedelta(days=1)).order_by(AssetRisk.date)).all()
    return [r.as_dict() for r in rows]


def risk_is_stale(session: Session, asset: Asset, hours: float = 6) -> bool:
    last = session.scalar(select(func.max(AssetRisk.computed_at)).where(AssetRisk.asset_id == asset.id))
    return last is None or (utcnow() - last).total_seconds() > hours * 3600


# ----------------------------------------------------------------------------- Sentinel-2 vegetation


async def refresh_vegetation(session: Session, client: httpx.AsyncClient, asset: Asset, days: int = 120, max_new: int = 6) -> dict:
    end = utcnow().date()
    start = end - timedelta(days=days)
    scenes = await sentinel2.search(client, asset.geometry, start, end, limit=30)
    known = set(session.scalars(select(AssetObservation.scene_id).where(AssetObservation.asset_id == asset.id)))
    todo = [s for s in scenes if s.id not in known][:max_new]
    added = 0
    for sc in todo:
        try:
            r = await sentinel2.analyse(client, asset.geometry, sc)
        except Exception as exc:
            log.warning("Sentinel-2 analysis of %s for asset %s failed: %s", sc.id, asset.id, exc)
            continue
        session.add(
            AssetObservation(
                asset_id=asset.id,
                source="sentinel-2",
                scene_id=sc.id,
                date=sc.date,
                cloud_pct=sc.cloud,
                valid_frac=r["valid_frac"],
                ndvi=r["ndvi"] if r["valid_frac"] >= 0.2 else None,
                nbr=r["nbr"] if r["valid_frac"] >= 0.2 else None,
                ndmi=r["ndmi"] if r["valid_frac"] >= 0.2 else None,
                stats=r["stats"] | {"points": r["points"], "spacing_m": r["spacing_m"]},
            )
        )
        added += 1
    session.commit()
    return {"scenes_found": len(scenes), "analysed": added}


def vegetation(session: Session, asset: Asset, days: int = 365) -> dict:
    since = utcnow().date() - timedelta(days=days)
    rows = session.scalars(select(AssetObservation).where(AssetObservation.asset_id == asset.id, AssetObservation.date >= since).order_by(AssetObservation.date)).all()
    series = [r.as_dict() for r in rows]
    good = [s for s in series if s["ndvi"] is not None]
    trend = None
    if len(good) >= 2:
        recent, prev = good[-1], good[max(0, len(good) - 4)]
        trend = {"ndvi_change": round(recent["ndvi"] - prev["ndvi"], 4), "from": prev["date"], "to": recent["date"]}
        if recent["nbr"] is not None and prev["nbr"] is not None:
            trend["nbr_change"] = round(recent["nbr"] - prev["nbr"], 4)
            trend["possible_burn"] = prev["nbr"] - recent["nbr"] >= 0.1
    return {"observations": series, "latest": good[-1] if good else None, "trend": trend}


# ----------------------------------------------------------------------------- cached analyses


def cached(session: Session, asset: Asset, kind: str, params_key: str, max_age_h: float) -> AssetAnalysis | None:
    row = session.scalar(select(AssetAnalysis).where(AssetAnalysis.asset_id == asset.id, AssetAnalysis.kind == kind, AssetAnalysis.params_key == params_key).order_by(AssetAnalysis.id.desc()))
    if row and (utcnow() - row.created_at).total_seconds() <= max_age_h * 3600:
        return row
    return None


def store(session: Session, asset: Asset, kind: str, params_key: str, source: str, result: dict) -> AssetAnalysis:
    session.execute(delete(AssetAnalysis).where(AssetAnalysis.asset_id == asset.id, AssetAnalysis.kind == kind, AssetAnalysis.params_key == params_key))
    row = AssetAnalysis(asset_id=asset.id, kind=kind, params_key=params_key, source=source, result=result)
    session.add(row)
    session.commit()
    return row


def archive_fire_history(session: Session, asset: Asset, days: int = 365) -> list[dict]:
    """Monthly counts of satellite detections inside the asset from the local archive."""
    from . import assets as asset_svc

    hits = asset_svc.detections_near(session, asset, days=days, radius_km=0)
    months: dict[str, int] = {}
    for d, _ in hits:
        k = d.acq_time.strftime("%Y-%m")
        months[k] = months.get(k, 0) + 1
    return [{"month": k, "detections": v} for k, v in sorted(months.items())]


async def burn_history(session: Session, client: httpx.AsyncClient, asset: Asset, years: int = 5) -> dict:
    hit = cached(session, asset, "burn_history", str(years), 24 * 7)
    if hit:
        return hit.as_dict()
    end = utcnow().date()
    start = date(end.year - years, 1, 1)
    errors = []
    creds = conn_svc.data_credentials(session, asset.org_id, "gee")
    if creds:
        try:
            months = await gee.burned_area(creds["service_account_json"], creds.get("project", ""), asset.geometry, start.isoformat(), end.isoformat())
            return store(session, asset, "burn_history", str(years), "Google Earth Engine · MODIS MCD64A1", {"months": months, "archive": archive_fire_history(session, asset)}).as_dict()
        except Exception as exc:
            errors.append(f"Earth Engine: {exc}")
    try:
        months = await planetary.modis_burned_area(client, asset.geometry, start, end, asset.area_ha)
        return store(session, asset, "burn_history", str(years), "Planetary Computer · MODIS MCD64A1", {"months": months, "archive": archive_fire_history(session, asset)}).as_dict()
    except Exception as exc:
        errors.append(f"Planetary Computer: {exc}")
    return {"kind": "burn_history", "source": "local detection archive", "result": {"months": [], "archive": archive_fire_history(session, asset), "errors": errors}, "created_at": utcnow().isoformat()}


async def forest_loss(session: Session, client: httpx.AsyncClient, asset: Asset) -> dict:
    hit = cached(session, asset, "forest_loss", "", 24 * 30)
    if hit:
        return hit.as_dict()
    errors = []
    gfw_creds = conn_svc.data_credentials(session, asset.org_id, "gfw")
    if gfw_creds:
        try:
            loss = await gfw.tree_cover_loss(client, gfw_creds["api_key"], asset.geometry)
            alerts = await gfw.integrated_alerts(client, gfw_creds["api_key"], asset.geometry, (utcnow().date() - timedelta(days=90)).isoformat())
            return store(session, asset, "forest_loss", "", "Global Forest Watch", {"loss_by_year": loss, "recent_alerts": alerts}).as_dict()
        except Exception as exc:
            errors.append(f"Global Forest Watch: {exc}")
    gee_creds = conn_svc.data_credentials(session, asset.org_id, "gee")
    if gee_creds:
        try:
            loss = await gee.tree_cover_loss(gee_creds["service_account_json"], gee_creds.get("project", ""), asset.geometry)
            return store(session, asset, "forest_loss", "", "Google Earth Engine · Hansen GFC", {"loss_by_year": loss}).as_dict()
        except Exception as exc:
            errors.append(f"Earth Engine: {exc}")
    return {
        "kind": "forest_loss",
        "source": None,
        "result": {"loss_by_year": [], "errors": errors or ["Connect Global Forest Watch or Google Earth Engine in Integrations to enable forest-loss analytics."]},
        "created_at": utcnow().isoformat(),
    }


async def exposure(session: Session, client: httpx.AsyncClient, asset: Asset, radius_km: float = 10) -> dict:
    key = f"{radius_km:g}"
    hit = cached(session, asset, "exposure", key, 24 * 14)
    if hit:
        return hit.as_dict()
    import math

    radius_m = int(radius_km * 1000 + math.sqrt(asset.area_ha * 1e4 / math.pi))
    try:
        res = await osm.exposure(client, asset.centroid_lat, asset.centroid_lon, radius_m)
    except Exception as exc:
        return {"kind": "exposure", "source": "OpenStreetMap", "result": {"error": str(exc)}, "created_at": utcnow().isoformat()}
    return store(session, asset, "exposure", key, "OpenStreetMap (Overpass)", res).as_dict()


def parse_day(v: str | None) -> date | None:
    return datetime.fromisoformat(v).date() if v else None
