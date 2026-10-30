from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ...auth import Principal, require
from ...config import settings
from ...db import get_session
from ...models import AuditLog, Organization
from ...plans import PLANS
from ...services import billing
from ..deps import client

router = APIRouter(prefix="/api/billing", tags=["organisation"])


class CheckoutIn(BaseModel):
    plan: str


@router.get("")
def billing_status(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    org = session.get(Organization, p.org_id)
    return {
        "enabled": billing.enabled(),
        "plan": org.plan,
        "has_customer": bool((org.settings or {}).get("stripe_customer_id")),
        "purchasable": [k for k in PLANS if billing.price_for(k)],
    }


@router.post("/checkout")
async def checkout(body: CheckoutIn, p: Principal = Depends(require("owner")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    if not billing.enabled():
        raise HTTPException(501, "billing is not enabled on this server; contact the administrator to change plans")
    org = session.get(Organization, p.org_id)
    try:
        url = await billing.checkout(
            http,
            org.id,
            body.plan,
            p.user.email if p.user else None,
            (org.settings or {}).get("stripe_customer_id"),
            f"{settings.app_url.rstrip('/')}/app/settings/organization?billing=success",
            f"{settings.app_url.rstrip('/')}/app/settings/organization?billing=cancelled",
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    return {"url": url}


@router.post("/portal")
async def portal(p: Principal = Depends(require("owner")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    org = session.get(Organization, p.org_id)
    customer = (org.settings or {}).get("stripe_customer_id")
    if not billing.enabled() or not customer:
        raise HTTPException(400, "no billing account yet; upgrade first")
    try:
        return {"url": await billing.portal(http, customer, f"{settings.app_url.rstrip('/')}/app/settings/organization")}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@router.post("/webhook", include_in_schema=False)
async def webhook(request: Request, session: Session = Depends(get_session)):
    payload = await request.body()
    if not settings.stripe_webhook_secret or not billing.verify_signature(payload, request.headers.get("stripe-signature", ""), settings.stripe_webhook_secret):
        raise HTTPException(400, "invalid signature")
    change = billing.plan_change(json.loads(payload))
    if change:
        org_id, plan, customer = change
        org = session.get(Organization, org_id)
        if org:
            if customer:
                org.settings = {**(org.settings or {}), "stripe_customer_id": customer}
            if plan and plan in PLANS:
                org.plan = plan
                session.add(AuditLog(org_id=org.id, action="billing.plan", target=plan))
            session.commit()
    return {"received": True}
