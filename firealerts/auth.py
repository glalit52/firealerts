"""Accounts, organisations, roles, sessions and API keys.

* Passwords: scrypt (stdlib) with a per-user salt.
* Tokens (sessions and API keys) are random 256-bit strings; only their SHA-256
  is stored, so a database leak does not leak usable credentials.
* Each request acts within one organisation (``X-Org-Id`` header, defaulting to
  the user's first membership). Roles: viewer < member < admin < owner.
* With ``AUTH_REQUIRED=false`` (self-hosted default) anonymous requests act as
  the owner of a built-in default organisation, so a single-user install needs
  no login at all.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .db import AreaOfInterest, AuthToken, Invite, Membership, Organization, SessionLocal, User, utcnow

ROLES = ["viewer", "member", "admin", "owner"]
SESSION_DAYS = 30
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


# ----------------------------------------------------------------------------- primitives


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt${n}${r}${p}${salt}${hash}".format(
        **_SCRYPT, salt=base64.b64encode(salt).decode(), hash=base64.b64encode(digest).decode()
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        calc = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(calc, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


def _sha(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def issue_token(session: Session, user: User, kind: str = "session", name: str = "") -> str:
    raw = ("fa_" if kind == "api" else "fs_") + secrets.token_urlsafe(32)
    session.add(
        AuthToken(
            token_hash=_sha(raw),
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
        org = Organization(name="Default organization", is_default=True)
        session.add(org)
        session.commit()
    return org


def bootstrap(session: Session) -> None:
    """Create the default organisation and adopt alert areas created before accounts existed."""
    org = default_org(session)
    for aoi in session.scalars(select(AreaOfInterest).where(AreaOfInterest.org_id.is_(None))):
        aoi.org_id = org.id
    session.commit()


# ----------------------------------------------------------------------------- request principal


@dataclass
class Principal:
    user: User | None
    org_id: int
    role: str
    via: str  # anonymous / session / api

    def can(self, role: str) -> bool:
        return ROLES.index(self.role) >= ROLES.index(role)


def get_session():
    with SessionLocal() as s:
        yield s


def _resolve(session: Session, authorization: str | None, org_header: str | None) -> Principal | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    tok = session.scalar(select(AuthToken).where(AuthToken.token_hash == _sha(authorization[7:].strip())))
    if not tok or (tok.expires_at and tok.expires_at < utcnow()):
        raise HTTPException(401, "invalid or expired token")
    user = session.get(User, tok.user_id)
    if not user:
        raise HTTPException(401, "invalid token")
    if not tok.last_used_at or (utcnow() - tok.last_used_at).total_seconds() > 300:
        tok.last_used_at = utcnow()
        session.commit()
    memberships = session.scalars(select(Membership).where(Membership.user_id == user.id).order_by(Membership.id)).all()
    if not memberships:
        raise HTTPException(403, "you are not a member of any organisation")
    chosen = memberships[0]
    if org_header:
        match = [m for m in memberships if str(m.org_id) == org_header.strip()]
        if not match:
            raise HTTPException(403, "not a member of that organisation")
        chosen = match[0]
    return Principal(user, chosen.org_id, chosen.role, tok.kind)


def principal(
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
    x_org_id: str | None = Header(default=None),
) -> Principal:
    p = _resolve(session, authorization, x_org_id)
    if p:
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


# ----------------------------------------------------------------------------- brute-force throttle

_failures: dict[str, list[float]] = defaultdict(list)
MAX_FAILURES, WINDOW_S = 5, 900


def _throttle(key: str) -> None:
    now = time.time()
    _failures[key] = [t for t in _failures[key] if now - t < WINDOW_S]
    if len(_failures[key]) >= MAX_FAILURES:
        raise HTTPException(429, "too many failed attempts; try again in 15 minutes")


# ----------------------------------------------------------------------------- API

router = APIRouter(prefix="/api")


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=200)
    name: str = Field(default="", max_length=120)
    org_name: str = Field(default="", max_length=120)
    invite_token: str = ""

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or v.startswith("@") or v.endswith("@"):
            raise ValueError("invalid e-mail address")
        return v


class LoginIn(BaseModel):
    email: str
    password: str


def _membership_view(session: Session, user: User) -> list[dict]:
    rows = session.execute(
        select(Membership, Organization).join(Organization, Organization.id == Membership.org_id).where(Membership.user_id == user.id).order_by(Membership.id)
    ).all()
    return [{"org_id": o.id, "org_name": o.name, "role": m.role} for m, o in rows]


def _accept_invite(session: Session, user: User, raw: str) -> Invite:
    inv = session.scalar(select(Invite).where(Invite.token_hash == _sha(raw), Invite.accepted_at.is_(None)))
    if not inv or (utcnow() - inv.created_at) > timedelta(days=14):
        raise HTTPException(400, "invite is invalid or has expired")
    if inv.email.lower() != user.email.lower():
        raise HTTPException(403, "this invite was sent to a different e-mail address")
    exists = session.scalar(select(Membership).where(Membership.user_id == user.id, Membership.org_id == inv.org_id))
    if not exists:
        session.add(Membership(user_id=user.id, org_id=inv.org_id, role=inv.role))
    inv.accepted_at = utcnow()
    return inv


@router.post("/auth/register", status_code=201)
def register(body: RegisterIn, session: Session = Depends(get_session)):
    if not settings.registration_open and not body.invite_token:
        raise HTTPException(403, "registration is by invitation only")
    if session.scalar(select(User).where(func.lower(User.email) == body.email)):
        raise HTTPException(409, "an account with this e-mail already exists")
    user = User(email=body.email, name=body.name.strip(), password_hash=hash_password(body.password))
    session.add(user)
    session.flush()
    if body.invite_token:
        _accept_invite(session, user, body.invite_token)
    else:
        org = Organization(name=body.org_name.strip() or f"{body.name.strip() or body.email.split('@')[0]}'s organisation")
        session.add(org)
        session.flush()
        session.add(Membership(user_id=user.id, org_id=org.id, role="owner"))
    session.commit()
    return {"token": issue_token(session, user), "user": user.as_dict(), "memberships": _membership_view(session, user)}


@router.post("/auth/login")
def login(body: LoginIn, request: Request, session: Session = Depends(get_session)):
    key = f"{body.email.strip().lower()}|{request.client.host if request.client else ''}"
    _throttle(key)
    user = session.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if not user or not verify_password(body.password, user.password_hash):
        _failures[key].append(time.time())
        raise HTTPException(401, "wrong e-mail or password")
    _failures.pop(key, None)
    return {"token": issue_token(session, user), "user": user.as_dict(), "memberships": _membership_view(session, user)}


@router.post("/auth/logout", status_code=204)
def logout(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    if authorization and authorization.lower().startswith("bearer "):
        tok = session.scalar(select(AuthToken).where(AuthToken.token_hash == _sha(authorization[7:].strip()), AuthToken.kind == "session"))
        if tok:
            session.delete(tok)
            session.commit()


@router.get("/me")
def me(
    session: Session = Depends(get_session),
    authorization: str | None = Header(default=None),
    x_org_id: str | None = Header(default=None),
):
    """Who am I? Never 401s for anonymous callers: the web app uses it to decide whether to show sign-in."""
    flags = {"auth_required": settings.auth_required, "registration_open": settings.registration_open}
    try:
        p = _resolve(session, authorization, x_org_id)
    except HTTPException:
        p = None
    if p is None:
        if settings.auth_required:
            return {**flags, "authenticated": False, "user": None, "memberships": [], "org": None, "role": None}
        p = Principal(None, default_org(session).id, "owner", "anonymous")
    org = session.get(Organization, p.org_id)
    base = {**flags, "org": {"id": org.id, "name": org.name}, "role": p.role}
    if not p.user:
        return {**base, "authenticated": False, "user": None, "memberships": []}
    return {**base, "authenticated": True, "user": p.user.as_dict(), "memberships": _membership_view(session, p.user), "via": p.via}


# --- organisations


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/orgs", status_code=201)
def create_org(body: OrgIn, p: Principal = Depends(principal), session: Session = Depends(get_session)):
    if not p.user:
        raise HTTPException(401, "sign in to create an organisation")
    org = Organization(name=body.name.strip())
    session.add(org)
    session.flush()
    session.add(Membership(user_id=p.user.id, org_id=org.id, role="owner"))
    session.commit()
    return {"id": org.id, "name": org.name, "role": "owner"}


@router.patch("/org")
def rename_org(body: OrgIn, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    org = session.get(Organization, p.org_id)
    org.name = body.name.strip()
    session.commit()
    return {"id": org.id, "name": org.name}


@router.get("/org/members")
def members(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    rows = session.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(Membership.org_id == p.org_id).order_by(Membership.id)).all()
    pending = session.scalars(select(Invite).where(Invite.org_id == p.org_id, Invite.accepted_at.is_(None))).all()
    return {
        "members": [{"user_id": u.id, "email": u.email, "name": u.name, "role": m.role} for m, u in rows],
        "pending_invites": [{"id": i.id, "email": i.email, "role": i.role, "created_at": i.created_at.isoformat()} for i in pending],
    }


class RoleIn(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def _role(cls, v):
        if v not in ROLES:
            raise ValueError(f"role must be one of {', '.join(ROLES)}")
        return v


def _owners(session: Session, org_id: int) -> int:
    return session.scalar(select(func.count()).where(Membership.org_id == org_id, Membership.role == "owner")) or 0


@router.patch("/org/members/{user_id}")
def change_role(user_id: int, body: RoleIn, p: Principal = Depends(require("owner")), session: Session = Depends(get_session)):
    m = session.scalar(select(Membership).where(Membership.org_id == p.org_id, Membership.user_id == user_id))
    if not m:
        raise HTTPException(404, "not a member")
    if m.role == "owner" and body.role != "owner" and _owners(session, p.org_id) <= 1:
        raise HTTPException(400, "an organisation needs at least one owner")
    m.role = body.role
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
    session.commit()


# --- invites


class InviteIn(BaseModel):
    email: str
    role: str = "member"

    @field_validator("role")
    @classmethod
    def _role(cls, v):
        if v not in ROLES:
            raise ValueError(f"role must be one of {', '.join(ROLES)}")
        return v


@router.post("/org/invites", status_code=201)
async def invite(body: InviteIn, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    if body.role == "owner" and not p.can("owner"):
        raise HTTPException(403, "only owners can invite owners")
    raw = secrets.token_urlsafe(24)
    inv = Invite(org_id=p.org_id, email=body.email.strip().lower(), role=body.role, token_hash=_sha(raw), invited_by=p.user.id if p.user else 0)
    session.add(inv)
    session.commit()
    org = session.get(Organization, p.org_id)
    url = f"{settings.public_url}/#invite={raw}"
    sent = False
    if settings.smtp_host:
        import asyncio

        from .notifiers import send_plain_email

        try:
            await asyncio.to_thread(send_plain_email, settings, inv.email, f"You're invited to {org.name} on Firealerts", f"Join {org.name} as {inv.role}:\n{url}\n\nThe link expires in 14 days.")
            sent = True
        except Exception:
            sent = False
    return {"id": inv.id, "email": inv.email, "role": inv.role, "invite_url": url, "emailed": sent}


@router.get("/invites/{token}")
def invite_info(token: str, session: Session = Depends(get_session)):
    inv = session.scalar(select(Invite).where(Invite.token_hash == _sha(token), Invite.accepted_at.is_(None)))
    if not inv:
        raise HTTPException(404, "invite not found or already used")
    org = session.get(Organization, inv.org_id)
    return {"email": inv.email, "role": inv.role, "org_name": org.name}


@router.post("/invites/{token}/accept")
def accept_invite(token: str, p: Principal = Depends(principal), session: Session = Depends(get_session)):
    if not p.user:
        raise HTTPException(401, "sign in or register to accept the invite")
    inv = _accept_invite(session, p.user, token)
    session.commit()
    return {"org_id": inv.org_id, "role": inv.role}


@router.delete("/org/invites/{invite_id}", status_code=204)
def revoke_invite(invite_id: int, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    inv = session.get(Invite, invite_id)
    if not inv or inv.org_id != p.org_id:
        raise HTTPException(404, "not found")
    session.delete(inv)
    session.commit()


# --- API keys


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.get("/keys")
def list_keys(p: Principal = Depends(principal), session: Session = Depends(get_session)):
    if not p.user:
        raise HTTPException(401, "sign in to manage API keys")
    keys = session.scalars(select(AuthToken).where(AuthToken.user_id == p.user.id, AuthToken.kind == "api").order_by(AuthToken.id)).all()
    return [
        {"id": k.id, "name": k.name, "prefix": k.prefix, "created_at": k.created_at.isoformat(), "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None}
        for k in keys
    ]


@router.post("/keys", status_code=201)
def create_key(body: KeyIn, p: Principal = Depends(principal), session: Session = Depends(get_session)):
    if not p.user:
        raise HTTPException(401, "sign in to manage API keys")
    return {"name": body.name, "key": issue_token(session, p.user, kind="api", name=body.name), "note": "Store this key now; it is not shown again."}


@router.delete("/keys/{key_id}", status_code=204)
def delete_key(key_id: int, p: Principal = Depends(principal), session: Session = Depends(get_session)):
    k = session.get(AuthToken, key_id)
    if not p.user or not k or k.user_id != p.user.id or k.kind != "api":
        raise HTTPException(404, "not found")
    session.delete(k)
    session.commit()
