"""Stripe billing: Checkout for upgrades, the customer portal, and webhooks that set the plan."""

from __future__ import annotations

import hashlib
import hmac
import time

import httpx

from ..config import settings

API = "https://api.stripe.com/v1"


def enabled() -> bool:
    return bool(settings.stripe_secret_key)


def price_for(plan: str) -> str:
    return {"pro": settings.stripe_price_pro, "enterprise": settings.stripe_price_enterprise}.get(plan, "")


def plan_for_price(price_id: str) -> str | None:
    for plan in ("pro", "enterprise"):
        if price_id and price_for(plan) == price_id:
            return plan
    return None


async def _post(client: httpx.AsyncClient, path: str, data: dict) -> dict:
    r = await client.post(f"{API}{path}", data=data, auth=(settings.stripe_secret_key, ""))
    if r.status_code >= 400:
        raise RuntimeError(r.json().get("error", {}).get("message", r.text[:200]))
    return r.json()


async def checkout(client: httpx.AsyncClient, org_id: int, plan: str, email: str | None, customer: str | None, success_url: str, cancel_url: str) -> str:
    price = price_for(plan)
    if not price:
        raise ValueError(f"no Stripe price configured for plan '{plan}'")
    data = {
        "mode": "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": str(org_id),
        "metadata[org_id]": str(org_id),
        "subscription_data[metadata][org_id]": str(org_id),
        "allow_promotion_codes": "true",
    }
    if customer:
        data["customer"] = customer
    elif email:
        data["customer_email"] = email
    return (await _post(client, "/checkout/sessions", data))["url"]


async def portal(client: httpx.AsyncClient, customer: str, return_url: str) -> str:
    return (await _post(client, "/billing_portal/sessions", {"customer": customer, "return_url": return_url}))["url"]


def verify_signature(payload: bytes, header: str, secret: str, tolerance: int = 300, now: float | None = None) -> bool:
    """Stripe-Signature: t=<ts>,v1=<hex hmac of '<ts>.<payload>'>."""
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
    except (ValueError, KeyError):
        return False
    if abs((now or time.time()) - ts) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    sigs = [v for k, v in (p.split("=", 1) for p in header.split(",")) if k == "v1"]
    return any(hmac.compare_digest(expected, s) for s in sigs)


def plan_change(event: dict) -> tuple[int, str | None, str | None] | None:
    """(org_id, new_plan, customer_id) for the events that change a subscription, else None."""
    obj = event.get("data", {}).get("object", {})
    t = event.get("type", "")
    org = (obj.get("metadata") or {}).get("org_id") or obj.get("client_reference_id")
    if not org:
        return None
    if t == "checkout.session.completed":
        return int(org), None, obj.get("customer")  # plan is set by the subscription event that follows
    if t in ("customer.subscription.created", "customer.subscription.updated"):
        items = obj.get("items", {}).get("data", [])
        price = items[0]["price"]["id"] if items else ""
        active = obj.get("status") in ("active", "trialing", "past_due")
        return int(org), (plan_for_price(price) if active else "free"), obj.get("customer")
    if t == "customer.subscription.deleted":
        return int(org), "free", obj.get("customer")
    return None
