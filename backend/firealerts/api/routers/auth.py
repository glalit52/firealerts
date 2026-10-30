from __future__ import annotations

import os
import time
from collections import defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ... import auth, plans
from ...auth import Principal, issue_token, memberships, principal, require_user
from ...config import settings
from ...db import get_session, utcnow
from ...models import AuthToken, EmailToken, Invite, Membership, Organization, User
from ...security import hash_password, new_token, sha256, verify_password
from ...services import audit, email, i18n

router = APIRouter(prefix="/api", tags=["auth"])
DEV_LINKS = os.getenv("DEV_EXPOSE_EMAIL_LINKS", "").lower() in ("1", "true", "yes")

# ----------------------------------------------------------------------------- brute-force throttle
_failures: dict[str, list[float]] = defaultdict(list)
MAX_FAILURES, WINDOW_S = 5, 900


def _throttle(key: str) -> None:
    now = time.time()
    _failures[key] = [t for t in _failures[key] if now - t < WINDOW_S]
    if len(_failures[key]) >= MAX_FAILURES:
        raise HTTPException(429, "too many attempts; try again in 15 minutes")


def _email(v: str) -> str:
    v = v.strip().lower()
    if "@" not in v or v.startswith("@") or v.endswith("@") or " " in v:
        raise ValueError("invalid e-mail address")
    return v


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=200)
    name: str = Field(default="", max_length=120)
    org_name: str = Field(default="", max_length=120)
    invite_token: str = ""
    language: str | None = None

    @field_validator("email")
    @classmethod
    def _check_email(cls, v: str) -> str:
        return _email(v)


class LoginIn(BaseModel):
    email: str
    password: str


class EmailIn(BaseModel):
    email: str


class TokenIn(BaseModel):
    token: str


class ResetIn(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=200)


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    language: str | None = None

    @field_validator("language")
    @classmethod
    def _lang(cls, v):
        if v is not None and v not in i18n.LANGUAGES:
            raise ValueError(f"language must be one of {', '.join(i18n.LANGUAGES)}")
        return v


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


def _session_payload(session: Session, user: User) -> dict:
    return {"token": issue_token(session, user), "user": user.as_dict(), "memberships": memberships(session, user)}


async def _send_token_mail(session: Session, user: User, purpose: str, request: Request) -> dict:
    raw = new_token(nbytes=24)
    hours = 48 if purpose == "verify" else 2
    session.add(EmailToken(user_id=user.id, purpose=purpose, token_hash=sha256(raw), expires_at=utcnow() + timedelta(hours=hours)))
    session.commit()
    path = "verify-email" if purpose == "verify" else "reset-password"
    link = f"{settings.app_url.rstrip('/')}/{path}?token={raw}"
    lang = user.language
    sent = await email.send(
        user.email,
        i18n.t(lang, f"email.{purpose}.subject"),
        i18n.t(lang, f"email.{purpose}.body"),
        (i18n.t(lang, f"email.{purpose}.action"), link),
        request.app.state.client,
    )
    return {"emailed": sent, **({"dev_link": link} if DEV_LINKS else {})}


def _consume(session: Session, raw: str, purpose: str) -> User:
    tok = session.scalar(select(EmailToken).where(EmailToken.token_hash == sha256(raw), EmailToken.purpose == purpose))
    if not tok or tok.used_at or tok.expires_at < utcnow():
        raise HTTPException(400, "this link is invalid or has expired")
    tok.used_at = utcnow()
    user = session.get(User, tok.user_id)
    if not user:
        raise HTTPException(400, "account no longer exists")
    return user


def _accept_invite(session: Session, user: User, raw: str) -> Invite:
    inv = session.scalar(select(Invite).where(Invite.token_hash == sha256(raw), Invite.accepted_at.is_(None)))
    if not inv or (utcnow() - inv.created_at) > timedelta(days=14):
        raise HTTPException(400, "invite is invalid or has expired")
    if inv.email.lower() != user.email.lower():
        raise HTTPException(403, "this invite was sent to a different e-mail address")
    exists = session.scalar(select(Membership).where(Membership.user_id == user.id, Membership.org_id == inv.org_id))
    if not exists:
        org = session.get(Organization, inv.org_id)
        plans.check(session, org, "members")
        session.add(Membership(user_id=user.id, org_id=inv.org_id, role=inv.role))
    inv.accepted_at = utcnow()
    if not user.email_verified_at:
        user.email_verified_at = utcnow()  # the invite proved ownership of the address
    return inv


