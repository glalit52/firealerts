"""Alert engine: creates, de-duplicates, escalates and routes alerts.

Alert types
* detection: satellite fire pixels inside an asset or its buffer.
* threat:    a nearby fire whose ensemble spread forecast reaches the asset
             (likely perimeter -> ETA; P90 envelope -> possible).
* risk:      the daily fire-danger / ignition-probability forecast for the asset
             reaches its threshold (a pre-fire warning).
An alert is re-notified only when its severity escalates.
"""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import geo
from ..config import settings
from ..db import utcnow
from ..integrations import notify
from ..models import SEVERITIES, Alert, Asset, Connector, Detection, Membership, NotificationRule, Organization, User
from ..science import fwi as F
from ..science import spread
from ..sources import weather
from . import assets as asset_svc
from . import connectors as conn_svc
from . import incidents as incident_svc

log = logging.getLogger(__name__)
DANGER_ORDER = [name for _, name in F.DANGER_CLASSES]


def sev_rank(s: str) -> int:
    return SEVERITIES.index(s) if s in SEVERITIES else 0


def weather_mode() -> str:
    return settings.data_mode if settings.data_mode in ("live", "demo") else "auto"


# ----------------------------------------------------------------------------- upsert + routing


def upsert(
    session: Session,
    *,
    org_id: int,
    asset: Asset | None,
    type: str,
    severity: str,
    title: str,
    message: str,
    data: dict,
    lat: float | None,
    lon: float | None,
    dedupe_key: str,
    window_hours: float = 24,
) -> tuple[Alert, bool]:
    """Create or update the open alert with this key. Returns (alert, should_notify)."""
    since = utcnow() - timedelta(hours=window_hours)
    existing = session.scalar(
        select(Alert)
        .where(Alert.org_id == org_id, Alert.dedupe_key == dedupe_key, Alert.status != "resolved", Alert.created_at >= since)
        .order_by(Alert.id.desc())
    )
    if existing:
        escalated = sev_rank(severity) > sev_rank(existing.severity)
        existing.title, existing.message, existing.lat, existing.lon = title, message, lat, lon
        existing.data = {**(existing.data or {}), **data}
        if escalated:
            existing.severity = severity
            existing.status = "open"
        return existing, escalated
    alert = Alert(
        org_id=org_id,
        asset_id=asset.id if asset else None,
        type=type,
        severity=severity,
        title=title,
        message=message,
        data=data,
        lat=lat,
        lon=lon,
        dedupe_key=dedupe_key,
    )
    session.add(alert)
    session.flush()
    return alert, True


def _member_emails(session: Session, org_id: int) -> list[str]:
    rows = session.execute(select(User.email).join(Membership, Membership.user_id == User.id).where(Membership.org_id == org_id, Membership.role != "viewer")).all()
    return [r[0] for r in rows]


def route(session: Session, alert: Alert) -> list[Connector]:
    """Connectors that should receive this alert according to the org's rules."""
    connectors = {c.id: c for c in session.scalars(select(Connector).where(Connector.org_id == alert.org_id, Connector.enabled.is_(True)))}
    connectors = {k: c for k, c in connectors.items() if c.type in notify.CHANNELS}
    rules = session.scalars(select(NotificationRule).where(NotificationRule.org_id == alert.org_id, NotificationRule.enabled.is_(True))).all()
    if not rules:  # sensible default: everything moderate and above goes to every channel
        return list(connectors.values()) if sev_rank(alert.severity) >= sev_rank("moderate") else []
    chosen: dict[int, Connector] = {}
    for r in rules:
        if r.asset_ids and alert.asset_id not in r.asset_ids:
            continue
        if alert.type not in (r.alert_types or []):
            continue
        if sev_rank(alert.severity) < sev_rank(r.min_severity):
            continue
        for cid in r.connector_ids or []:
            if cid in connectors:
                chosen[cid] = connectors[cid]
    return list(chosen.values())


def message_for(session: Session, alert: Alert) -> notify.Message:
    asset = session.get(Asset, alert.asset_id) if alert.asset_id else None
    org = session.get(Organization, alert.org_id)
    return notify.Message(
        title=alert.title,
        text=alert.message,
        severity=alert.severity,
        type=alert.type,
        url=f"{settings.app_url.rstrip('/')}/app/alerts/{alert.id}",
        lat=alert.lat,
        lon=alert.lon,
        alert_id=alert.id,
        asset_name=asset.name if asset else "",
        org_name=org.name if org else "",
        data={k: v for k, v in (alert.data or {}).items() if k != "detection_ids"},
        recipients=_member_emails(session, alert.org_id),
    )


