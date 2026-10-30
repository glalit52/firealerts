"""Transactional e-mail: SMTP or SendGrid, with plain-text and HTML bodies."""

from __future__ import annotations

import asyncio
import html
import logging
import smtplib
from email.message import EmailMessage

import httpx

from ..config import settings

log = logging.getLogger(__name__)


def configured() -> bool:
    return bool(settings.smtp_host or settings.sendgrid_api_key)


def _html(title: str, body: str, action: tuple[str, str] | None = None) -> str:
    button = ""
    if action:
        label, url = action
        button = f'<p style="margin:28px 0"><a href="{html.escape(url)}" style="background:#f2551b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">{html.escape(label)}</a></p>'
    paras = "".join(f"<p>{html.escape(p)}</p>" for p in body.split("\n\n"))
    return f"""<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1b1f27">
<div style="font-size:20px;font-weight:700;margin:24px 0">🔥 Firealerts</div><h2 style="font-size:18px">{html.escape(title)}</h2>{paras}{button}
<p style="color:#8b93a7;font-size:12px;margin-top:36px">You receive this because of your Firealerts account. Manage notifications in Settings → Integrations.</p></div>"""


def _send_smtp(to: list[str], subject: str, text: str, html_body: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from
    msg["To"] = ", ".join(to)
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as s:
        try:
            s.starttls()
        except smtplib.SMTPNotSupportedError:
            pass
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)


async def _send_sendgrid(client: httpx.AsyncClient, api_key: str, to: list[str], subject: str, text: str, html_body: str) -> None:
    resp = await client.post(
        "https://api.sendgrid.com/v3/mail/send",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "personalizations": [{"to": [{"email": t} for t in to]}],
            "from": {"email": settings.smtp_from},
            "subject": subject,
            "content": [{"type": "text/plain", "value": text}, {"type": "text/html", "value": html_body}],
        },
    )
    resp.raise_for_status()


async def send(
    to: list[str] | str,
    subject: str,
    text: str,
    action: tuple[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
    sendgrid_key: str = "",
) -> bool:
    """Send an e-mail; returns False (and logs) when no transport is configured."""
    to = [to] if isinstance(to, str) else [t for t in to if t]
    if not to:
        return False
    body = text + (f"\n\n{action[0]}: {action[1]}" if action else "")
    html_body = _html(subject, text, action)
    key = sendgrid_key or settings.sendgrid_api_key
    if key:
        own = client is None
        client = client or httpx.AsyncClient(timeout=30)
        try:
            await _send_sendgrid(client, key, to, subject, body, html_body)
        finally:
            if own:
                await client.aclose()
        return True
    if settings.smtp_host:
        await asyncio.to_thread(_send_smtp, to, subject, body, html_body)
        return True
    log.info("e-mail not configured; would send %r to %s: %s", subject, to, body)
    return False
