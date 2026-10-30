"""Meteosat SEVIRI active fires: EUMETSAT LSA SAF FRP-PIXEL list product (every 15 min).

Covers Europe, Africa, the Middle East and eastern South America. Files are
served over HTTPS to registered users (free: https://lsa-saf.eumetsat.int/).
The HDF5 list product holds one row per fire pixel; values are stored as
integers with a per-dataset SCALING_FACTOR (physical = raw / SCALING_FACTOR),
and CF-style scale_factor/add_offset is accepted too.
"""

from __future__ import annotations

import bz2
import io
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np

log = logging.getLogger(__name__)

DEFAULT_URL = "https://datalsasaf.lsasvcs.ipma.pt/PRODUCTS/MSG/FRP-PIXEL/HDF5/{yyyy}/{mm}/{dd}/"
_TIME_RE = re.compile(r"(\d{12})")
_HREF_RE = re.compile(r'href="([^"]*FRP-PIXEL-ListProduct[^"]*)"', re.IGNORECASE)


def scan_time(name: str) -> datetime | None:
    m = _TIME_RE.search(name)
    return datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc) if m else None


def _dataset(f, *names):
    lower = {k.lower(): k for k in f.keys()}
    for n in names:
        if n.lower() in lower:
            return f[lower[n.lower()]]
    return None


def _physical(ds) -> np.ndarray | None:
    if ds is None:
        return None
    data = ds[()].astype("float64").ravel()
    a = {k.lower(): v for k, v in ds.attrs.items()}
    fill = a.get("missing_value", a.get("_fillvalue"))
    mask = np.zeros(data.shape, bool) if fill is None else data == float(np.asarray(fill).ravel()[0])
    if "scaling_factor" in a:
        sf = float(np.asarray(a["scaling_factor"]).ravel()[0])
        data = data / (sf or 1.0)
        if "offset" in a:
            data = data + float(np.asarray(a["offset"]).ravel()[0])
    else:
        data = data * float(np.asarray(a.get("scale_factor", 1.0)).ravel()[0]) + float(np.asarray(a.get("add_offset", 0.0)).ravel()[0])
    data[mask] = np.nan
    return data


def parse_hdf5(blob: bytes, filename: str) -> list[dict]:
    import h5py

    if blob[:3] == b"BZh":
        blob = bz2.decompress(blob)
    t = scan_time(filename) or datetime.now(timezone.utc)
    with h5py.File(io.BytesIO(blob), "r") as f:
        lat = _physical(_dataset(f, "LATITUDE", "lat"))
        lon = _physical(_dataset(f, "LONGITUDE", "lon"))
        if lat is None or lon is None:
            raise ValueError("FRP-PIXEL file without LATITUDE/LONGITUDE")
        frp = _physical(_dataset(f, "FRP"))
        conf = _physical(_dataset(f, "FIRE_CONFIDENCE", "CONFIDENCE"))
        size = _physical(_dataset(f, "PIXEL_SIZE"))
    out = []
    for i in range(lat.size):
        if not (np.isfinite(lat[i]) and np.isfinite(lon[i])):
            continue
        c = conf[i] if conf is not None else np.nan
        if np.isfinite(c) and c > 1:
            c /= 100.0
        px = float(np.sqrt(size[i]) * 1000) if size is not None and np.isfinite(size[i]) and size[i] > 0 else 3000.0
        out.append(
            {
                "id": f"METEOSAT:{t:%Y%m%d%H%M}:{lat[i]:.3f}:{lon[i]:.3f}",
                "source": "METEOSAT",
                "satellite": "MSG",
                "lat": float(lat[i]),
                "lon": float(lon[i]),
                "acq_time": t,
                "frp": None if frp is None or not np.isfinite(frp[i]) else float(frp[i]),
                "brightness": None,
                "confidence": "n" if not np.isfinite(c) else ("l" if c < 0.3 else ("h" if c >= 0.8 else "n")),
                "daynight": "",
                "pixel_m": px,
            }
        )
    return out


async def fetch(client: httpx.AsyncClient, user: str, password: str, url_template: str = DEFAULT_URL) -> list[dict]:
    auth = httpx.BasicAuth(user, password)
    now = datetime.now(timezone.utc)
    for back in (0, 1):
        t = now - timedelta(days=back)
        base = url_template.format(yyyy=f"{t:%Y}", mm=f"{t:%m}", dd=f"{t:%d}")
        resp = await client.get(base, auth=auth)
        if resp.status_code == 404:
            continue
        resp.raise_for_status()
        names = sorted(set(_HREF_RE.findall(resp.text)))
        if names:
            latest = names[-1]
            data = await client.get(base + latest.rsplit("/", 1)[-1], auth=auth)
            data.raise_for_status()
            return parse_hdf5(data.content, latest)
    return []
