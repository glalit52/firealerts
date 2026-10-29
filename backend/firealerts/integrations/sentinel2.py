"""Sentinel-2 L2A analysis for monitored areas (AWS Open Data, Element 84 COGs).

* Scene discovery: a STAC API search (Earth Search by default) when reachable,
  otherwise a listing of the public ``sentinel-cogs`` S3 bucket by MGRS tile.
* Statistics: NDVI (vegetation vigour), NBR (burn-sensitive) and NDMI (canopy
  moisture) over a regular sample grid inside the asset polygon, masked with the
  scene classification layer (clouds, shadows, snow, water, no data).
* Burn severity: dNBR between a pre- and a post-fire scene on the same sample
  grid, classified with the USGS/Key & Benson thresholds.
* Imagery: colour-mapped index PNGs for map overlays.

Reflectance: DN x scale + offset from the STAC ``raster:bands`` metadata. Some
COGs on AWS are already offset-harmonised while their metadata still advertises
the processing-baseline 04.00 offset of -0.1; applying it again would make dark
surfaces negative, so the offset is only applied when the data is consistent
with it (decided once per scene, see ``harmonised``).
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import httpx
import numpy as np

from .. import geo
from ..config import settings
from . import cog

log = logging.getLogger(__name__)

BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
PREFIX = "sentinel-s2-l2a-cogs"
BANDS = {"red": "B04", "nir": "B08", "swir16": "B11", "swir22": "B12", "scl": "SCL"}
VALID_SCL = {2, 4, 5, 7}  # dark area, vegetation, bare soil, unclassified
SCL_NAMES = {0: "no data", 1: "saturated", 2: "dark area", 3: "cloud shadow", 4: "vegetation", 5: "bare soil", 6: "water", 7: "unclassified", 8: "cloud (medium)", 9: "cloud (high)", 10: "cirrus", 11: "snow"}
DNBR_CLASSES = [(-math.inf, -0.25, "enhanced regrowth (high)"), (-0.25, -0.1, "enhanced regrowth (low)"), (-0.1, 0.1, "unburned"), (0.1, 0.27, "low severity"), (0.27, 0.44, "moderate-low severity"), (0.44, 0.66, "moderate-high severity"), (0.66, math.inf, "high severity")]


@dataclass
class Scene:
    id: str
    datetime: str
    cloud: float | None
    epsg: int
    hrefs: dict[str, str]
    scale_offset: dict[str, tuple[float, float]] = field(default_factory=dict)

    @property
    def date(self) -> date:
        return date.fromisoformat(self.datetime[:10])

    def as_dict(self) -> dict:
        return {"id": self.id, "datetime": self.datetime, "date": self.date.isoformat(), "cloud_pct": self.cloud, "epsg": self.epsg}


def _scene_from_item(item: dict) -> Scene | None:
    props = item.get("properties", {})
    assets = item.get("assets", {})
    keys = {"red": ("red", "B04"), "nir": ("nir", "B08"), "swir16": ("swir16", "B11"), "swir22": ("swir22", "B12"), "scl": ("scl", "SCL")}
    hrefs, so = {}, {}
    for k, names in keys.items():
        a = next((assets[n] for n in names if n in assets), None)
        if not a:
            return None
        hrefs[k] = a["href"]
        rb = (a.get("raster:bands") or [{}])[0]
        so[k] = (float(rb.get("scale", 1e-4 if k != "scl" else 1)), float(rb.get("offset", 0.0)))
    epsg = props.get("proj:epsg") or int(str(props.get("proj:code", "EPSG:0")).split(":")[-1])
    return Scene(item["id"], props.get("datetime", ""), props.get("eo:cloud_cover"), int(epsg), hrefs, so)


async def _stac_search(client: httpx.AsyncClient, bbox, start: date, end: date, max_cloud: float, limit: int) -> list[Scene]:
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": bbox,
        "datetime": f"{start.isoformat()}T00:00:00Z/{end.isoformat()}T23:59:59Z",
        "limit": limit,
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    resp = await client.post(settings.stac_api_url.rstrip("/") + "/search", json=body, timeout=30)
    resp.raise_for_status()
    return [s for s in (_scene_from_item(f) for f in resp.json().get("features", [])) if s]


async def _bucket_search(client: httpx.AsyncClient, lat: float, lon: float, start: date, end: date, max_cloud: float, limit: int) -> list[Scene]:
    zone, band, square = geo.mgrs_tile(lat, lon)
    months, d = [], date(end.year, end.month, 1)
    while d >= date(start.year, start.month, 1):
        months.append(d)
        d = (d - timedelta(days=1)).replace(day=1)
    prefixes: list[str] = []
    for m in months:
        resp = await client.get(BUCKET + "/", params={"list-type": "2", "prefix": f"{PREFIX}/{zone}/{band}/{square}/{m.year}/{m.month}/", "delimiter": "/"})
        resp.raise_for_status()
        prefixes += re.findall(r"<Prefix>([^<]+/)</Prefix>", resp.text)
    scene_ids = sorted({p.rstrip("/").rsplit("/", 1)[-1] for p in prefixes if p.count("/") > 6}, reverse=True)

    async def meta(sid: str) -> Scene | None:
        y, mo = sid.split("_")[2][:4], str(int(sid.split("_")[2][4:6]))
        try:
            r = await client.get(f"{BUCKET}/{PREFIX}/{zone}/{band}/{square}/{y}/{mo}/{sid}/{sid}.json")
            r.raise_for_status()
            return _scene_from_item(r.json())
        except Exception:
            return None

    # Keep one processing per acquisition (satellite + day): ids sort so the latest processing wins.
    latest: dict[tuple[str, str], str] = {}
    for sid in sorted(scene_ids):
        parts = sid.split("_")
        latest[(parts[0], parts[2])] = sid
    unique = sorted(latest.values(), key=lambda x: x.split("_")[2], reverse=True)
    scenes = [s for s in await asyncio.gather(*[meta(s) for s in unique[: limit * 2]]) if s]
    scenes = [s for s in scenes if start <= s.date <= end and (s.cloud is None or s.cloud < max_cloud)]
    return sorted(scenes, key=lambda s: s.datetime, reverse=True)[:limit]


async def search(client: httpx.AsyncClient, geometry: dict, start: date, end: date, max_cloud: float | None = None, limit: int = 20) -> list[Scene]:
    stats = geo.geometry_stats(geometry)
    max_cloud = settings.sentinel2_max_cloud if max_cloud is None else max_cloud
    try:
        return await _stac_search(client, stats["bbox"], start, end, max_cloud, limit)
    except Exception as exc:
        log.info("STAC search unavailable (%s); listing the S3 bucket", exc)
    lon, lat = stats["centroid"]
    return await _bucket_search(client, lat, lon, start, end, max_cloud, limit)


# ----------------------------------------------------------------------------- sampling and indices


def sample_grid(geometry: dict, max_points: int = 2500) -> tuple[np.ndarray, np.ndarray, float]:
    """Regular lon/lat sample points inside the geometry, and their spacing in metres."""
    stats = geo.geometry_stats(geometry)
    w, s, e, n = stats["bbox"]
    proj = geo.LocalProjection((s + n) / 2, (w + e) / 2)
    width = max(1.0, (e - w) * proj.kx)
    height = max(1.0, (n - s) * proj.ky)
    fill = max(0.05, stats["area_ha"] * 1e4 / (width * height))
    spacing = max(10.0, math.sqrt(width * height * fill / max_points))
    xs = np.arange(w, e, spacing / proj.kx) + spacing / proj.kx / 2
    ys = np.arange(s, n, spacing / proj.ky) + spacing / proj.ky / 2
    if xs.size == 0 or ys.size == 0:
        lon0, lat0 = stats["centroid"]
        return np.array([lon0]), np.array([lat0]), spacing
    gx, gy = np.meshgrid(xs, ys)
    inside = geo.points_in_geometry(gx, gy, geometry)
    if not inside.any():
        lon0, lat0 = stats["centroid"]
        return np.array([lon0]), np.array([lat0]), spacing
    return gx[inside], gy[inside], spacing


def harmonised(red_dn: np.ndarray, valid: np.ndarray, scale: float, offset: float) -> bool:
    """True if the DNs already exclude the baseline-04.00 offset.

    Decided once per scene from the red band (the darkest over land): with the
    offset still in the data, valid land pixels essentially never fall below
    -offset/scale (1000 DN); in harmonised data dark vegetation and water do.
    """
    if offset >= 0:
        return False
    dn = red_dn[valid & (red_dn > 0)]
    return dn.size > 0 and float(np.percentile(dn, 10)) < -offset / scale


def _reflectance(dn: np.ndarray, scale: float, offset: float, already_harmonised: bool) -> np.ndarray:
    dn = np.where(dn > 0, dn, np.nan)
    return dn * scale + (0.0 if already_harmonised else offset)


async def _bands(client: httpx.AsyncClient, scene: Scene, lon: np.ndarray, lat: np.ndarray, spacing: float, which=("red", "nir", "swir16", "swir22", "scl")) -> dict:
    zone, south = geo.epsg_utm(scene.epsg)
    e, n = geo.utm_forward(lat, lon, zone, south)
    cogs = await asyncio.gather(*[cog.open_cog(client, scene.hrefs[b]) for b in which])
    vals = await asyncio.gather(*[cog.read_points(client, c, e, n, c.best_level(spacing / 2)) for c in cogs])
    return {b: v[:, 0] for b, v in zip(which, vals)}


def _ratio(a, b):
    with np.errstate(divide="ignore", invalid="ignore"):
        r = (a - b) / (a + b)
    return np.where(np.isfinite(r), np.clip(r, -1, 1), np.nan)


async def indices(client: httpx.AsyncClient, scene: Scene, lon: np.ndarray, lat: np.ndarray, spacing: float) -> dict:
    raw = await _bands(client, scene, lon, lat, spacing)
    scl = raw["scl"]
    valid = np.isin(scl, list(VALID_SCL))
    red_scale, red_offset = scene.scale_offset.get("red", (1e-4, 0.0))
    harm = harmonised(raw["red"], valid, red_scale, red_offset)
    ref = {k: _reflectance(raw[k], *scene.scale_offset.get(k, (1e-4, 0.0)), harm) for k in ("red", "nir", "swir16", "swir22")}
    valid &= np.isfinite(ref["red"]) & np.isfinite(ref["nir"]) & (ref["red"] > 0) & (ref["nir"] > 0)
    out = {
        "ndvi": np.where(valid, _ratio(ref["nir"], ref["red"]), np.nan),
        "nbr": np.where(valid, _ratio(ref["nir"], ref["swir22"]), np.nan),
        "ndmi": np.where(valid, _ratio(ref["nir"], ref["swir16"]), np.nan),
        "valid": valid,
        "scl": scl,
    }
    return out


def _stats(v: np.ndarray) -> dict | None:
    v = v[np.isfinite(v)]
    if v.size == 0:
        return None
    p = np.percentile(v, [10, 50, 90])
    return {"mean": round(float(v.mean()), 4), "p10": round(float(p[0]), 4), "p50": round(float(p[1]), 4), "p90": round(float(p[2]), 4)}


async def analyse(client: httpx.AsyncClient, geometry: dict, scene: Scene, max_points: int = 2500) -> dict:
    lon, lat, spacing = sample_grid(geometry, max_points)
    ix = await indices(client, scene, lon, lat, spacing)
    classes = {SCL_NAMES.get(int(c), str(int(c))): int(n) for c, n in zip(*np.unique(ix["scl"][np.isfinite(ix["scl"])], return_counts=True))}
    st = {k: _stats(ix[k]) for k in ("ndvi", "nbr", "ndmi")}
    return {
        "scene": scene.as_dict(),
        "points": int(lon.size),
        "spacing_m": round(spacing, 1),
        "valid_frac": round(float(ix["valid"].mean()), 3),
        "ndvi": st["ndvi"]["mean"] if st["ndvi"] else None,
        "nbr": st["nbr"]["mean"] if st["nbr"] else None,
        "ndmi": st["ndmi"]["mean"] if st["ndmi"] else None,
        "stats": {**st, "scl": classes},
    }


async def burn_severity(client: httpx.AsyncClient, geometry: dict, pre: Scene, post: Scene, area_ha: float, max_points: int = 4000) -> dict:
    lon, lat, spacing = sample_grid(geometry, max_points)
    a, b = await asyncio.gather(indices(client, pre, lon, lat, spacing), indices(client, post, lon, lat, spacing))
    dnbr = a["nbr"] - b["nbr"]
    ok = np.isfinite(dnbr)
    classes = []
    for lo, hi, name in DNBR_CLASSES:
        frac = float(((dnbr >= lo) & (dnbr < hi) & ok).sum() / max(1, ok.sum()))
        classes.append({"class": name, "min": None if lo == -math.inf else lo, "max": None if hi == math.inf else hi, "fraction": round(frac, 4), "area_ha": round(frac * area_ha, 1)})
    burned = float(((dnbr >= 0.1) & ok).sum() / max(1, ok.sum()))
    return {
        "pre": pre.as_dict(),
        "post": post.as_dict(),
        "valid_frac": round(float(ok.mean()), 3),
        "dnbr": _stats(dnbr),
        "burned_fraction": round(burned, 4),
        "burned_ha": round(burned * area_ha, 1),
        "classes": classes,
        "image": await render(client, geometry, post, "dnbr", pre=pre),
    }


# ----------------------------------------------------------------------------- imagery

_RAMPS = {
    "ndvi": [(-0.2, (120, 80, 50)), (0.1, (190, 160, 110)), (0.3, (230, 220, 120)), (0.5, (120, 190, 80)), (0.8, (20, 110, 40))],
    "nbr": [(-0.5, (90, 30, 20)), (0.0, (200, 120, 60)), (0.3, (220, 220, 140)), (0.6, (60, 150, 70))],
    "ndmi": [(-0.4, (160, 100, 40)), (0.0, (230, 220, 160)), (0.3, (90, 170, 210)), (0.6, (20, 70, 160))],
    "dnbr": [(-0.25, (30, 120, 60)), (0.1, (200, 200, 200)), (0.27, (255, 230, 90)), (0.44, (255, 150, 50)), (0.66, (230, 50, 40)), (1.0, (120, 20, 90))],
}


def colorize(values: np.ndarray, ramp: str) -> np.ndarray:
    stops = _RAMPS[ramp]
    xs = np.array([s[0] for s in stops])
    out = np.zeros(values.shape + (4,), dtype=np.uint8)
    for c in range(3):
        out[..., c] = np.interp(np.nan_to_num(values, nan=xs[0]), xs, [s[1][c] for s in stops]).astype(np.uint8)
    out[..., 3] = np.where(np.isfinite(values), 220, 0)
    return out


async def render(client: httpx.AsyncClient, geometry: dict, scene: Scene, index: str = "ndvi", pre: Scene | None = None, max_px: int = 320) -> dict:
    """Colour-mapped index over the asset bbox (outside the polygon dimmed), for map overlays."""
    from PIL import Image

    w, s, e, n = geo.geometry_stats(geometry)["bbox"]
    pad_x, pad_y = (e - w) * 0.08 + 1e-4, (n - s) * 0.08 + 1e-4
    w, e, s, n = w - pad_x, e + pad_x, s - pad_y, n + pad_y
    proj = geo.LocalProjection((s + n) / 2, (w + e) / 2)
    width_m, height_m = (e - w) * proj.kx, (n - s) * proj.ky
    px = max(width_m, height_m) / max_px
    nx, ny = max(2, int(width_m / max(px, 10))), max(2, int(height_m / max(px, 10)))
    lons = np.linspace(w, e, nx)
    lats = np.linspace(n, s, ny)
    gx, gy = np.meshgrid(lons, lats)
    spacing = max(10.0, max(width_m / nx, height_m / ny))
    if index == "dnbr":
        a, b = await asyncio.gather(indices(client, pre, gx.ravel(), gy.ravel(), spacing), indices(client, scene, gx.ravel(), gy.ravel(), spacing))
        vals = (a["nbr"] - b["nbr"]).reshape(gx.shape)
    else:
        vals = (await indices(client, scene, gx.ravel(), gy.ravel(), spacing))[index].reshape(gx.shape)
    rgba = colorize(vals, index)
    outside = ~geo.points_in_geometry(gx, gy, geometry)
    rgba[outside, 3] = (rgba[outside, 3] * 0.35).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return {
        "index": index,
        "scene": scene.as_dict(),
        "url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "coordinates": [[w, n], [e, n], [e, s], [w, s]],
        "resolution_m": round(spacing),
    }


def best_recent(scenes: list[Scene], clear_pct: float = 20) -> Scene | None:
    """Most recent reasonably clear scene, else the least cloudy one."""
    clear = [s for s in scenes if (s.cloud or 0) <= clear_pct]
    if clear:
        return max(clear, key=lambda s: s.datetime)
    return min(scenes, key=lambda s: s.cloud or 0) if scenes else None


def nearest(scenes: list[Scene], target: date, before: bool | None = None) -> Scene | None:
    pool = [s for s in scenes if before is None or (s.date <= target if before else s.date >= target)]
    return min(pool, key=lambda s: (abs((s.date - target).days), s.cloud or 0)) if pool else None


def parse_date(v: str | None, default: date) -> date:
    return datetime.fromisoformat(v).date() if v else default
