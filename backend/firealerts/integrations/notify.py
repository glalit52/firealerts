"""Notification channels. Each takes the decrypted connector config and a Message."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field

import httpx

from ..config import settings
from ..security import sign
from ..services import email

SEVERITY_COLORS = {"info": "#5aa9ff", "low": "#3ecf8e", "moderate": "#ffd84d", "high": "#ff9a3c", "critical": "#ff4d5e"}
SEVERITY_EMOJI = {"info": "ℹ️", "low": "🟢", "moderate": "🟡", "high": "🟠", "critical": "🔴"}


@dataclass
class Message:
    title: str
    text: str
    severity: str = "moderate"
    type: str = "detection"
    url: str = ""
    lat: float | None = None
    lon: float | None = None
    alert_id: int | None = None
    asset_name: str = ""
    org_name: str = ""
    data: dict = field(default_factory=dict)
    recipients: list[str] = field(default_factory=list)  # resolved member e-mails for the email channel

    def short(self, limit: int = 300) -> str:
        loc = f" {self.lat:.4f},{self.lon:.4f}" if self.lat is not None else ""
        s = f"{SEVERITY_EMOJI.get(self.severity, '')} {self.title}.{loc} {self.url}".strip()
        return s[:limit]


async def email_channel(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    to = [e.strip() for e in cfg.get("recipients", []) if e.strip()]
    if cfg.get("to_members"):
        to += msg.recipients
    to = sorted(set(to))
    if not to:
        raise ValueError("no recipients")
    sent = await email.send(to, f"[{msg.severity.upper()}] {msg.title}", msg.text, ("Open in Firealerts", msg.url) if msg.url else None, client, cfg.get("sendgrid_api_key", ""))
    if not sent:
        raise RuntimeError("no e-mail transport configured (set SMTP_HOST or SENDGRID_API_KEY, or add a SendGrid key to this connector)")


async def slack(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"{SEVERITY_EMOJI.get(msg.severity, '')} {msg.title}"[:150]}},
        {"type": "section", "text": {"type": "mrkdwn", "text": msg.text[:2900]}},
    ]
    if msg.url:
        blocks.append({"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Open in Firealerts"}, "url": msg.url}]})
    r = await client.post(cfg["webhook_url"], json={"text": msg.short(), "blocks": blocks, "attachments": [{"color": SEVERITY_COLORS.get(msg.severity)}]})
    r.raise_for_status()


async def teams(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    card = {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": [
                        {"type": "TextBlock", "size": "Large", "weight": "Bolder", "text": msg.title, "wrap": True},
                        {"type": "TextBlock", "text": msg.text, "wrap": True},
                        {"type": "FactSet", "facts": [{"title": "Severity", "value": msg.severity}, {"title": "Type", "value": msg.type}, {"title": "Asset", "value": msg.asset_name or "–"}]},
                    ],
                    "actions": [{"type": "Action.OpenUrl", "title": "Open in Firealerts", "url": msg.url}] if msg.url else [],
                },
            }
        ],
    }
    r = await client.post(cfg["webhook_url"], json=card)
    r.raise_for_status()


async def discord(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    color = int(SEVERITY_COLORS.get(msg.severity, "#ff6a2b")[1:], 16)
    r = await client.post(cfg["webhook_url"], json={"username": "Firealerts", "embeds": [{"title": msg.title[:250], "description": msg.text[:4000], "url": msg.url or None, "color": color}]})
    r.raise_for_status()


async def telegram(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    token = cfg.get("bot_token") or settings.telegram_bot_token
    if not token:
        raise ValueError("no Telegram bot token")
    text = f"{SEVERITY_EMOJI.get(msg.severity, '')} *{msg.title}*\n{msg.text}\n{msg.url}"
    r = await client.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": cfg["chat_id"], "text": text[:4000], "parse_mode": "Markdown", "disable_web_page_preview": True})
    r.raise_for_status()


async def _twilio(client: httpx.AsyncClient, cfg: dict, body: str, whatsapp: bool) -> None:
    prefix = "whatsapp:" if whatsapp else ""
    for to in cfg.get("to", []):
        to = to.strip()
        if not to:
            continue
        r = await client.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{cfg['account_sid']}/Messages.json",
            data={"From": prefix + cfg["from_number"], "To": prefix + to, "Body": body},
            auth=(cfg["account_sid"], cfg["auth_token"]),
        )
        r.raise_for_status()


async def twilio_sms(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    await _twilio(client, cfg, msg.short(320), False)


async def twilio_whatsapp(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    await _twilio(client, cfg, f"{msg.short(600)}\n{msg.text[:900]}", True)


async def pagerduty(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    sev = {"info": "info", "low": "info", "moderate": "warning", "high": "error", "critical": "critical"}.get(msg.severity, "warning")
    r = await client.post(
        "https://events.pagerduty.com/v2/enqueue",
        json={
            "routing_key": cfg["routing_key"],
            "event_action": "trigger",
            "dedup_key": f"firealerts-{msg.alert_id}" if msg.alert_id else None,
            "payload": {"summary": msg.title[:1000], "source": "firealerts", "severity": sev, "component": msg.asset_name or None, "custom_details": {"text": msg.text, "url": msg.url, **msg.data}},
            "links": [{"href": msg.url, "text": "Open in Firealerts"}] if msg.url else [],
        },
    )
    r.raise_for_status()


async def webhook(client: httpx.AsyncClient, cfg: dict, msg: Message) -> None:
    body = json.dumps({"event": "alert", "sent_at": int(time.time()), "alert": asdict(msg) | {"recipients": None}}, default=str).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "Firealerts-Webhook/1"}
    if cfg.get("secret"):
        ts = str(int(time.time()))
        headers["X-Firealerts-Timestamp"] = ts
        headers["X-Firealerts-Signature"] = sign(cfg["secret"], ts.encode() + b"." + body)
    r = await client.post(cfg["url"], content=body, headers=headers)
    r.raise_for_status()


CHANNELS = {
    "email": email_channel,
    "slack": slack,
    "teams": teams,
    "discord": discord,
    "telegram": telegram,
    "twilio_sms": twilio_sms,
    "twilio_whatsapp": twilio_whatsapp,
    "pagerduty": pagerduty,
    "webhook": webhook,
}