async def dispatch(session: Session, client: httpx.AsyncClient, alert: Alert) -> list[dict]:
    targets = route(session, alert)
    if not targets:
        return []
    msg = message_for(session, alert)

    async def one(c: Connector) -> dict:
        try:
            await notify.CHANNELS[c.type](client, conn_svc.config(c), msg)
            c.last_status, c.last_error = "ok", ""
            status = "ok"
        except Exception as exc:
            log.warning("delivery via connector %s (%s) failed: %s", c.id, c.type, exc)
            c.last_status, c.last_error = "error", str(exc)[:500]
            status = f"error: {str(exc)[:200]}"
        c.last_used_at = utcnow()
        return {"connector_id": c.id, "type": c.type, "name": c.name, "status": status, "at": utcnow().isoformat(), "severity": alert.severity}

    results = await asyncio.gather(*[one(c) for c in targets])
    alert.deliveries = (alert.deliveries or []) + list(results)
    return list(results)


async def _emit(session: Session, client: httpx.AsyncClient, alert: Alert, notify_now: bool) -> None:
    if notify_now:
        await dispatch(session, client, alert)


# ----------------------------------------------------------------------------- detection alerts


async def on_new_detections(session: Session, client: httpx.AsyncClient, new: list[Detection]) -> int:
    fresh = [d for d in new if d.acq_time >= utcnow() - timedelta(hours=6)]  # never alert on stale backfill
    if not fresh:
        return 0
    created = 0
    for asset in session.scalars(select(Asset).where(Asset.active.is_(True))):
        hits = asset_svc.match_detections(asset, fresh)
        if not hits:
            continue
        inside = [d for d, km in hits if km == 0]
        frps = [d.frp for d, _ in hits if d.frp is not None]
        max_frp = max(frps) if frps else None
        nearest_det, nearest_km = min(hits, key=lambda h: h[1])
        if inside:
            severity = "critical" if (len(inside) >= 5 or (max_frp or 0) >= 100) else "high"
            where = f"inside {asset.name}"
        else:
            severity = "moderate"
            where = f"{nearest_km:.1f} km from {asset.name}"
        prev = session.scalar(
            select(Alert).where(Alert.org_id == asset.org_id, Alert.dedupe_key == f"det:{asset.id}", Alert.status != "resolved", Alert.created_at >= utcnow() - timedelta(hours=12))
        )
        ids = sorted(set((prev.data or {}).get("detection_ids", []) if prev else []) | {d.id for d, _ in hits})
        sources = sorted({d.source for d, _ in hits} | set((prev.data or {}).get("sources", []) if prev else []))
        title = f"{len(ids)} fire detection{'s' if len(ids) != 1 else ''} {where}"
        text = (
            f"Satellites detected active fire {where}.\n\n"
            f"Nearest pixel: {nearest_det.lat:.4f}, {nearest_det.lon:.4f} ({nearest_det.source}, {nearest_det.acq_time:%Y-%m-%d %H:%M} UTC)"
            + (f", radiative power up to {max_frp:.0f} MW." if max_frp else ".")
        )
        alert, should = upsert(
            session,
            org_id=asset.org_id,
            asset=asset,
            type="detection",
            severity=severity,
            title=title,
            message=text,
            data={"detection_ids": ids[-500:], "count": len(ids), "inside": len(inside), "max_frp": max_frp, "nearest_km": round(nearest_km, 2), "sources": sources},
            lat=nearest_det.lat,
            lon=nearest_det.lon,
            dedupe_key=f"det:{asset.id}",
            window_hours=12,
        )
        created += 1 if should else 0
        await _emit(session, client, alert, should)
    session.commit()
    return created


# ----------------------------------------------------------------------------- threat alerts (predictive)


def _eta(result: dict, asset: Asset) -> tuple[int | None, int | None]:
    likely = possible = None
    for f in sorted(result["perimeters"]["features"], key=lambda f: f["properties"]["horizon_h"]):
        ring = f["geometry"]["coordinates"][0]
        if not geo.ring_intersects_geometry(ring, asset.geometry):
            continue
        h = f["properties"]["horizon_h"]
        if f["properties"]["kind"] == "likely" and likely is None:
            likely = h
        if f["properties"]["kind"] == "p90" and possible is None:
            possible = h
    return likely, possible


