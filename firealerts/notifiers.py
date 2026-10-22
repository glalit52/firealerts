"""Alert delivery: webhook (JSON POST), Telegram and e-mail."""

from __future__ import annotations

import asyncio
import logging
import smtplib
from email.message import EmailMessage

import httpx

from .config import Settings

log = logging.getLogger(__name__)


def render_text(payload: dict) -> str:
    frp = f", max FRP {payload['max_frp']:.0f} MW" if payload.get("max_frp") else ""
    where = "inside" if payload["nearest_km"] == 0 else f"{payload['nearest_km']:.1f} km from"
    return (
        f"🔥 {payload['count']} new fire detection(s) {where} \"{payload['aoi_name']}\"{frp}.\n"
        f"Location: {payload['lat']:.4f}, {payload['lon']:.4f}\n"
        f"Sources: {', '.join(payload['sources'])}\n"
        f"Map: {payload['url']}"
    )


async def send_webhook(client: httpx.AsyncClient, url: str, payload: dict) -> None:
    resp = await client.post(url, json={"type": "fire_alert", "text": render_text(payload), **payload})
    resp.raise_for_status()


async def send_telegram(client: httpx.AsyncClient, token: str, chat_id: str, payload: dict) -> None:
    resp = await client.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": render_text(payload), "disable_web_page_preview": True},
    )
    resp.raise_for_status()


def _send_email_sync(cfg: Settings, to: str, payload: dict) -> None:
    msg = EmailMessage()
    msg["Subject"] = f"Fire alert: {payload['count']} detection(s) near {payload['aoi_name']}"
    msg["From"] = cfg.smtp_from
    msg["To"] = to
    msg.set_content(render_text(payload))
    with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30) as s:
        s.starttls()
        if cfg.smtp_user:
            s.login(cfg.smtp_user, cfg.smtp_password)
        s.send_message(msg)


async def deliver(client: httpx.AsyncClient, cfg: Settings, aoi, payload: dict) -> dict:
    """Send to every configured channel; returns {channel: "ok" | error}."""
    jobs: dict[str, object] = {}
    if aoi.webhook_url:
        jobs["webhook"] = send_webhook(client, aoi.webhook_url, payload)
    if cfg.alert_webhook_url:
        jobs["global_webhook"] = send_webhook(client, cfg.alert_webhook_url, payload)
    if aoi.telegram_chat_id and cfg.telegram_bot_token:
        jobs["telegram"] = send_telegram(client, cfg.telegram_bot_token, aoi.telegram_chat_id, payload)
    if aoi.email and cfg.smtp_host:
        jobs["email"] = asyncio.to_thread(_send_email_sync, cfg, aoi.email, payload)
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)
    status = {}
    for name, res in zip(jobs, results):
        if isinstance(res, Exception):
            log.warning("alert delivery via %s failed: %s", name, res)
            status[name] = f"error: {res}"
        else:
            status[name] = "ok"
    return status
