import hashlib
import hmac
import json
import time

from conftest import Recorder, bearer, register

from firealerts.config import settings
from firealerts.services import billing


def signed(payload: dict, secret="whsec_test", ts=None):
    body = json.dumps(payload).encode()
    ts = ts or int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return body, f"t={ts},v1={sig}"


def test_signature_verification():
    body, header = signed({"a": 1})
    assert billing.verify_signature(body, header, "whsec_test")
    assert not billing.verify_signature(body, header, "other")
    assert not billing.verify_signature(body + b"x", header, "whsec_test")
    old_body, old_header = signed({"a": 1}, ts=int(time.time()) - 3600)
    assert not billing.verify_signature(old_body, old_header, "whsec_test")
    assert not billing.verify_signature(body, "garbage", "whsec_test")


def test_checkout_disabled_without_stripe(client):
    t = register(client)
    assert client.get("/api/billing", headers=bearer(t["token"])).json()["enabled"] is False
    assert client.post("/api/billing/checkout", headers=bearer(t["token"]), json={"plan": "pro"}).status_code == 501


def test_checkout_and_webhook_set_plan(client):
    settings.stripe_secret_key, settings.stripe_webhook_secret, settings.stripe_price_pro = "sk_test", "whsec_test", "price_pro"
    try:
        t = register(client)
        h = bearer(t["token"])
        org_id = t["memberships"][0]["org_id"]
        rec = Recorder(body={"url": "https://checkout.stripe.com/c/pay/cs_1"})
        original = client.app.state.client
        client.app.state.client = rec.client()
        try:
            r = client.post("/api/billing/checkout", headers=h, json={"plan": "pro"})
        finally:
            client.app.state.client = original
        assert r.json()["url"].startswith("https://checkout.stripe.com/")
        form = rec.requests[0].content.decode()
        assert "price_pro" in form and f"client_reference_id={org_id}" in form

        body, sig = signed({"type": "checkout.session.completed", "data": {"object": {"client_reference_id": str(org_id), "customer": "cus_1"}}})
        assert client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig}).status_code == 200
        sub = {"type": "customer.subscription.updated", "data": {"object": {"metadata": {"org_id": str(org_id)}, "customer": "cus_1", "status": "active", "items": {"data": [{"price": {"id": "price_pro"}}]}}}}
        body, sig = signed(sub)
        client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig})
        assert client.get("/api/org", headers=h).json()["plan"] == "pro"
        assert client.get("/api/billing", headers=h).json()["has_customer"] is True
        body, sig = signed({"type": "customer.subscription.deleted", "data": {"object": {"metadata": {"org_id": str(org_id)}}}})
        client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig})
        assert client.get("/api/org", headers=h).json()["plan"] == "free"
        assert client.post("/api/billing/webhook", content=b"{}", headers={"stripe-signature": "t=1,v1=bad"}).status_code == 400
    finally:
        settings.stripe_secret_key = settings.stripe_webhook_secret = settings.stripe_price_pro = ""
