"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .. import __version__, auth, worker
from ..config import settings
from ..db import SessionLocal, init_db
from ..security import insecure_secret_key
from .routers import admin, alerts, assets, auth as auth_routes, billing, connectors, data, firedata, orgs, public, push, system

log = logging.getLogger("firealerts")

TAGS = [
    {"name": "system", "description": "Health, metadata, data sources and ingestion"},
    {"name": "auth", "description": "Sign-up, sign-in, e-mail verification, password reset, profile, API keys"},
    {"name": "organisation", "description": "Organisation settings, plan usage, members, invites, audit log"},
    {"name": "assets", "description": "Monitored forests and other assets: geometry, import, risk, vegetation, history, exposure"},
    {"name": "alerts", "description": "Alert inbox and lifecycle"},
    {"name": "integrations", "description": "Connectors (notification channels and data sources) and notification rules"},
    {"name": "public", "description": "Read-only public fire map (no account)"},
    {"name": "fire data", "description": "Detections, incidents, spread forecasts, fire danger and ignition risk"},
    {"name": "data", "description": "Exports"},
    {"name": "admin", "description": "Platform administration (superusers)"},
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    with SessionLocal() as s:
        auth.bootstrap(s)
    if settings.auth_required and insecure_secret_key():
        log.warning("SECRET_KEY is not set: connector secrets are encrypted with a development key. Set SECRET_KEY in production.")
    app.state.client = httpx.AsyncClient(timeout=settings.http_timeout, follow_redirects=True, headers={"User-Agent": f"firealerts/{__version__}"})
    stop = asyncio.Event()
    task = asyncio.create_task(worker.run_forever(app.state.client, stop)) if settings.scheduler_enabled else None
    yield
    stop.set()
    if task:
        task.cancel()
    await app.state.client.aclose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Firealerts API",
        version=__version__,
        description="Satellite wildfire detection, forecasting and alerting. Authenticate with `Authorization: Bearer <token or API key>`; select an organisation with `X-Org-Id`.",
        lifespan=lifespan,
        openapi_tags=TAGS,
    )
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for r in (system, public, auth_routes, push, orgs, billing, assets, alerts, connectors, firedata, data, admin):
        app.include_router(r.router)
    return app
