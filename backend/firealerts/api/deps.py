from __future__ import annotations

import httpx
from fastapi import HTTPException, Request

from ..db import get_session  # noqa: F401  (re-exported for routers)


def client(request: Request) -> httpx.AsyncClient:
    return request.app.state.client


def parse_bbox(bbox: str | None) -> tuple[float, float, float, float] | None:
    if not bbox:
        return None
    try:
        w, s, e, n = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be 'west,south,east,north'")
    if not (-180 <= w <= 180 and -180 <= e <= 180 and -90 <= s <= n <= 90):
        raise HTTPException(400, "bbox out of range")
    return w, s, e, n


def client_ip(request: Request) -> str:
    """Caller address for rate limits. The bundled nginx overwrites X-Real-IP with the
    real client (after resolving trusted proxies), so it cannot be spoofed through it."""
    return request.headers.get("x-real-ip", "").strip() or (request.client.host if request.client else "?")
