from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from ... import __version__, auth, ingest
from ...config import settings
from ...db import get_session, utcnow
from ...integrations.registry import CONNECTOR_TYPES, PUBLIC_SOURCES
from ...models import ALERT_TYPES, ASSET_KINDS, SEVERITIES, Detection, IngestRun
from ...plans import PLANS
from ...science import fwi as F
from ...science import spread
from ...services import billing, email, i18n
from ...services import incidents as incident_svc

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health(session: Session = Depends(get_session)):
    session.execute(text("SELECT 1"))
    return {"status": "ok", "version": __version__}


@router.get("/meta")
def meta():
    """Everything a client needs to render forms and options."""
    return {
        "version": __version__,
        "auth_required": settings.auth_required,
        "registration_open": settings.registration_open,
        "require_email_verification": settings.require_email_verification,
        "email_configured": email.configured(),
        "billing_enabled": billing.enabled(),
        "public_map": settings.public_map,
        "push_enabled": True,
        "languages": list(i18n.LANGUAGES),
        "data_mode": settings.data_mode,
        "plans": PLANS,
        "roles": auth.ROLES,
        "asset_kinds": ASSET_KINDS,
        "alert_types": ALERT_TYPES,
        "severities": SEVERITIES,
        "danger_classes": [name for _, name in F.DANGER_CLASSES],
        "fuels": [{"code": f.code, "name": f.name} for f in spread.FUELS.values()],
        "connector_types": CONNECTOR_TYPES,
    }


@router.get("/status")
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


@router.get("/sources")
def sources(session: Session = Depends(get_session)):
    """Public data sources with live status where the platform ingests them."""
    last = session.scalar(select(IngestRun).order_by(IngestRun.id.desc()))
    per = (last.per_source if last else {}) or {}
    errors = " ".join(last.errors if last else [])
    configured = {
        "firms": True,
        "goes": settings.goes_enabled,
        "himawari": bool(settings.jaxa_ftp_user),
        "meteosat": bool(settings.lsasaf_user),
        "gee": bool(settings.gee_service_account_json),
        "gfw": bool(settings.gfw_api_key),
    }
    keys = {"firms": ("VIIRS", "MODIS"), "goes": ("GOES",), "himawari": ("HIMAWARI",), "meteosat": ("METEOSAT",)}
    out = []
    for src in PUBLIC_SOURCES:
        row = dict(src)
        if src["id"] in keys:
            n = sum(v for k, v in per.items() if k.startswith(keys[src["id"]]))
            failing = any(k in errors for k in keys[src["id"]])
            row["status"] = "disabled" if not configured.get(src["id"], True) else ("error" if failing and not n else ("ok" if n else "idle"))
            row["last_count"] = n
        else:
            row["status"] = "available"
        out.append(row)
    return {"sources": out, "last_ingest": last.as_dict() if last else None, "mode": last.mode if last else settings.data_mode}


@router.post("/ingest", dependencies=[Depends(auth.require("admin"))])
async def trigger_ingest(request: Request, session: Session = Depends(get_session)):
    rec = await ingest.run(session, request.app.state.client, settings)
    incident_svc.invalidate()
    return rec.as_dict()
