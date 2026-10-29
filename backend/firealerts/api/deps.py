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
