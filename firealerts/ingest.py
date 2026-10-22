"""Ingestion pipeline: fetch → normalise → de-duplicate → store → alert."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import alerts
from .config import Settings
from .db import Detection, IngestRun, utcnow
from .geo import bbox_contains
from .sources import demo, firms, goes, himawari, meteosat, static_sources

log = logging.getLogger(__name__)


async def _fetch_live(client: httpx.AsyncClient, cfg: Settings) -> tuple[list[dict], dict, list[str]]:
    jobs: dict[str, object] = {s: firms.fetch(client, cfg, s) for s in cfg.firms_sources}
    if cfg.goes_enabled:
        for sat in cfg.goes_satellites:
            jobs[sat.upper()] = goes.fetch(client, sat)
    if cfg.jaxa_ftp_user:
        jobs["HIMAWARI9"] = himawari.fetch(cfg.jaxa_ftp_user, cfg.jaxa_ftp_password, cfg.himawari_dir)
    if cfg.lsasaf_user:
        jobs["METEOSAT"] = meteosat.fetch(client, cfg.lsasaf_user, cfg.lsasaf_password, cfg.lsasaf_url)
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)
    rows: list[dict] = []
    per_source: dict[str, int] = {}
    errors: list[str] = []
    for name, res in zip(jobs, results):
        if isinstance(res, Exception):
            errors.append(f"{name}: {type(res).__name__}: {res}"[:300])
            per_source[name] = 0
            continue
        per_source[name] = len(res)
        rows.extend(res)
    return rows, per_source, errors


async def run(session: Session, client: httpx.AsyncClient, cfg: Settings) -> IngestRun:
    run_rec = IngestRun(mode=cfg.data_mode, started_at=utcnow())
    rows: list[dict] = []
    per_source: dict[str, int] = {}
    errors: list[str] = []
    mode_used = cfg.data_mode
    if cfg.data_mode in ("live", "auto"):
        rows, per_source, errors = await _fetch_live(client, cfg)
        if cfg.data_mode == "auto" and not rows and errors:
            mode_used = "demo"
        elif cfg.data_mode == "auto":
            mode_used = "live"
    if mode_used == "demo":
        rows = demo.generate()
        per_source = {}
        for r in rows:
            per_source[r["source"]] = per_source.get(r["source"], 0) + 1

    if cfg.bbox:
        rows = [r for r in rows if bbox_contains(cfg.bbox, r["lon"], r["lat"])]

    unique = {r["id"]: r for r in rows}
    existing: set[str] = set()
    ids = list(unique)
    for i in range(0, len(ids), 900):
        existing.update(session.scalars(select(Detection.id).where(Detection.id.in_(ids[i : i + 900]))))
    new = [Detection(**r) for k, r in unique.items() if k not in existing]
    session.add_all(new)
    cutoff = utcnow() - timedelta(hours=cfg.retention_hours)
    session.execute(delete(Detection).where(Detection.acq_time < cutoff))
    if cfg.static_sources_enabled:
        static_sources.record(session, new, cfg.static_learn_days)
    session.commit()

    fresh_cutoff = utcnow() - timedelta(hours=6)  # do not alert on stale backfill
    try:
        n_alerts = await alerts.process(session, client, cfg, [d for d in new if d.acq_time >= fresh_cutoff])
    except Exception as exc:
        log.exception("alert processing failed")
        errors.append(f"alerts: {exc}")
        n_alerts = 0

    run_rec.mode = mode_used
    run_rec.fetched = len(rows)
    run_rec.inserted = len(new)
    run_rec.alerts = n_alerts
    run_rec.per_source = per_source
    run_rec.errors = errors
    run_rec.finished_at = utcnow()
    session.add(run_rec)
    session.commit()
    log.info("ingest[%s]: fetched=%d new=%d alerts=%d errors=%d", mode_used, len(rows), len(new), n_alerts, len(errors))
    return run_rec
