"""Probabilistic fire-spread forecast.

Rate of spread follows the Canadian Fire Behaviour Prediction (FBP) System
(Forestry Canada 1992): head ROS from the Initial Spread Index per fuel type,
the Build-Up effect, back-fire ROS and the elliptical length-to-breadth ratio
from wind speed. The fire front is grown with Huygens' principle: each hour every
point of the front emits an elliptical wavelet oriented downwind, and the new
front is the envelope of the wavelets. With spatially uniform hourly weather that
envelope is the Minkowski sum of the front and the hourly ellipse, so a convex
front is represented exactly by its support function and one hour of growth is
simply ``h_front(θ) += h_ellipse(θ)`` — fast, robust and free of the vertex
tangling that plagues marker-based perimeter propagation.

Uncertainty is represented with an ensemble that perturbs wind speed, wind
direction and ROS. The output contains, per forecast horizon, the median member
("likely" perimeter), a P90 envelope, and a burn-probability grid.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from ..geo import LocalProjection, polygon_area
from . import fwi as F


@dataclass(frozen=True)
class Fuel:
    code: str
    name: str
    a: float
    b: float
    c: float
    q: float  # BUI effect
    bui0: float
    sfc: float  # approximate total fuel consumption, kg/m²
    grass: bool = False


FUELS: dict[str, Fuel] = {
    f.code: f
    for f in [
        Fuel("C1", "Spruce-lichen woodland", 90, 0.0649, 4.5, 0.90, 72, 1.5),
        Fuel("C2", "Boreal spruce", 110, 0.0282, 1.5, 0.70, 64, 3.0),
        Fuel("C3", "Mature jack/lodgepole pine", 110, 0.0444, 3.0, 0.75, 62, 2.5),
        Fuel("C4", "Immature jack/lodgepole pine", 110, 0.0293, 1.5, 0.80, 66, 3.0),
        Fuel("C5", "Red and white pine", 30, 0.0697, 4.0, 0.80, 56, 2.0),
        Fuel("C6", "Conifer plantation", 30, 0.0800, 3.0, 0.80, 62, 2.5),
        Fuel("C7", "Ponderosa pine / Douglas-fir", 45, 0.0305, 2.0, 0.85, 106, 2.0),
        Fuel("D1", "Leafless aspen / deciduous", 30, 0.0232, 1.6, 0.90, 32, 1.0),
        Fuel("S1", "Jack/lodgepole pine slash", 75, 0.0297, 1.3, 0.75, 38, 4.0),
        Fuel("O1a", "Matted grass / cropland", 190, 0.0310, 1.4, 1.0, 1, 0.35, True),
        Fuel("O1b", "Standing grass / savanna", 250, 0.0350, 1.7, 1.0, 1, 0.35, True),
    ]
}


# ESA WorldCover class -> FBP fuel (None = non-fuel). A pragmatic, latitude-aware mapping;
# a national fuel map should replace it where one exists.
def fuel_for_landcover(lc_class: int, lat: float) -> str | None:
    alat = abs(lat)
    if lc_class == 10:  # tree cover
        return "C2" if alat >= 50 else ("C7" if alat >= 28 else "D1")
    if lc_class == 20:  # shrubland: slash-like fine fuel load, used as a shrub proxy
        return "S1"
    if lc_class in (30, 90, 100):  # grassland, herbaceous wetland, moss/lichen
        return "O1b" if lc_class == 30 else "O1a"
    if lc_class == 40:  # cropland
        return "O1a"
    if lc_class == 95:  # mangroves
        return "D1"
    return None  # built-up, bare, snow, water


def slope_factor(slope_pct):
    """FBP spread factor for ground slope (capped at 60 %, Forestry Canada 1992 eq. 39)."""
    gs = np.minimum(np.asarray(slope_pct, dtype=float), 60.0)
    return np.exp(3.533 * (gs / 100.0) ** 1.2)


def auto_fuel(lat: float) -> str:
    """Crude default when no land-cover information is available."""
    return "C2" if abs(lat) >= 50 else "O1b"


def curing_factor(curing_pct: float) -> float:
    if curing_pct < 58.8:
        return 0.005 * (math.exp(0.061 * curing_pct) - 1)
    return 0.176 + 0.02 * (curing_pct - 58.8)


def head_ros(fuel: Fuel, isi: float, bui: float, curing_pct: float = 85.0) -> float:
    """Head fire rate of spread, m/min."""
    ros = fuel.a * (1 - math.exp(-fuel.b * isi)) ** fuel.c
    if fuel.grass:
        ros *= curing_factor(curing_pct)
    elif bui > 0:
        ros *= math.exp(50 * math.log(fuel.q) * (1 / bui - 1 / fuel.bui0))
    return ros


def length_to_breadth(wind_kmh: float, grass: bool = False) -> float:
    if grass:
        return 1.1 * wind_kmh**0.464 if wind_kmh >= 1 else 1.0
    return 1 + 8.729 * (1 - math.exp(-0.030 * wind_kmh)) ** 2.155


def back_ros(fuel: Fuel, ffmc: float, wind_kmh: float, bui: float, curing_pct: float = 85.0) -> float:
    m = 147.2 * (101 - ffmc) / (59.5 + ffmc)
    ff = 91.9 * math.exp(-0.1386 * m) * (1 + m**5.31 / 4.93e7)
    bisi = 0.208 * math.exp(-0.05039 * wind_kmh) * ff
    return head_ros(fuel, bisi, bui, curing_pct)


def intensity_class(kw_m: float) -> int:
    """FBP head-fire intensity class 1..6."""
    for i, upper in enumerate([10, 500, 2000, 4000, 10000], start=1):
        if kw_m < upper:
            return i
    return 6


@dataclass
class HourWeather:
    time: str
    temp: float
    rh: float
    wind: float  # km/h at 10 m
    wind_dir: float  # degrees the wind blows FROM
    rain: float  # mm in the hour


_K = 144  # number of support directions (2.5° resolution)
_THETA = np.linspace(0, 2 * math.pi, _K, endpoint=False)
_COS, _SIN = np.cos(_THETA), np.sin(_THETA)


def ellipse_support(head: float, back: float, lb: float, spread_dir_deg: float) -> np.ndarray:
    """Support function, in every direction theta, of an FBP fire ellipse grown from the origin.

    The ellipse has semi-major a = (head+back)/2 along the spread direction, semi-minor
    b = a/LB and its centre offset c = (head-back)/2 downwind of the ignition point.
    """
    a = (head + back) / 2
    b = a / lb
    c = (head - back) / 2
    th = math.radians(spread_dir_deg)
    ux, uy = math.sin(th), math.cos(th)  # downwind unit vector (x east, y north)
    un = ux * _COS + uy * _SIN
    vn = uy * _COS - ux * _SIN
    return c * un + np.sqrt((a * un) ** 2 + (b * vn) ** 2)


def support_of_points(points: np.ndarray) -> np.ndarray:
    return (points[:, 0:1] * _COS + points[:, 1:2] * _SIN).max(axis=0)


def polygon_from_support(h: np.ndarray) -> np.ndarray:
    """Vertices (CCW) of the convex polygon bounded by the support lines x·cos + y·sin = h."""
    h2 = np.roll(h, -1)
    c1, s1, c2, s2 = _COS, _SIN, np.roll(_COS, -1), np.roll(_SIN, -1)
    det = c1 * s2 - s1 * c2
    x = (h * s2 - h2 * s1) / det
    y = (c1 * h2 - c2 * h) / det
    return np.stack([x, y], axis=1)


def inside_support(px: np.ndarray, py: np.ndarray, h: np.ndarray) -> np.ndarray:
    proj = px[..., None] * _COS + py[..., None] * _SIN
    return (proj <= h + 1e-6).all(axis=-1)


@dataclass
class SpreadInputs:
    seed_points: Sequence[tuple[float, float, float]]  # (lon, lat, pixel_size_m)
    weather: Sequence[HourWeather]
    fwi_state: F.FWIState
    fuel_code: str
    curing_pct: float = 85.0
    horizons: Sequence[int] = (1, 3, 6, 12, 24)
    members: int = 24
    random_seed: int = 42


def forecast(inp: SpreadInputs) -> dict:
    fuel = FUELS[inp.fuel_code]
    lon0 = sum(p[0] for p in inp.seed_points) / len(inp.seed_points)
    lat0 = sum(p[1] for p in inp.seed_points) / len(inp.seed_points)
    proj = LocalProjection(lat0, lon0)

    # Seed perimeter: convex hull of the satellite pixel footprints.
    corners = []
    for lon, lat, size in inp.seed_points:
        x, y = proj.to_xy(lon, lat)
        half = size / 2
        corners += [(x - half, y - half), (x + half, y - half), (x + half, y + half), (x - half, y + half)]
    seed_h = support_of_points(np.asarray(corners))

    horizons = sorted(h for h in inp.horizons if h <= len(inp.weather))
    if not horizons:
        raise ValueError("not enough hourly weather for the requested horizons")
    bui = F.bui(inp.fwi_state.dmc, inp.fwi_state.dc)

    rng = random.Random(inp.random_seed)
    snapshots: dict[int, np.ndarray] = {}  # horizon -> (members, K) support functions
    h = np.tile(seed_h, (inp.members, 1))
    params = [(1.0, 0.0, 1.0)] + [
        (math.exp(rng.gauss(0, 0.2)), rng.gauss(0, 15), math.exp(rng.gauss(0, 0.25))) for _ in range(inp.members - 1)
    ]
    ffmc_h = [inp.fwi_state.ffmc] * inp.members
    hourly_det: list[dict] = []
    for hour in range(1, horizons[-1] + 1):
        w = inp.weather[hour - 1]
        for m, (wind_mult, dir_off, ros_mult) in enumerate(params):
            wind = max(0.0, w.wind * wind_mult)
            ffmc_h[m] = F.hourly_ffmc(ffmc_h[m], w.temp, w.rh, wind, w.rain)
            isi = F.isi(ffmc_h[m], wind)
            ros = head_ros(fuel, isi, bui, inp.curing_pct) * ros_mult
            bros = back_ros(fuel, ffmc_h[m], wind, bui, inp.curing_pct) * ros_mult
            lb = length_to_breadth(wind, fuel.grass)
            spread_dir = (w.wind_dir + 180 + dir_off) % 360
            h[m] += ellipse_support(ros * 60, bros * 60, lb, spread_dir)
            if m == 0:
                hfi = 300 * fuel.sfc * ros  # Byram intensity, kW/m
                hourly_det.append(
                    {
                        "time": w.time,
                        "ffmc": round(ffmc_h[m], 1),
                        "isi": round(isi, 1),
                        "ros_m_min": round(ros, 2),
                        "back_ros_m_min": round(bros, 2),
                        "length_to_breadth": round(lb, 2),
                        "spread_dir": round(spread_dir),
                        "intensity_kw_m": round(hfi),
                        "intensity_class": intensity_class(hfi),
                        "wind": round(w.wind, 1),
                        "wind_dir": round(w.wind_dir),
                        "temp": round(w.temp, 1),
                        "rh": round(w.rh),
                        "rain": round(w.rain, 2),
                    }
                )
        if hour in horizons:
            snapshots[hour] = h.copy()

    def to_geo(ring: np.ndarray) -> list[list[float]]:
        coords = [[round(c, 6) for c in proj.to_lonlat(x, y)] for x, y in ring]
        return coords + [coords[0]]

    seed_ring = polygon_from_support(seed_h)
    seed_area = polygon_area(seed_ring.tolist())
    features = []
    stats = []
    for hz in horizons:
        hs = snapshots[hz]
        areas = np.array([polygon_area(polygon_from_support(row).tolist()) for row in hs])
        order = np.argsort(areas)
        likely = hs[order[len(order) // 2]]
        keep = order[: max(1, int(math.ceil(len(order) * 0.9)))]
        p90 = hs[keep].max(axis=0)  # support function of the hull of the P90 members
        for kind, hh in (("likely", likely), ("p90", p90)):
            ring = polygon_from_support(hh)
            features.append(
                {
                    "type": "Feature",
                    "properties": {"horizon_h": hz, "kind": kind, "area_ha": round(polygon_area(ring.tolist()) / 1e4, 1)},
                    "geometry": {"type": "Polygon", "coordinates": [to_geo(ring)]},
                }
            )
        stats.append(
            {
                "horizon_h": hz,
                "time": inp.weather[hz - 1].time,
                "area_ha_p10": round(float(np.percentile(areas, 10)) / 1e4, 1),
                "area_ha_p50": round(float(np.median(areas)) / 1e4, 1),
                "area_ha_p90": round(float(np.percentile(areas, 90)) / 1e4, 1),
                "growth_ha_p50": round((float(np.median(areas)) - seed_area) / 1e4, 1),
                "max_run_km": round(float((hs - seed_h).max()) / 1000, 2),
            }
        )

    return {
        "fuel": {"code": fuel.code, "name": fuel.name},
        "seed": {
            "type": "Feature",
            "properties": {"area_ha": round(seed_area / 1e4, 1)},
            "geometry": {"type": "Polygon", "coordinates": [to_geo(seed_ring)]},
        },
        "perimeters": {"type": "FeatureCollection", "features": features},
        "burn_probability": _burn_probability(snapshots[horizons[-1]], proj),
        "stats": stats,
        "hourly": hourly_det,
        "members": inp.members,
        "fwi_state": {
            "ffmc": round(inp.fwi_state.ffmc, 1),
            "dmc": round(inp.fwi_state.dmc, 1),
            "dc": round(inp.fwi_state.dc, 1),
            "bui": round(bui, 1),
        },
    }


def _burn_probability(hs: np.ndarray, proj: LocalProjection, cells: int = 48) -> dict:
    """Fraction of ensemble members whose final perimeter covers each grid cell."""
    outer = hs.max(axis=0)
    ring = polygon_from_support(outer)
    xmin, ymin = ring.min(axis=0)
    xmax, ymax = ring.max(axis=0)
    size = max(xmax - xmin, ymax - ymin) / cells or 1.0
    nx = int(math.ceil((xmax - xmin) / size))
    ny = int(math.ceil((ymax - ymin) / size))
    gx, gy = np.meshgrid(xmin + (np.arange(nx) + 0.5) * size, ymin + (np.arange(ny) + 0.5) * size)
    prob = np.zeros(gx.shape)
    for row in hs:
        prob += inside_support(gx, gy, row)
    prob /= len(hs)
    feats = []
    half = size / 2
    for j, i in zip(*np.nonzero(prob)):
        x, y = gx[j, i], gy[j, i]
        corners = [proj.to_lonlat(x - half, y - half), proj.to_lonlat(x + half, y - half), proj.to_lonlat(x + half, y + half), proj.to_lonlat(x - half, y + half)]
        coords = [[round(a, 6), round(b, 6)] for a, b in corners]
        feats.append(
            {"type": "Feature", "properties": {"p": round(float(prob[j, i]), 3)}, "geometry": {"type": "Polygon", "coordinates": [coords + [coords[0]]]}}
        )
    return {"type": "FeatureCollection", "features": feats, "cell_m": round(size)}
