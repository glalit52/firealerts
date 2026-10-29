"""Himawari-9 AHI wildfire product (JAXA P-Tree "WLF" Level 2, every 10 minutes).

Covers East Asia, South-East Asia and Oceania. JAXA distributes the product as CSV
over FTP to registered users (free: https://www.eorc.jaxa.jp/ptree/registration_top.html).
Column names have varied between product versions, so the parser locates fields by
header name rather than position.
"""

from __future__ import annotations

import asyncio
import csv
import ftplib
import io
import logging
import re
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

HOST = "ftp.ptree.jaxa.jp"
DEFAULT_DIR = "/pub/himawari/L2/WLF/010/{yyyymm}/{dd}/{hh}/"
_TIME_RE = re.compile(r"(\d{8})_(\d{4})")

_ALIASES = {
    "lat": ("lat", "latitude"),
    "lon": ("lon", "lng", "longitude"),
    "frp": ("frp", "fire radiative power", "frp(mw)", "frp_mw"),
    "reliability": ("reliability", "confidence", "level"),
    "area": ("area", "fire area"),
    "temp": ("temp", "fire temperature", "brightness"),
}


def _column(header: list[str], key: str) -> int | None:
    names = [h.strip().lower() for h in header]
    for alias in _ALIASES[key]:
        if alias in names:
            return names.index(alias)
    return None


def _confidence(raw: str) -> str:
    raw = (raw or "").strip().lower()
    try:
        v = float(raw)
    except ValueError:
        return {"high": "h", "low": "l"}.get(raw, "n")
    if v <= 1:  # probability 0-1
        v *= 100
    if v <= 5:  # JAXA reliability/level classes 1 (low) .. 5 (high)
        return "l" if v <= 1 else ("h" if v >= 4 else "n")
    return "l" if v < 30 else ("h" if v >= 80 else "n")


def scan_time(name: str) -> datetime | None:
    m = _TIME_RE.search(name)
    if not m:
        return None
    return datetime.strptime("".join(m.groups()), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def parse_csv(text: str, filename: str) -> list[dict]:
    t = scan_time(filename) or datetime.now(timezone.utc)
    rows = list(csv.reader(io.StringIO(text)))
    # Skip any preamble: the header is the first row that names lat and lon columns.
    start = next((i for i, r in enumerate(rows) if _column(r, "lat") is not None and _column(r, "lon") is not None), None)
    if start is None:
        return []
    header = rows[start]
    ci = {k: _column(header, k) for k in _ALIASES}
    out = []
    for r in rows[start + 1 :]:
        try:
            lat = float(r[ci["lat"]])
            lon = float(r[ci["lon"]])
        except (IndexError, ValueError, TypeError):
            continue

        def val(k):
            try:
                return float(r[ci[k]]) if ci[k] is not None else None
            except (IndexError, ValueError):
                return None

        out.append(
            {
                "id": f"HIMAWARI9:{t:%Y%m%d%H%M}:{lat:.3f}:{lon:.3f}",
                "source": "HIMAWARI9",
                "satellite": "H09",
                "lat": lat,
                "lon": lon,
                "acq_time": t,
                "frp": val("frp"),
                "brightness": val("temp"),
                "confidence": _confidence(r[ci["reliability"]]) if ci["reliability"] is not None and ci["reliability"] < len(r) else "n",
                "daynight": "",
                "pixel_m": 2000.0,
            }
        )
    return out


def _fetch_sync(user: str, password: str, directory: str, now: datetime) -> list[dict]:
    with ftplib.FTP(HOST, timeout=60) as ftp:
        ftp.login(user, password)
        for back in (0, 1):
            t = now - timedelta(hours=back)
            d = directory.format(yyyymm=f"{t:%Y%m}", dd=f"{t:%d}", hh=f"{t:%H}")
            try:
                names = [n for n in ftp.nlst(d) if n.lower().endswith(".csv")]
            except ftplib.error_perm:
                continue
            if names:
                latest = sorted(names)[-1]
                buf = io.BytesIO()
                ftp.retrbinary(f"RETR {latest}", buf.write)
                return parse_csv(buf.getvalue().decode("utf-8", "replace"), latest.rsplit("/", 1)[-1])
    return []


async def fetch(user: str, password: str, directory: str = DEFAULT_DIR) -> list[dict]:
    return await asyncio.to_thread(_fetch_sync, user, password, directory, datetime.now(timezone.utc))