# ----------------------------------------------------------------------------- sign-up / sign-in


@router.post("/auth/register", status_code=201)
async def register(body: RegisterIn, request: Request, session: Session = Depends(get_session)):
    if not settings.registration_open and not body.invite_token:
        raise HTTPException(403, "registration is by invitation only")
    if session.scalar(select(User).where(func.lower(User.email) == body.email)):
        raise HTTPException(409, "an account with this e-mail already exists")
    user = User(email=body.email, name=body.name.strip(), password_hash=hash_password(body.password), is_superuser=body.email in settings.superuser_emails, language=i18n.norm(body.language) if body.language else None)
    session.add(user)
    session.flush()
    if body.invite_token:
        _accept_invite(session, user, body.invite_token)
    else:
        org = Organization(name=body.org_name.strip() or f"{body.name.strip() or body.email.split('@')[0]}'s organisation", plan=settings.default_plan, settings={"daily_digest": True, "language": i18n.norm(body.language)})
        session.add(org)
        session.flush()
        session.add(Membership(user_id=user.id, org_id=org.id, role="owner"))
    session.commit()
    verification = None
    if not user.email_verified_at:
        verification = await _send_token_mail(session, user, "verify", request)
    payload = _session_payload(session, user)
    return {**payload, "verification": verification}


@router.post("/auth/login")
def login(body: LoginIn, request: Request, session: Session = Depends(get_session)):
    key = f"{body.email.strip().lower()}|{request.client.host if request.client else ''}"
    _throttle(key)
    user = session.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if not user or not verify_password(body.password, user.password_hash):
        _failures[key].append(time.time())
        raise HTTPException(401, "wrong e-mail or password")
    _failures.pop(key, None)
    user.last_login_at = utcnow()
    session.commit()
    return _session_payload(session, user)


