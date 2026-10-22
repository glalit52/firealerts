"""GOES-R ABI Fire Detection and Characterization (FDCF), full disk every 10 minutes.

Geostationary detections arrive minutes after a fire starts, long before the next
polar-orbiter pass. Files are read straight from NOAA's public AWS buckets
(noaa-goes19 = GOES-East, noaa-goes18 = GOES-West).
"""

from __future__ import annotations

import io
import logging
import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np

log = logging.getLogger(__name__)

PRODUCT = "ABI-L2-FDCF"
# Fire mask categories (ATBD): 10/30 good, 11/31 saturated, 12/32 cloud contaminated,
# 13/33 high probability, 14/34 medium probability. 15/35 (low) are skipped.
FIRE_CODES = {10: "h", 11: "h", 12: "n", 13: "h", 14: "n", 30: "h", 31: "h", 32: "n", 33: "h", 34: "n"}
_START_RE = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})")


def bucket_url(sat: str) -> str:
    return f"https://noaa-{sat}.s3.amazonaws.com"


def scan_start(key: str) -> datetime | None:
    m = _START_RE.search(key)
    if not m:
        return None
    y, doy, hh, mm, ss = (int(g) for g in m.groups())
    return datetime(y, 1, 1, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=doy - 1)


async def latest_key(client: httpx.AsyncClient, sat: str, now: datetime | None = None) -> str | None:
    now = now or datetime.now(timezone.utc)
    for back in (0, 1):
        t = now - timedelta(hours=back)
        prefix = f"{PRODUCT}/{t:%Y}/{t.timetuple().tm_yday:03d}/{t:%H}/"
        resp = await client.get(bucket_url(sat), params={"list-type": "2", "prefix": prefix})
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        keys = [el.text for el in root.iter() if el.tag.endswith("Key") and el.text]
        if keys:
            return sorted(keys)[-1]
    return None


def _scaled(var) -> np.ndarray:
    data = var[()].astype("float64")
    fill = var.attrs.get("_FillValue")
    mask = np.zeros(data.shape, dtype=bool)
    if fill is not None:
        mask = data == np.asarray(fill).ravel()[0]
    scale = var.attrs.get("scale_factor")
    offset = var.attrs.get("add_offset")
    if scale is not None:
        data = data * float(np.asarray(scale).ravel()[0])
    if offset is not None:
        data = data + float(np.asarray(offset).ravel()[0])
    data[mask] = np.nan
    return data


def fixed_grid_to_latlon(x: np.ndarray, y: np.ndarray, proj: dict) -> tuple[np.ndarray, np.ndarray]:
    """ABI fixed-grid scan angles (radians) to geodetic lat/lon (GOES-R PUG vol. 4, 4.2.8)."""
    r_eq = proj["semi_major_axis"]
    r_pol = proj["semi_minor_axis"]
    h = proj["perspective_point_height"] + r_eq
    lon0 = math.radians(proj["longitude_of_projection_origin"])
    sx, cx = np.sin(x), np.cos(x)
    sy, cy = np.sin(y), np.cos(y)
    a = sx**2 + cx**2 * (cy**2 + (r_eq**2 / r_pol**2) * sy**2)
    b = -2 * h * cx * cy
    c = h**2 - r_eq**2
    disc = b**2 - 4 * a * c
    with np.errstate(invalid="ignore"):
        rs = (-b - np.sqrt(disc)) / (2 * a)
        s_x = rs * cx * cy
        s_y = -rs * sx
        s_z = rs * cx * sy
        lat = np.degrees(np.arctan((r_eq**2 / r_pol**2) * s_z / np.sqrt((h - s_x) ** 2 + s_y**2)))
        lon = np.degrees(lon0 - np.arctan(s_y / (h - s_x)))
    lat[disc < 0] = np.nan
    lon[disc < 0] = np.nan
    return lat, lon


def parse_fdc(blob: bytes, sat: str, key: str) -> list[dict]:
    import h5py

    t = scan_start(key) or datetime.now(timezone.utc)
    source = sat.upper()
    with h5py.File(io.BytesIO(blob), "r") as f:
        mask = f["Mask"][()]
        rows, cols = np.nonzero(np.isin(mask, list(FIRE_CODES)))
        if rows.size == 0:
            return []
        x = _scaled(f["x"])[cols]
        y = _scaled(f["y"])[rows]
        p = f["goes_imager_projection"].attrs
        proj = {k: float(np.asarray(p[k]).ravel()[0]) for k in ("semi_major_axis", "semi_minor_axis", "perspective_point_height", "longitude_of_projection_origin")}
        lat, lon = fixed_grid_to_latlon(x, y, proj)
        power = _scaled(f["Power"])[rows, cols] if "Power" in f else np.full(rows.shape, np.nan)
        temp = _scaled(f["Temp"])[rows, cols] if "Temp" in f else np.full(rows.shape, np.nan)
        codes = mask[rows, cols]
    out = []
    for la, lo, pw, tk, code in zip(lat, lon, power, temp, codes):
        if not (np.isfinite(la) and np.isfinite(lo)):
            continue
        out.append(
            {
                "id": f"{source}:{t:%Y%m%d%H%M}:{la:.3f}:{lo:.3f}",
                "source": source,
                "satellite": source,
                "lat": float(la),
                "lon": float(lo),
                "acq_time": t,
                "frp": None if not np.isfinite(pw) else float(pw),
                "brightness": None if not np.isfinite(tk) else float(tk),
                "confidence": FIRE_CODES[int(code)],
                "daynight": "",
                "pixel_m": 2000.0,
            }
        )
    return out


async def fetch(client: httpx.AsyncClient, sat: str) -> list[dict]:
    key = await latest_key(client, sat)
    if not key:
        return []
    resp = await client.get(f"{bucket_url(sat)}/{key}")
    resp.raise_for_status()
    return parse_fdc(resp.content, sat, key)