async def check_threats(session: Session, client: httpx.AsyncClient, max_forecasts: int = 40) -> int:
    incs, summaries = incident_svc.incidents(session, 24)
    active = [s for s in summaries.values() if s["status"] == "active"]
    if not active:
        return 0
    pairs = []
    for asset in session.scalars(select(Asset).where(Asset.active.is_(True))):
        for s in active:
            d = geo.haversine_km(asset.centroid_lat, asset.centroid_lon, s["lat"], s["lon"])
            reach = asset.threat_radius_km + math.sqrt(max(asset.area_ha, 0) / 100) / 2
            if d <= reach:
                km = geo.distance_to_geometry_km(s["lon"], s["lat"], asset.geometry)
                if km > 0:
                    pairs.append((km, asset, s))
    created = 0
    forecasts: dict[str, dict] = {}
    for km, asset, s in sorted(pairs, key=lambda p: p[0])[:max_forecasts]:
        if s["id"] not in forecasts:
            try:
                fw = await weather.fire_weather(client, s["lat"], s["lon"], weather_mode())
                front = incs[s["id"]].active_front()
                inp = spread.SpreadInputs([(d.lon, d.lat, d.pixel_m) for d in front], fw["hourly"], fw["state"], spread.auto_fuel(s["lat"]), horizons=(1, 3, 6, 12, 24), members=12)
                forecasts[s["id"]] = await asyncio.to_thread(spread.forecast, inp)
            except Exception as exc:
                log.warning("threat forecast for incident %s failed: %s", s["id"], exc)
                continue
        likely, possible = _eta(forecasts[s["id"]], asset)
        if likely is None and possible is None:
            continue
        if likely is not None:
            severity = "critical" if likely <= 6 else "high"
            title = f"Fire may reach {asset.name} within ~{likely} h"
        else:
            severity = "moderate"
            title = f"Fire could reach {asset.name} within {possible} h (worst case)"
        bearing = asset_svc.bearing_deg(asset.centroid_lat, asset.centroid_lon, s["lat"], s["lon"])
        text = (
            f"An active fire {km:.1f} km away (bearing {bearing:.0f}°, {s['count']} pixels, {s['frp_sum']:.0f} MW) is forecast to "
            + (f"reach the asset in about {likely} hours (median of the ensemble)." if likely is not None else f"possibly reach the asset within {possible} hours (P90 envelope).")
            + "\n\nForecast: Canadian FBP rate of spread with ensemble weather; terrain and suppression not included."
        )
        alert, should = upsert(
            session,
            org_id=asset.org_id,
            asset=asset,
            type="threat",
            severity=severity,
            title=title,
            message=text,
            data={"incident_id": s["id"], "distance_km": round(km, 2), "eta_likely_h": likely, "eta_p90_h": possible, "bearing_deg": round(bearing)},
            lat=s["lat"],
            lon=s["lon"],
            dedupe_key=f"threat:{asset.id}:{s['id']}",
            window_hours=48,
        )
        created += 1 if should else 0
        await _emit(session, client, alert, should)
    session.commit()
    return created


# ----------------------------------------------------------------------------- risk alerts (pre-fire)

RISK_SEVERITY = {"high": "moderate", "very_high": "high", "extreme": "critical"}


async def raise_risk_alert(session: Session, client: httpx.AsyncClient, asset: Asset, days: list[dict]) -> bool:
    """Alert when any of the next 3 forecast days reaches the asset's danger threshold."""
    if not asset.risk_alerts:
        return False
    threshold = DANGER_ORDER.index(asset.risk_min_danger) if asset.risk_min_danger in DANGER_ORDER else DANGER_ORDER.index("high")
    upcoming = [d for d in days if d["forecast"]][:3]
    hits = [d for d in upcoming if DANGER_ORDER.index(d["danger"]) >= threshold]
    if not hits:
        return False
    worst = max(hits, key=lambda d: d["fwi"])
    severity = RISK_SEVERITY.get(worst["danger"], "low")
    label = worst["danger"].replace("_", " ")
    p = worst.get("ignition_p")
    title = f"{label.capitalize()} fire danger forecast for {asset.name} on {worst['date']}"
    text = (
        f"Fire Weather Index {worst['fwi']:.0f} ({label}) is forecast for {worst['date']}"
        + (f", with an estimated {p * 100:.0f}% chance of a satellite-detected fire in the area." if p is not None else ".")
        + f"\n\nWeather that day: {worst['temp']:.0f}°C, {worst['rh']:.0f}% humidity, wind {worst['wind']:.0f} km/h. Consider readiness measures and restricting burning."
    )
    alert, should = upsert(
        session,
        org_id=asset.org_id,
        asset=asset,
        type="risk",
        severity=severity,
        title=title,
        message=text,
        data={"date": worst["date"], "fwi": worst["fwi"], "danger": worst["danger"], "ignition_p": p, "days": [{k: d[k] for k in ("date", "fwi", "danger")} for d in upcoming]},
        lat=asset.centroid_lat,
        lon=asset.centroid_lon,
        dedupe_key=f"risk:{asset.id}:{utcnow().date().isoformat()}",
        window_hours=24,
    )
    await _emit(session, client, alert, should)
    return should
