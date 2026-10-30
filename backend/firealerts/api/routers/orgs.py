from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import plans
from ...auth import ROLES, Principal, require, require_user
from ...config import settings
from ...db import get_session
from ...models import AuditLog, Invite, Membership, Organization, User
from ...security import new_token, sha256
from ...services import audit, email, i18n

router = APIRouter(prefix="/api", tags=["organisation"])


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class OrgPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    settings: dict | None = None  # timezone, daily_digest, units


class RoleIn(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def _role(cls, v):
        if v not in ROLES:
            raise ValueError(f"role must be one of {', '.join(ROLES)}")
        return v


class InviteIn(RoleIn):
    email: str
    role: str = "member"


def _owners(session: Session, org_id: int) -> int:
    return session.scalar(select(func.count()).select_from(Membership).where(Membership.org_id == org_id, Membership.role == "owner")) or 0


@router.post("/orgs", status_code=201)
def create_org(body: OrgIn, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    org = Organization(name=body.name.strip(), plan=settings.default_plan, settings={"daily_digest": True})
    session.add(org)
    session.flush()
    session.add(Membership(user_id=p.user.id, org_id=org.id, role="owner"))
    session.commit()
    return {"id": org.id, "name": org.name, "role": "owner", "plan": org.plan}


@router.get("/org")
def get_org(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    org = session.get(Organization, p.org_id)
    return {**org.as_dict(), "role": p.role, "limits": plans.limits(org), "usage": plans.usage(session, org)}


@router.patch("/org")
def update_org(body: OrgPatch, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    org = session.get(Organization, p.org_id)
    if body.name is not None:
        org.name = body.name.strip()
    if body.settings is not None:
        allowed = {"timezone", "daily_digest", "units", "default_buffer_km", "language"}
        if "language" in body.settings and body.settings["language"] not in i18n.LANGUAGES:
            raise HTTPException(422, f"language must be one of {', '.join(i18n.LANGUAGES)}")
        org.settings = {**(org.settings or {}), **{k: v for k, v in body.settings.items() if k in allowed}}
    audit.record(session, p, "org.update", org.name)
    session.commit()
    return org.as_dict()


@router.delete("/org", status_code=204)
def delete_org(p: Principal = Depends(require("owner")), session: Session = Depends(get_session)):
    org = session.get(Organization, p.org_id)
    if org.is_default:
        raise HTTPException(400, "the default organisation cannot be deleted")
    session.delete(org)
    session.commit()


@router.get("/org/members")
def members(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    rows = session.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(Membership.org_id == p.org_id).order_by(Membership.id)).all()
    pending = session.scalars(select(Invite).where(Invite.org_id == p.org_id, Invite.accepted_at.is_(None))).all()
    return {
        "members": [{"user_id": u.id, "email": u.email, "name": u.name, "role": m.role, "joined_at": m.created_at.isoformat(), "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None} for m, u in rows],
        "pending_invites": [{"id": i.id, "email": i.email, "role": i.role, "created_at": i.created_at.isoformat()} for i in pending],
    }


@router.patch("/org/members/{user_id}")
def change_role(user_id: int, body: RoleIn, p: Principal = Depends(require("owner")), session: Session = Depends(get_session)):
    m = session.scalar(select(Membership).where(Membership.org_id == p.org_id, Membership.user_id == user_id))
    if not m:
        raise HTTPException(404, "not a member")
    if m.role == "owner" and body.role != "owner" and _owners(session, p.org_id) <= 1:
        raise HTTPException(400, "an organisation needs at least one owner")
    m.role = body.role
    audit.record(session, p, "member.role", str(user_id), role=body.role)
    session.commit()
    return {"user_id": user_id, "role": m.role}


@router.delete("/org/members/{user_id}", status_code=204)
def remove_member(user_id: int, p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    is_self = p.user is not None and p.user.id == user_id
    if not is_self and not p.can("admin"):
        raise HTTPException(403, "requires the admin role")
    m = session.scalar(select(Membership).where(Membership.org_id == p.org_id, Membership.user_id == user_id))
    if not m:
        raise HTTPException(404, "not a member")
    if m.role == "owner" and (_owners(session, p.org_id) <= 1 or not p.can("owner")):
        raise HTTPException(400, "owners can only be removed by another owner, and the last owner cannot leave")
    session.delete(m)
    audit.record(session, p, "member.remove", str(user_id))
    session.commit()


@router.post("/org/invites", status_code=201)
async def invite(body: InviteIn, request: Request, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    if body.role == "owner" and not p.can("owner"):
        raise HTTPException(403, "only owners can invite owners")
    org = session.get(Organization, p.org_id)
    plans.check(session, org, "members")
    raw = new_token(nbytes=24)
    inv = Invite(org_id=p.org_id, email=body.email.strip().lower(), role=body.role, token_hash=sha256(raw), invited_by=p.user.id if p.user else 0)
    session.add(inv)
    audit.record(session, p, "invite.create", inv.email, role=inv.role)
    session.commit()
    url = f"{settings.app_url.rstrip('/')}/invite/{raw}"
    inviter = p.user.name or p.user.email if p.user else "A colleague"
    sent = False
    lang = (org.settings or {}).get("language")
    try:
        sent = await email.send(
            inv.email,
            i18n.t(lang, "email.invite.subject", org=org.name),
            i18n.t(lang, "email.invite.body", inviter=inviter, org=org.name, role=inv.role),
            (i18n.t(lang, "email.invite.action"), url),
            request.app.state.client,
        )
    except Exception:
        sent = False
    return {"id": inv.id, "email": inv.email, "role": inv.role, "invite_url": url, "emailed": sent}


@router.delete("/org/invites/{invite_id}", status_code=204)
def revoke_invite(invite_id: int, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    inv = session.get(Invite, invite_id)
    if not inv or inv.org_id != p.org_id:
        raise HTTPException(404, "not found")
    session.delete(inv)
    session.commit()


@router.get("/org/audit")
def audit_log(limit: int = Query(100, ge=1, le=500), p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    rows = session.scalars(select(AuditLog).where(AuditLog.org_id == p.org_id).order_by(AuditLog.id.desc()).limit(limit)).all()
    users = {u.id: u.email for u in session.scalars(select(User).where(User.id.in_({r.user_id for r in rows if r.user_id})))}
    return [r.as_dict() | {"user_email": users.get(r.user_id)} for r in rows]
