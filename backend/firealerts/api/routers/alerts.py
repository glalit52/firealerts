from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...auth import Principal, require
from ...db import get_session, utcnow
from ...models import ALERT_TYPES, SEVERITIES, Alert, Asset
from ...services import audit

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _own(session: Session, alert_id: int, p: Principal) -> Alert:
    a = session.get(Alert, alert_id)
    if not a or a.org_id != p.org_id:
        raise HTTPException(404, "alert not found")
    return a


@router.get("")
def list_alerts(
    status: str | None = Query(None, pattern="^(open|acknowledged|resolved|active)$"),
    type: str | None = None,
    severity: str | None = None,
    asset_id: int | None = None,
    days: int = Query(30, ge=1, le=730),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    p: Principal = Depends(require("viewer")),
    session: Session = Depends(get_session),
):
    q = select(Alert).where(Alert.org_id == p.org_id, Alert.created_at >= utcnow() - timedelta(days=days))
    if status == "active":
        q = q.where(Alert.status != "resolved")
    elif status:
        q = q.where(Alert.status == status)
    if type:
        q = q.where(Alert.type.in_(type.split(",")))
    if severity:
        q = q.where(Alert.severity.in_(severity.split(",")))
    if asset_id:
        q = q.where(Alert.asset_id == asset_id)
    total = session.scalar(select(func.count()).select_from(q.subquery()))
    rows = session.scalars(q.order_by(Alert.created_at.desc()).offset(offset).limit(limit)).all()
    names = {a.id: a.name for a in session.scalars(select(Asset).where(Asset.id.in_({r.asset_id for r in rows if r.asset_id})))}
    return {"total": total, "items": [r.as_dict() | {"asset_name": names.get(r.asset_id)} for r in rows]}


@router.get("/stats")
def stats(days: int = Query(30, ge=1, le=365), p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    since = utcnow() - timedelta(days=days)
    base = select(Alert).where(Alert.org_id == p.org_id, Alert.created_at >= since).subquery()
    by_type = dict(session.execute(select(base.c.type, func.count()).group_by(base.c.type)).all())
    by_sev = dict(session.execute(select(base.c.severity, func.count()).group_by(base.c.severity)).all())
    by_status = dict(session.execute(select(base.c.status, func.count()).group_by(base.c.status)).all())
    daily = session.execute(select(func.date(base.c.created_at), func.count()).group_by(func.date(base.c.created_at)).order_by(func.date(base.c.created_at))).all()
    return {
        "days": days,
        "by_type": {t: by_type.get(t, 0) for t in ALERT_TYPES},
        "by_severity": {s: by_sev.get(s, 0) for s in SEVERITIES},
        "by_status": by_status,
        "daily": [{"date": str(d), "count": c} for d, c in daily],
        "open": session.scalar(select(func.count()).select_from(Alert).where(Alert.org_id == p.org_id, Alert.status == "open")) or 0,
    }


@router.get("/{alert_id}")
def get_alert(alert_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    a = _own(session, alert_id, p)
    asset = session.get(Asset, a.asset_id) if a.asset_id else None
    return a.as_dict() | {"asset": asset.as_dict() if asset else None}


def _transition(alert_id: int, p: Principal, session: Session, status: str) -> dict:
    a = _own(session, alert_id, p)
    a.status = status
    now = utcnow()
    if status == "acknowledged":
        a.acknowledged_by, a.acknowledged_at = p.user_id, now
    elif status == "resolved":
        a.resolved_at = now
    elif status == "open":
        a.resolved_at = None
    audit.record(session, p, f"alert.{status}", str(a.id))
    session.commit()
    return a.as_dict()


@router.post("/{alert_id}/ack")
def acknowledge(alert_id: int, p: Principal = Depends(require("member")), session: Session = Depends(get_session)):
    return _transition(alert_id, p, session, "acknowledged")


@router.post("/{alert_id}/resolve")
def resolve(alert_id: int, p: Principal = Depends(require("member")), session: Session = Depends(get_session)):
    return _transition(alert_id, p, session, "resolved")


@router.post("/{alert_id}/reopen")
def reopen(alert_id: int, p: Principal = Depends(require("member")), session: Session = Depends(get_session)):
    return _transition(alert_id, p, session, "open")
