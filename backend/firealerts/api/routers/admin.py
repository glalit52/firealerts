from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...auth import require_superuser
from ...db import get_session, utcnow
from ...models import Alert, Asset, Connector, Detection, IngestRun, Membership, Organization, User
from ...plans import PLANS

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_superuser)])


def _count(session, model, *where):
    return session.scalar(select(func.count()).select_from(model).where(*where)) or 0


@router.get("/stats")
def stats(session: Session = Depends(get_session)):
    day = utcnow() - timedelta(days=1)
    return {
        "organizations": _count(session, Organization),
        "users": _count(session, User),
        "users_active_7d": _count(session, User, User.last_login_at >= utcnow() - timedelta(days=7)),
        "assets": _count(session, Asset),
        "monitored_ha": round(session.scalar(select(func.coalesce(func.sum(Asset.area_ha), 0))) or 0, 1),
        "connectors": _count(session, Connector),
        "alerts_24h": _count(session, Alert, Alert.created_at >= day),
        "detections_24h": _count(session, Detection, Detection.acq_time >= day),
        "detections_total": _count(session, Detection),
        "last_ingest": (r.as_dict() if (r := session.scalar(select(IngestRun).order_by(IngestRun.id.desc()))) else None),
        "plans": {k: _count(session, Organization, Organization.plan == k) for k in PLANS},
    }


@router.get("/orgs")
def orgs(q: str = "", limit: int = Query(100, le=1000), session: Session = Depends(get_session)):
    stmt = select(Organization).order_by(Organization.id.desc()).limit(limit)
    if q:
        stmt = stmt.where(Organization.name.ilike(f"%{q}%"))
    out = []
    for o in session.scalars(stmt):
        out.append(o.as_dict() | {"members": _count(session, Membership, Membership.org_id == o.id), "assets": _count(session, Asset, Asset.org_id == o.id)})
    return out


class PlanIn(BaseModel):
    plan: str


@router.patch("/orgs/{org_id}")
def set_plan(org_id: int, body: PlanIn, session: Session = Depends(get_session)):
    if body.plan not in PLANS:
        raise HTTPException(422, f"plan must be one of {list(PLANS)}")
    o = session.get(Organization, org_id)
    if not o:
        raise HTTPException(404, "not found")
    o.plan = body.plan
    session.commit()
    return o.as_dict()


@router.get("/users")
def users(q: str = "", limit: int = Query(100, le=1000), session: Session = Depends(get_session)):
    stmt = select(User).order_by(User.id.desc()).limit(limit)
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q}%"))
    return [u.as_dict() | {"last_login_at": u.last_login_at.isoformat() if u.last_login_at else None} for u in session.scalars(stmt)]