@router.post("/auth/logout", status_code=204)
def logout(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    if authorization and authorization.lower().startswith("bearer "):
        tok = session.scalar(select(AuthToken).where(AuthToken.token_hash == sha256(authorization[7:].strip()), AuthToken.kind == "session"))
        if tok:
            session.delete(tok)
            session.commit()


@router.post("/auth/verify-email")
def verify_email(body: TokenIn, session: Session = Depends(get_session)):
    user = _consume(session, body.token, "verify")
    user.email_verified_at = user.email_verified_at or utcnow()
    session.commit()
    return {"verified": True, "email": user.email}


@router.post("/auth/resend-verification")
async def resend_verification(request: Request, p: Principal = Depends(auth.unverified_user), session: Session = Depends(get_session)):
    user = session.get(User, p.user.id)
    if user.email_verified_at:
        return {"already_verified": True}
    _throttle(f"verify|{user.id}")
    _failures[f"verify|{user.id}"].append(time.time())
    return await _send_token_mail(session, user, "verify", request)


@router.post("/auth/forgot-password", status_code=202)
async def forgot_password(body: EmailIn, request: Request, session: Session = Depends(get_session)):
    """Always 202, so the endpoint does not reveal which e-mails have accounts."""
    key = f"reset|{body.email.strip().lower()}"
    _throttle(key)
    _failures[key].append(time.time())
    user = session.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if not user:
        return {"accepted": True}
    res = await _send_token_mail(session, user, "reset", request)
    return {"accepted": True, **({"dev_link": res["dev_link"]} if "dev_link" in res else {})}


@router.post("/auth/reset-password")
def reset_password(body: ResetIn, session: Session = Depends(get_session)):
    user = _consume(session, body.token, "reset")
    user.password_hash = hash_password(body.password)
    user.email_verified_at = user.email_verified_at or utcnow()
    session.execute(delete(AuthToken).where(AuthToken.user_id == user.id, AuthToken.kind == "session"))  # sign out everywhere
    session.commit()
    return _session_payload(session, user)


# ----------------------------------------------------------------------------- profile


@router.get("/me")
def me(session: Session = Depends(get_session), authorization: str | None = Header(default=None), x_org_id: str | None = Header(default=None)):
    """Never 401s for anonymous callers: clients use it to decide whether to show sign-in."""
    flags = {"auth_required": settings.auth_required, "registration_open": settings.registration_open, "require_email_verification": settings.require_email_verification}
    try:
        p = auth.resolve(session, authorization, x_org_id)
    except HTTPException:
        p = None
    if p is None:
        if settings.auth_required:
            return {**flags, "authenticated": False, "user": None, "memberships": [], "org": None, "role": None}
        p = Principal(None, auth.default_org(session).id, "owner", "anonymous")
    org = session.get(Organization, p.org_id)
    base = {**flags, "org": org.as_dict() | {"limits": plans.limits(org)}, "role": p.role}
    if not p.user:
        return {**base, "authenticated": False, "user": None, "memberships": []}
    return {**base, "authenticated": True, "user": p.user.as_dict(), "memberships": memberships(session, p.user), "via": p.via}


@router.patch("/me")
def update_me(body: ProfileIn, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    user = session.get(User, p.user.id)
    if body.name is not None:
        user.name = body.name.strip()
    if body.language is not None:
        user.language = body.language
    session.commit()
    return user.as_dict()


@router.post("/me/password")
def change_password(body: PasswordIn, authorization: str | None = Header(default=None), p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    user = session.get(User, p.user.id)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "current password is wrong")
    user.password_hash = hash_password(body.new_password)
    current = sha256(authorization[7:].strip()) if authorization else ""
    session.execute(delete(AuthToken).where(AuthToken.user_id == user.id, AuthToken.kind == "session", AuthToken.token_hash != current))
    session.commit()
    return {"changed": True}


@router.delete("/me", status_code=204)
def delete_me(p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    """Delete the account. Organisations where the user is the only owner must be handed over first."""
    for m in session.scalars(select(Membership).where(Membership.user_id == p.user.id)).all():
        if m.role == "owner":
            owners = session.scalar(select(func.count()).select_from(Membership).where(Membership.org_id == m.org_id, Membership.role == "owner"))
            members = session.scalar(select(func.count()).select_from(Membership).where(Membership.org_id == m.org_id))
            if owners <= 1 and members > 1:
                org = session.get(Organization, m.org_id)
                raise HTTPException(400, f"transfer ownership of '{org.name}' before deleting your account")
            if members == 1:
                session.delete(session.get(Organization, m.org_id))
    session.delete(session.get(User, p.user.id))
    session.commit()


# ----------------------------------------------------------------------------- invites (public side)


@router.get("/invites/{token}")
def invite_info(token: str, session: Session = Depends(get_session)):
    inv = session.scalar(select(Invite).where(Invite.token_hash == sha256(token), Invite.accepted_at.is_(None)))
    if not inv:
        raise HTTPException(404, "invite not found or already used")
    org = session.get(Organization, inv.org_id)
    return {"email": inv.email, "role": inv.role, "org_name": org.name}


@router.post("/invites/{token}/accept")
def accept_invite(token: str, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    inv = _accept_invite(session, session.get(User, p.user.id), token)
    session.commit()
    return {"org_id": inv.org_id, "role": inv.role}


# ----------------------------------------------------------------------------- API keys


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.get("/keys")
def list_keys(p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    keys = session.scalars(select(AuthToken).where(AuthToken.user_id == p.user.id, AuthToken.kind == "api").order_by(AuthToken.id)).all()
    return [
        {"id": k.id, "name": k.name, "prefix": k.prefix, "created_at": k.created_at.isoformat(), "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None}
        for k in keys
    ]


@router.post("/keys", status_code=201)
def create_key(body: KeyIn, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    plans.check(session, session.get(Organization, p.org_id), "api_keys", user_id=p.user.id)
    raw = issue_token(session, p.user, kind="api", name=body.name)
    audit.record(session, p, "api_key.create", body.name)
    session.commit()
    return {"name": body.name, "key": raw, "note": "Store this key now; it is not shown again."}


@router.delete("/keys/{key_id}", status_code=204)
def delete_key(key_id: int, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    k = session.get(AuthToken, key_id)
    if not k or k.user_id != p.user.id or k.kind != "api":
        raise HTTPException(404, "not found")
    session.delete(k)
    audit.record(session, p, "api_key.delete", k.name)
    session.commit()
