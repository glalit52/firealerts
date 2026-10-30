"""Web Push subscriptions for the installable web app."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...auth import Principal, require_user
from ...db import get_session, utcnow
from ...integrations import webpush
from ...models import PushSubscription
from ...security import sha256
from ...services import i18n
from ..deps import client

router = APIRouter(prefix="/api/push", tags=["auth"])


class Keys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=64)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: Keys
    user_agent: str = Field(default="", max_length=300)


class EndpointIn(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
def vapid_public_key():
    return {"enabled": True, "key": webpush.vapid_public_key()}


@router.get("/subscriptions")
def list_subscriptions(p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    return [s.as_dict() for s in session.scalars(select(PushSubscription).where(PushSubscription.user_id == p.user.id).order_by(PushSubscription.id))]


@router.post("/subscriptions", status_code=201)
def subscribe(body: SubscriptionIn, request: Request, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    if not body.endpoint.startswith("https://"):
        raise HTTPException(422, "push endpoint must be https")
    try:
        webpush.b64u_decode(body.keys.p256dh)
        webpush.b64u_decode(body.keys.auth)
    except Exception:
        raise HTTPException(422, "invalid subscription keys")
    h = sha256(body.endpoint)
    sub = session.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash == h))
    if sub:  # re-subscribing (possibly as another user on a shared device)
        sub.user_id, sub.p256dh, sub.auth = p.user.id, body.keys.p256dh, body.keys.auth
    else:
        sub = PushSubscription(user_id=p.user.id, endpoint=body.endpoint, endpoint_hash=h, p256dh=body.keys.p256dh, auth=body.keys.auth, user_agent=body.user_agent or request.headers.get("user-agent", "")[:300])
        session.add(sub)
    session.commit()
    return sub.as_dict()


@router.delete("/subscriptions", status_code=204)
def unsubscribe(body: EndpointIn, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    sub = session.scalar(select(PushSubscription).where(PushSubscription.endpoint_hash == sha256(body.endpoint), PushSubscription.user_id == p.user.id))
    if sub:
        session.delete(sub)
        session.commit()


@router.delete("/subscriptions/{sub_id}", status_code=204)
def remove(sub_id: int, p: Principal = Depends(require_user), session: Session = Depends(get_session)):
    sub = session.get(PushSubscription, sub_id)
    if not sub or sub.user_id != p.user.id:
        raise HTTPException(404, "not found")
    session.delete(sub)
    session.commit()


@router.post("/test")
async def test(p: Principal = Depends(require_user), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    subs = session.scalars(select(PushSubscription).where(PushSubscription.user_id == p.user.id)).all()
    if not subs:
        raise HTTPException(400, "no push subscription on any device yet")
    sent = failed = 0
    for s in subs:
        try:
            status = await webpush.send(http, s.endpoint, s.p256dh, s.auth, {"title": "Firealerts", "body": i18n.t(p.user.language, "push.test"), "url": "/app", "severity": "info", "tag": "test"})
        except Exception:
            status = 0
        if status in (404, 410):
            session.delete(s)
        if 200 <= status < 300:
            sent += 1
            s.last_used_at = utcnow()
        else:
            failed += 1
    session.commit()
    return {"sent": sent, "failed": failed}
