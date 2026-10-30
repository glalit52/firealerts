"""Background jobs: ingestion, alerting, asset risk and vegetation monitoring, digests.

Run as its own process in production:  python -m firealerts.worker
(or inside the API process with SCHEDULER_ENABLED=true for single-container installs).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import timedelta

import httpx
from sqlalchemy import delete, select

from . import __version__, auth, ingest
from .config import settings
from .db import SessionLocal, init_db, utcnow
from .models import Alert, Asset, AuthToken, EmailToken, Membership, Organization, User
from .services import alerting, email, i18n, intel, static_sources

log = logging.getLogger("firealerts.worker")


@dataclass
class Job:
    name: str
    every_s: float
    fn: object
    last: float = 0.0
    running: bool = False


async def job_ingest(client):
    with SessionLocal() as s:
        rec = await ingest.run(s, client, settings)
    with SessionLocal() as s:
        await alerting.check_threats(s, client)
    return f"inserted={rec.inserted} alerts={rec.alerts}"


async def job_threats(client):
    with SessionLocal() as s:
        return f"threat alerts={await alerting.check_threats(s, client)}"


async def job_risk(client):
    n = 0
    with SessionLocal() as s:
        for asset in s.scalars(select(Asset).where(Asset.active.is_(True))).all():
            try:
                await intel.compute_risk(s, client, asset)
                n += 1
            except Exception as exc:
                s.rollback()
                log.warning("risk for asset %s failed: %s", asset.id, exc)
    return f"assets={n}"


async def job_vegetation(client):
    n = 0
    with SessionLocal() as s:
        for asset in s.scalars(select(Asset).where(Asset.active.is_(True))).all():
            try:
                r = await intel.refresh_vegetation(s, client, asset, days=30, max_new=3)
                n += r["analysed"]
            except Exception as exc:
                s.rollback()
                log.warning("vegetation for asset %s failed: %s", asset.id, exc)
    return f"scenes analysed={n}"


async def job_digest(client):
    """Daily e-mail summary of open alerts per organisation (when e-mail is configured)."""
    if not email.configured():
        return "skipped (no e-mail transport)"
    sent = 0
    since = utcnow() - timedelta(days=1)
    with SessionLocal() as s:
        for org in s.scalars(select(Organization)).all():
            if not (org.settings or {}).get("daily_digest", True):
                continue
            alerts = s.scalars(select(Alert).where(Alert.org_id == org.id, Alert.created_at >= since).order_by(Alert.created_at.desc())).all()
            if not alerts:
                continue
            to = [r[0] for r in s.execute(select(User.email).join(Membership, Membership.user_id == User.id).where(Membership.org_id == org.id, Membership.role.in_(["admin", "owner"]))).all()]
            lines = [f"- [{a.severity}] {a.title} ({a.status})" for a in alerts[:30]]
            lang = (org.settings or {}).get("language")
            await email.send(to, i18n.t(lang, "email.digest.subject", n=len(alerts), org=org.name), "\n".join(lines), (i18n.t(lang, "email.digest.action"), f"{settings.app_url}/app/alerts"), client)
            sent += 1
    return f"digests={sent}"


async def job_static_sources(client):
    with SessionLocal() as s:
        return f"persistent sources={static_sources.learn(s)}"


async def job_cleanup(client):
    with SessionLocal() as s:
        now = utcnow()
        s.execute(delete(AuthToken).where(AuthToken.expires_at.is_not(None), AuthToken.expires_at < now))
        s.execute(delete(EmailToken).where(EmailToken.expires_at < now - timedelta(days=7)))
        s.commit()
    return "ok"


def jobs() -> list[Job]:
    return [
        Job("ingest", settings.poll_minutes * 60, job_ingest),
        Job("threats", settings.threat_check_minutes * 60, job_threats),
        Job("risk", settings.risk_job_hours * 3600, job_risk),
        Job("vegetation", settings.vegetation_job_hours * 3600, job_vegetation),
        Job("digest", 24 * 3600, job_digest),
        Job("static_sources", 24 * 3600, job_static_sources),
        Job("cleanup", 6 * 3600, job_cleanup),
    ]


async def run_forever(client: httpx.AsyncClient | None = None, stop: asyncio.Event | None = None) -> None:
    own = client is None
    client = client or httpx.AsyncClient(timeout=settings.http_timeout, follow_redirects=True, headers={"User-Agent": f"firealerts/{__version__}"})
    stop = stop or asyncio.Event()
    schedule = jobs()
    # Stagger the first runs: ingest immediately, the heavier jobs shortly after.
    for i, j in enumerate(schedule):
        j.last = time.monotonic() - j.every_s + (0 if j.name == "ingest" else 60 + 30 * i)
    try:
        while not stop.is_set():
            now = time.monotonic()
            for j in schedule:
                if not j.running and now - j.last >= j.every_s:
                    j.running = True
                    j.last = now
                    t0 = time.monotonic()
                    try:
                        msg = await j.fn(client)
                        log.info("job %s done in %.1fs: %s", j.name, time.monotonic() - t0, msg)
                    except Exception:
                        log.exception("job %s failed", j.name)
                    finally:
                        j.running = False
            try:
                await asyncio.wait_for(stop.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
    finally:
        if own:
            await client.aclose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    with SessionLocal() as s:
        auth.bootstrap(s)
    log.info("worker started (mode=%s)", settings.data_mode)
    asyncio.run(run_forever())


if __name__ == "__main__":
    main()
