import asyncio
import json
from urllib.parse import parse_qs

import pytest
from conftest import Recorder

from firealerts.integrations import notify, registry

MSG = notify.Message(title="Fire inside Pine Ridge", text="3 detections", severity="high", type="detection", url="https://app.example.com/app/alerts/7", lat=-31.3, lon=-64.5, alert_id=7, asset_name="Pine Ridge", data={"count": 3})


def send(kind, cfg):
    rec = Recorder()
    asyncio.run(notify.CHANNELS[kind](rec.client(), cfg, MSG))
    return rec.requests


def test_slack_payload():
    (r,) = send("slack", {"webhook_url": "https://hooks.slack.com/services/T/B/X"})
    body = json.loads(r.content)
    assert str(r.url).startswith("https://hooks.slack.com/") and body["blocks"][0]["type"] == "header"
    assert any(b["type"] == "actions" for b in body["blocks"])


def test_teams_adaptive_card():
    (r,) = send("teams", {"webhook_url": "https://example.webhook.office.com/x"})
    card = json.loads(r.content)["attachments"][0]
    assert card["contentType"] == "application/vnd.microsoft.card.adaptive" and card["content"]["actions"][0]["url"] == MSG.url


def test_discord_embed_color():
    (r,) = send("discord", {"webhook_url": "https://discord.com/api/webhooks/1/x"})
    emb = json.loads(r.content)["embeds"][0]
    assert emb["color"] == int("ff9a3c", 16) and emb["title"] == MSG.title


def test_telegram_uses_bot_token():
    (r,) = send("telegram", {"chat_id": "123", "bot_token": "999:abc"})
    assert "/bot999:abc/sendMessage" in str(r.url) and json.loads(r.content)["chat_id"] == "123"


def test_twilio_sms_and_whatsapp():
    cfg = {"account_sid": "AC1", "auth_token": "tok", "from_number": "+1555", "to": ["+5491", "+5492"]}
    reqs = send("twilio_sms", cfg)
    assert len(reqs) == 2 and "/Accounts/AC1/Messages.json" in str(reqs[0].url)
    form = parse_qs(reqs[0].content.decode())
    assert form["To"] == ["+5491"] and reqs[0].headers["authorization"].startswith("Basic ")
    wa = send("twilio_whatsapp", cfg)
    assert parse_qs(wa[0].content.decode())["From"] == ["whatsapp:+1555"]


def test_pagerduty_event():
    (r,) = send("pagerduty", {"routing_key": "R123"})
    ev = json.loads(r.content)
    assert ev["routing_key"] == "R123" and ev["dedup_key"] == "firealerts-7" and ev["payload"]["severity"] == "error"


def test_webhook_without_secret_has_no_signature():
    (r,) = send("webhook", {"url": "https://example.com/hook"})
    assert "X-Firealerts-Signature" not in r.headers and json.loads(r.content)["alert"]["title"] == MSG.title


def test_email_channel_needs_transport():
    with pytest.raises(RuntimeError):
        asyncio.run(notify.email_channel(Recorder().client(), {"recipients": ["a@example.com"]}, MSG))
    with pytest.raises(ValueError):
        asyncio.run(notify.email_channel(Recorder().client(), {"recipients": []}, MSG))


def test_email_channel_via_sendgrid():
    rec = Recorder(status=202)
    asyncio.run(notify.email_channel(rec.client(), {"recipients": ["a@example.com"], "to_members": True, "sendgrid_api_key": "SG.x"}, notify.Message(**{**MSG.__dict__, "recipients": ["b@example.com"]})))
    body = json.loads(rec.requests[0].content)
    assert rec.requests[0].headers["authorization"] == "Bearer SG.x"
    assert sorted(t["email"] for t in body["personalizations"][0]["to"]) == ["a@example.com", "b@example.com"]


def test_registry_validate_redact_merge():
    cfg = registry.validate("twilio_sms", {"account_sid": "AC1", "auth_token": "t", "from_number": "+1", "to": "+2, +3\n+4"})
    assert cfg["to"] == ["+2", "+3", "+4"]
    with pytest.raises(ValueError):
        registry.validate("slack", {})
    with pytest.raises(ValueError):
        registry.validate("webhook", {"url": "ftp://x"})
    with pytest.raises(ValueError):
        registry.validate("gee", {"service_account_json": '{"client_email": "x"}'})
    with pytest.raises(ValueError):
        registry.validate("nope", {})
    red = registry.redact("webhook", {"url": "https://x", "secret": "s"})
    assert red == {"url": "https://x", "secret": "••••••"}
    merged = registry.merge_update("webhook", {"url": "https://x", "secret": "s"}, {"url": "https://y", "secret": "••••••"})
    assert merged == {"url": "https://y", "secret": "s"}
    assert all(t["category"] in ("notification", "data") for t in registry.CONNECTOR_TYPES.values())
    assert set(notify.CHANNELS) <= set(registry.CONNECTOR_TYPES)
