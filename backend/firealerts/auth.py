"""Request principal, roles and token issuing.

* Tokens (sessions and API keys) are random 256-bit strings; only their SHA-256
  is stored, so a database leak does not leak usable credentials.
* Each request acts within one organisation (``X-Org-Id`` header, defaulting to
  the user's first membership). Roles: viewer < member < admin < owner.
* With ``AUTH_REQUIRED=false`` (self-hosted default) anonymous requests act as
  the owner of a built-in default organisation, so a single-user install needs
  no login at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_session, utcnow
from .models import AuthToken, Membership, Organization, User
from .security import new_token, sha256

ROLES = ["viewer", "member", "admin", "owner"]
SESSION_DAYS = 30


def issue_token(session: Session, user: User, kind: str = "session", name: str = "") -> str:
    raw = new_token("fa_" if kind == "api" else "fs_")
    session.add(
        AuthToken(
            token_hash=sha256(raw),
            user_id=user.id,
            kind=kind,
            name=name,
            prefix=raw[:10],
            expires_at=utcnow() + timedelta(days=SESSION_DAYS) if kind == "session" else None,
        )
    )
    session.commit()
    return raw


def default_org(session: Session) -> Organization:
    org = session.scalar(select(Organization).where(Organization.is_default.is_(True)))
    if not org:
        org = Organization(name="Default organization", is_default=True, plan="enterprise")
        session.add(org)
        session.commit()
    return org


def bootstrap(session: Session) -> None:
    """Create the default organisation and promote configured superusers."""
    default_org(session)
    if settings.superuser_emails:
        for u in session.scalars(select(User).where(User.email.in_(settings.superuser_emails))):
            u.is_superuser = True
    session.commit()


def memberships(session: Session, user: User) -> list[dict]:
    rows = session.execute(
        select(Membership, Organization).join(Organization, Organization.id == Membership.org_id).where(Membership.user_id == user.id).order_by(Membership.id)
    ).all()
    return [{"org_id": o.id, "org_name": o.name, "role": m.role, "plan": o.plan} for m, o in rows]


@dataclass
class Principal:
    user: User | None
    org_id: int
    role: str
    via: str  # anonymous / session / api

    def can(self, role: str) -> bool:
        return ROLES.index(self.role) >= ROLES.index(role)

    @property
    def user_id(self) -> int | None:
        return self.user.id if self.user else None


def resolve(session: Session, authorization: str | None, org_header: str | None) -> Principal | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    tok = session.scalar(select(AuthToken).where(AuthToken.token_hash == sha256(authorization[7:].strip())))
    if not tok or (tok.expires_at and tok.expires_at < utcnow()):
        raise HTTPException(401, "invalid or expired token")
    user = session.get(User, tok.user_id)
    if not user:
        raise HTTPException(401, "invalid token")
    if not tok.last_used_at or (utcnow() - tok.last_used_at).total_seconds() > 300:
        tok.last_used_at = utcnow()
        session.commit()
    rows = session.scalars(select(Membership).where(Membership.user_id == user.id).order_by(Membership.id)).all()
    if not rows:
        raise HTTPException(403, "you are not a member of any organisation")
    chosen = rows[0]
    if org_header:
        match = [m for m in rows if str(m.org_id) == org_header.strip()]
        if not match:
            # Platform administrators may act inside any organisation (support access).
            wanted = org_header.strip()
            if user.is_superuser and wanted.isdigit() and session.get(Organization, int(wanted)):
                return Principal(user, int(wanted), "owner", tok.kind)
            raise HTTPException(403, "not a member of that organisation")
        chosen = match[0]
    return Principal(user, chosen.org_id, chosen.role, tok.kind)


def principal(
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
    x_org_id: str | None = Header(default=None),
) -> Principal:
    p = resolve(session, authorization, x_org_id)
    if p:
        if settings.require_email_verification and p.user and not p.user.email_verified_at and p.via == "session":
            raise HTTPException(403, "please verify your e-mail address first")
        return p
    if settings.auth_required:
        raise HTTPException(401, "sign in required")
    return Principal(None, default_org(session).id, "owner", "anonymous")


def require(role: str = "viewer"):
    def dep(p: Principal = Depends(principal)) -> Principal:
        if not p.can(role):
            raise HTTPException(403, f"requires the {role} role")
        return p

    return dep


def require_user(p: Principal = Depends(principal)) -> Principal:
    if not p.user:
        raise HTTPException(401, "sign in required")
    return p


def require_superuser(p: Principal = Depends(principal)) -> Principal:
    if not p.user or not p.user.is_superuser:
        raise HTTPException(403, "platform administrators only")
    return p
