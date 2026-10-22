"""Terrain- and fuel-aware probabilistic spread on a raster.

Each grid cell carries its own FBP fuel type (from land cover), slope and aspect.
Every hour, per cell, the FBP slope effect is converted to an equivalent wind
speed and added vectorially to the forecast wind (Forestry Canada 1992,
eqs. 39-49), giving head/back rate of spread, length-to-breadth ratio and the
direction of maximum spread. Fire arrival time is then solved as a
time-dependent shortest path (minimum travel time, cf. Finney 2002): the travel
time between two points uses the elliptical spread rate in that direction, half
in each cell, with the weather of the hour in which the fire reaches the source
cell. Plain stencil paths can only travel in a
few fixed directions, which badly under-predicts the flanks of long, narrow
wind-driven ellipses (~55 % of the area at L:B 5 with 16 neighbours), so arrival
times are also interpolated along each pair of adjacent accepted neighbours on a
48-direction ring (an ordered-upwind simplex update), letting the front travel
in arbitrary directions. Non-fuel
cells (water, built-up, bare ground, snow) act as barriers.

The ensemble perturbs wind speed, direction and ROS like the uniform model.
"""

from __future__ import annotations

import base64
import heapq
import io
import math
import os
import random
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from . import fwi as F
from .spread import FUELS, HourWeather, curing_factor, intensity_class, slope_factor

try:  # numba makes the solver ~100x faster; the pure-Python path is a fallback
    from numba import njit
except ImportError:  # pragma: no cover
    def njit(*args, **kwargs):
        if args and callable(args[0]):
            return args[0]
        return lambda f: f

FUEL_CODES = list(FUELS)
_A = np.array([FUELS[c].a for c in FUEL_CODES])
_B = np.array([FUELS[c].b for c in FUEL_CODES])
_C = np.array([FUELS[c].c for c in FUEL_CODES])
_GRASS = np.array([FUELS[c].grass for c in FUEL_CODES])
_SFC = np.array([FUELS[c].sfc for c in FUEL_CODES])

FUEL_COLORS = {
    "C1": (94, 140, 90), "C2": (34, 90, 50), "C3": (46, 110, 60), "C4": (60, 120, 70), "C5": (80, 130, 80),
    "C6": (70, 125, 75), "C7": (110, 140, 70), "D1": (130, 170, 90), "S1": (190, 150, 70),
    "O1a": (225, 210, 110), "O1b": (240, 190, 90),
}
HORIZON_COLORS = {1: (255, 243, 176), 3: (255, 209, 102), 6: (255, 159, 67), 12: (255, 106, 43), 24: (224, 36, 74), 48: (161, 18, 74), 72: (106, 13, 71)}

# Ring of 48 lattice directions (radius 4) sorted by bearing; consecutive pairs form the
# update simplices. Against the exact Huygens solution for a homogeneous ellipse this
# recovers 93-95 % of the area at L:B 5 (vs ~55 % for a plain 16-neighbour Dijkstra).
_RING = sorted(
    [(dy, dx) for dy in range(-4, 5) for dx in range(-4, 5) if (dy or dx) and math.gcd(abs(dy), abs(dx)) == 1],
    key=lambda p: math.atan2(p[1], p[0]),
)
_DY = np.array([p[0] for p in _RING], dtype=np.int64)  # rows increase northwards
_DX = np.array([p[1] for p in _RING], dtype=np.int64)  # columns increase eastwards
_NSUB = 4  # interpolation points along each simplex edge


@njit(cache=True, nogil=True)
def _dir_rate(R, B, LB, raz, theta):
    """Spread rate from the ignition point in direction theta for an FBP ellipse."""
    if R <= 0.0:
        return 0.0
    a = 0.5 * (R + B)
    b = a / LB
    c = 0.5 * (R - B)
    d = theta - raz
    cs = math.cos(d)
    sn = math.sin(d)
    A = cs * cs / (a * a) + sn * sn / (b * b)
    p = c * cs / (a * a)
    q = c * c / (a * a) - 1.0
    return (p + math.sqrt(p * p - A * q)) / A


@njit(cache=True, nogil=True)
def _blocked(burnable, i0, j0, i1, j1):
    """True if the straight move crosses a non-fuel cell (corner touches count only if both sides are non-fuel)."""
    n = max(abs(i1 - i0), abs(j1 - j0)) * 2
    for s in range(1, n):
        f = s / n
        yi = i0 + f * (i1 - i0)
        xj = j0 + f * (j1 - j0)
        a = int(math.floor(yi + 0.5))
        b = int(math.floor(xj + 0.5))
        if not burnable[a, b]:
            a2 = int(math.ceil(yi - 0.5))
            b2 = int(math.ceil(xj - 0.5))
            if not burnable[a2, b2]:
                return True
    return False


@njit(cache=True, nogil=True)
def _cost(ros, bros, lb, raz, h, i, j, si, sj, sy, sx, cell):
    """Travel time from fractional source point (sy, sx) [cells, relative to target] to cell (i, j)."""
    dy = -sy
    dx = -sx
    d = math.sqrt(dx * dx + dy * dy) * cell
    if d == 0.0:
        return 0.0
    theta = math.atan2(dx, dy)
    rv = _dir_rate(ros[h, i, j], bros[h, i, j], lb[h, i, j], raz[h, i, j], theta)
    rs = _dir_rate(ros[h, si, sj], bros[h, si, sj], lb[h, si, sj], raz[h, si, sj], theta)
    if rv <= 1e-6 or rs <= 1e-6:
        return np.inf
    return 0.5 * d * (1.0 / rv + 1.0 / rs)


@njit(cache=True, nogil=True)
def _arrival(ros, bros, lb, raz, burnable, near_barrier, seed, cell, tmax, DY, DX, NSUB):
    """Ordered-upwind (Dijkstra with simplex updates) arrival time, minutes."""
    H, ny, nx = ros.shape
    K = DY.shape[0]
    T = np.full((ny, nx), np.inf)
    done = np.zeros((ny, nx), dtype=np.bool_)
    heap = [(0.0, 0)]
    heap.pop()
    for i in range(ny):
        for j in range(nx):
            if seed[i, j]:
                T[i, j] = 0.0
                heapq.heappush(heap, (0.0, i * nx + j))
    while len(heap) > 0:
        t, idx = heapq.heappop(heap)
        ui = idx // nx
        uj = idx - ui * nx
        if done[ui, uj] or t > T[ui, uj]:
            continue
        done[ui, uj] = True
        if t > tmax:
            break
        for k in range(K):
            # u = v + D_k  =>  v = u - D_k
            vi = ui - DY[k]
            vj = uj - DX[k]
            if vi < 0 or vj < 0 or vi >= ny or vj >= nx or done[vi, vj] or not burnable[vi, vj]:
                continue
            check = near_barrier[ui, uj]
            if check and _blocked(burnable, ui, uj, vi, vj):
                continue
            h = min(int(t // 60.0), H - 1)
            best = t + _cost(ros, bros, lb, raz, h, vi, vj, ui, uj, DY[k], DX[k], cell)
            for side in (-1, 1):
                k2 = (k + side) % K
                wi = vi + DY[k2]
                wj = vj + DX[k2]
                if wi < 0 or wj < 0 or wi >= ny or wj >= nx or not done[wi, wj]:
                    continue
                if check and _blocked(burnable, wi, wj, vi, vj):
                    continue
                tw = T[wi, wj]
                for s in range(1, NSUB):
                    lam = s / NSUB
                    sy = (1 - lam) * DY[k] + lam * DY[k2]
                    sx = (1 - lam) * DX[k] + lam * DX[k2]
                    ts = (1 - lam) * t + lam * tw
                    hs = min(int(ts // 60.0), H - 1)
                    si = ui if lam < 0.5 else wi
                    sj = uj if lam < 0.5 else wj
                    c = ts + _cost(ros, bros, lb, raz, hs, vi, vj, si, sj, sy, sx, cell)
                    if c < best:
                        best = c
            if best < T[vi, vj]:
                T[vi, vj] = best
                heapq.heappush(heap, (best, vi * nx + vj))
    return T


def _rsi(fidx: np.ndarray, isi, cf: float) -> np.ndarray:
    f = np.maximum(fidx, 0)
    out = _A[f] * (1 - np.exp(-_B[f] * isi)) ** _C[f]
    return np.where(_GRASS[f], out * cf, out)


def hourly_fields(fidx, slope_pct, upslope_deg, be, ffmc, wind, wind_dir, ros_mult, curing_pct):
    """Per-cell head ROS, back ROS (m/min), L:B and spread azimuth (rad) for one hour."""
    burn = fidx >= 0
    f = np.maximum(fidx, 0)
    cf = curing_factor(curing_pct)
    m = 147.2 * (101 - ffmc) / (59.5 + ffmc)
    ff = 91.9 * math.exp(-0.1386 * m) * (1 + m**5.31 / 4.93e7)
    isz = 0.208 * ff
    rsf = _rsi(fidx, isz, cf) * slope_factor(slope_pct)
    denom = np.where(_GRASS[f], _A[f] * cf, _A[f])
    ratio = np.clip(rsf / np.maximum(denom, 1e-9), 0, 0.999)
    isf = np.where(ratio > 0, -np.log(1 - ratio ** (1 / _C[f])) / _B[f], 0.0)
    with np.errstate(divide="ignore"):
        wse = np.where(isf > isz, np.log(np.maximum(isf, 1e-9) / isz) / 0.05039, 0.0)
    wd = math.radians(wind_dir + 180)
    wx = wind * math.sin(wd) + wse * np.sin(np.radians(upslope_deg))
    wy = wind * math.cos(wd) + wse * np.cos(np.radians(upslope_deg))
    wsv = np.hypot(wx, wy)
    raz = np.arctan2(wx, wy)
    ros = _rsi(fidx, 0.208 * ff * np.exp(0.05039 * wsv), cf) * be * ros_mult
    bros = _rsi(fidx, 0.208 * ff * np.exp(-0.05039 * wsv), cf) * be * ros_mult
    lb_grass = np.where(wsv >= 1, 1.1 * np.maximum(wsv, 1) ** 0.464, 1.0)
    lb = np.where(_GRASS[f], lb_grass, 1 + 8.729 * (1 - np.exp(-0.030 * wsv)) ** 2.155)
    zero = ~burn
    ros[zero] = 0
    bros[zero] = 0
    lb[zero] = 1
    return ros.astype(np.float32), bros.astype(np.float32), lb.astype(np.float32), raz.astype(np.float32), wsv


@dataclass
class RasterInputs:
    grid: object  # sources.terrain.Grid
    fuel_idx: np.ndarray  # (ny, nx) index into FUEL_CODES, -1 = non-fuel
    slope_pct: np.ndarray
    upslope_deg: np.ndarray
    seed_points: Sequence[tuple[float, float, float]]  # (lon, lat, pixel_m)
    weather: Sequence[HourWeather]
    fwi_state: F.FWIState
    curing_pct: float = 85.0
    horizons: Sequence[int] = (1, 3, 6, 12, 24)
    members: int = 24
    random_seed: int = 42


def seed_mask(grid, points) -> np.ndarray:
    gx, gy = grid.centres_xy()
    mask = np.zeros((grid.ny, grid.nx), dtype=bool)
    proj = grid.proj
    for lon, lat, size in points:
        x, y = proj.to_xy(lon, lat)
        half = max(size, grid.cell_m) / 2
        mask |= (np.abs(gx - x) <= half) & (np.abs(gy - y) <= half)
        i, j = grid.cell_of(lon, lat)
        if 0 <= i < grid.ny and 0 <= j < grid.nx:
            mask[i, j] = True
    return mask


def fuel_index(codes: np.ndarray) -> np.ndarray:
    lut = {c: i for i, c in enumerate(FUEL_CODES)}
    return np.vectorize(lambda c: lut.get(c, -1), otypes=[np.int64])(codes)


def forecast_raster(inp: RasterInputs) -> dict:
    grid = inp.grid
    seed = seed_mask(grid, inp.seed_points)
    fidx = inp.fuel_idx.copy()
    burnable_any = fidx >= 0
    if burnable_any.any():
        dominant = np.bincount(fidx[burnable_any]).argmax()
    else:
        dominant = FUEL_CODES.index("O1b")
    fidx[seed & (fidx < 0)] = dominant  # a detection proves there is fuel there
    burnable = fidx >= 0

    horizons = sorted(h for h in inp.horizons if h <= len(inp.weather))
    if not horizons:
        raise ValueError("not enough hourly weather for the requested horizons")
    H = horizons[-1]
    bui = F.bui(inp.fwi_state.dmc, inp.fwi_state.dc)
    be_lut = np.array([1.0 if FUELS[c].grass or bui <= 0 else math.exp(50 * math.log(FUELS[c].q) * (1 / bui - 1 / FUELS[c].bui0)) for c in FUEL_CODES])
    be = be_lut[np.maximum(fidx, 0)]

    rng = random.Random(inp.random_seed)
    params = [(1.0, 0.0, 1.0)] + [
        (math.exp(rng.gauss(0, 0.2)), rng.gauss(0, 15), math.exp(rng.gauss(0, 0.25))) for _ in range(inp.members - 1)
    ]
    si, sj = np.argwhere(seed).mean(axis=0).round().astype(int) if seed.any() else (grid.ny // 2, grid.nx // 2)
    # Cells with a barrier within the ring radius need line-of-sight checks; others skip them.
    nb = ~burnable
    near = np.zeros_like(nb)
    pad = np.pad(nb, 4)
    for dy in range(9):
        for dx in range(9):
            near |= pad[dy : dy + grid.ny, dx : dx + grid.nx]
    arrivals = np.empty((len(params), grid.ny, grid.nx), dtype=np.float32)
    hourly_det: list[dict] = []

    def run_member(m: int) -> None:
        wind_mult, dir_off, ros_mult = params[m]
        ros = np.empty((H, grid.ny, grid.nx), dtype=np.float32)
        bros, lb, raz = np.empty_like(ros), np.empty_like(ros), np.empty_like(ros)
        ffmc_h = inp.fwi_state.ffmc
        for h in range(H):
            w = inp.weather[h]
            wind = max(0.0, w.wind * wind_mult)
            ffmc_h = F.hourly_ffmc(ffmc_h, w.temp, w.rh, wind, w.rain)
            ros[h], bros[h], lb[h], raz[h], _ = hourly_fields(fidx, inp.slope_pct, inp.upslope_deg, be, ffmc_h, wind, w.wind_dir + dir_off, ros_mult, inp.curing_pct)
            if m == 0:
                r = float(ros[h, si, sj])
                hfi = 300 * _SFC[max(fidx[si, sj], 0)] * r
                hourly_det.append(
                    {
                        "time": w.time,
                        "ffmc": round(ffmc_h, 1),
                        "isi": round(F.isi(ffmc_h, wind), 1),
                        "ros_m_min": round(r, 2),
                        "max_ros_m_min": round(float(ros[h].max()), 2),
                        "back_ros_m_min": round(float(bros[h, si, sj]), 2),
                        "length_to_breadth": round(float(lb[h, si, sj]), 2),
                        "spread_dir": round(math.degrees(float(raz[h, si, sj])) % 360),
                        "intensity_kw_m": round(hfi),
                        "intensity_class": intensity_class(hfi),
                        "wind": round(w.wind, 1),
                        "wind_dir": round(w.wind_dir),
                        "temp": round(w.temp, 1),
                        "rh": round(w.rh),
                        "rain": round(w.rain, 2),
                    }
                )
        arrivals[m] = _arrival(ros, bros, lb, raz, burnable, near, seed, float(grid.cell_m), H * 60.0, _DY, _DX, _NSUB)

    run_member(0)  # deterministic member first (also warms the JIT cache)
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:
        list(pool.map(run_member, range(1, len(params))))

    cell_ha = grid.cell_m**2 / 1e4
    seed_ha = float(seed.sum()) * cell_ha
    gx, gy = grid.centres_xy()
    sx, sy = gx[seed].mean() if seed.any() else 0.0, gy[seed].mean() if seed.any() else 0.0
    seed_r = float(np.hypot(gx[seed] - sx, gy[seed] - sy).max()) if seed.any() else 0.0
    dist = np.hypot(gx - sx, gy - sy)
    finite = np.where(np.isfinite(arrivals), arrivals, np.float32(1e9))
    median_t = np.median(finite, axis=0)
    p10_t = np.percentile(finite, 10, axis=0)

    features, stats = [], []
    for hz in horizons:
        lim = hz * 60
        burned = arrivals <= lim
        areas = burned.reshape(len(params), -1).sum(axis=1) * cell_ha
        run = max((float(dist[b].max()) for b in burned if b.any()), default=0.0)
        for kind, field in (("likely", median_t), ("p90", p10_t)):
            segs = contour(field, lim, grid)
            area = float((field <= lim).sum()) * cell_ha
            features.append({"type": "Feature", "properties": {"horizon_h": hz, "kind": kind, "area_ha": round(area, 1)}, "geometry": {"type": "MultiLineString", "coordinates": segs}})
        stats.append(
            {
                "horizon_h": hz,
                "time": inp.weather[hz - 1].time,
                "area_ha_p10": round(float(np.percentile(areas, 10)), 1),
                "area_ha_p50": round(float(np.median(areas)), 1),
                "area_ha_p90": round(float(np.percentile(areas, 90)), 1),
                "growth_ha_p50": round(float(np.median(areas)) - seed_ha, 1),
                "max_run_km": round(max(0.0, run - seed_r) / 1000, 2),
            }
        )

    final = arrivals <= H * 60
    edge = np.zeros_like(burnable)
    edge[[0, -1], :] = True
    edge[:, [0, -1]] = True
    prob = final.mean(axis=0)
    codes, counts = np.unique(fidx[fidx >= 0], return_counts=True)
    total = fidx.size
    return {
        "model": "raster",
        "fuel": {"code": FUEL_CODES[dominant], "name": FUELS[FUEL_CODES[dominant]].name},
        "seed": {"type": "Feature", "properties": {"area_ha": round(seed_ha, 1)}, "geometry": {"type": "MultiLineString", "coordinates": contour(np.where(seed, 0.0, 2.0), 1.0, grid)}},
        "perimeters": {"type": "FeatureCollection", "features": features},
        "burn_probability": {"type": "FeatureCollection", "features": []},
        "images": {
            "coordinates": grid.corners_lonlat(),
            "arrival": _png(_arrival_rgba(median_t, horizons)),
            "burn": _png(_prob_rgba(prob)),
            "fuel": _png(_fuel_rgba(fidx)),
        },
        "fuel_mix": {FUEL_CODES[c]: round(100 * n / total, 1) for c, n in zip(codes.tolist(), counts.tolist())} | {"non-fuel": round(100 * float((fidx < 0).sum()) / total, 1)},
        "domain_limited": bool((final & edge).any()),
        "stats": stats,
        "hourly": hourly_det,
        "members": len(params),
        "fwi_state": {"ffmc": round(inp.fwi_state.ffmc, 1), "dmc": round(inp.fwi_state.dmc, 1), "dc": round(inp.fwi_state.dc, 1), "bui": round(bui, 1)},
    }


# ----------------------------------------------------------------------------- outputs

# Marching-squares segment table: case -> list of (edge_a, edge_b); edges 0=S, 1=E, 2=N, 3=W.
_MS = {1: [(3, 0)], 2: [(0, 1)], 3: [(3, 1)], 4: [(1, 2)], 5: [(3, 2), (0, 1)], 6: [(0, 2)], 7: [(3, 2)], 8: [(2, 3)], 9: [(0, 2)], 10: [(0, 3), (1, 2)], 11: [(1, 2)], 12: [(1, 3)], 13: [(0, 1)], 14: [(0, 3)]}


def contour(field: np.ndarray, level: float, grid) -> list[list[list[float]]]:
    """Iso-line segments (lon/lat) where field crosses level; inside = field <= level."""
    f = np.where(np.isfinite(field), field, level * 4 + 1e6).astype(np.float64)
    pad = np.full((f.shape[0] + 2, f.shape[1] + 2), level * 4 + 1e6)
    pad[1:-1, 1:-1] = f  # close lines at the domain edge
    ins = pad <= level
    case = ins[:-1, :-1] * 1 + ins[:-1, 1:] * 2 + ins[1:, 1:] * 4 + ins[1:, :-1] * 8
    proj = grid.proj
    segs = []
    for i, j in zip(*np.nonzero((case > 0) & (case < 15))):
        v = (pad[i, j], pad[i, j + 1], pad[i + 1, j + 1], pad[i + 1, j])
        corners = ((j, i), (j + 1, i), (j + 1, i + 1), (j, i + 1))
        ends = {0: (0, 1), 1: (1, 2), 2: (3, 2), 3: (0, 3)}

        def point(edge):
            a, b = ends[edge]
            fa, fb = v[a], v[b]
            t = 0.5 if fb == fa else min(1.0, max(0.0, (level - fa) / (fb - fa)))
            cx = corners[a][0] + t * (corners[b][0] - corners[a][0])
            cy = corners[a][1] + t * (corners[b][1] - corners[a][1])
            x = grid.x0 + (cx - 0.5) * grid.cell_m
            y = grid.y0 + (cy - 0.5) * grid.cell_m
            lon, lat = proj.to_lonlat(x, y)
            return [round(lon, 6), round(lat, 6)]

        for ea, eb in _MS[int(case[i, j])]:
            segs.append([point(ea), point(eb)])
    return segs


def _png(rgba: np.ndarray) -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.flipud(rgba), "RGBA").save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _arrival_rgba(t: np.ndarray, horizons: list[int]) -> np.ndarray:
    out = np.zeros(t.shape + (4,), dtype=np.uint8)
    for hz in sorted(horizons, reverse=True):
        m = t <= hz * 60
        out[m, :3] = HORIZON_COLORS.get(hz, (255, 106, 43))
        out[m, 3] = 120
    return out


def _prob_rgba(p: np.ndarray) -> np.ndarray:
    out = np.zeros(p.shape + (4,), dtype=np.uint8)
    out[..., 0] = 255
    out[..., 1] = (209 * (1 - p)).astype(np.uint8)
    out[..., 2] = (102 * (1 - p)).astype(np.uint8)
    out[..., 3] = np.where(p > 0, 40 + 150 * p, 0).astype(np.uint8)
    return out


def _fuel_rgba(fidx: np.ndarray) -> np.ndarray:
    out = np.zeros(fidx.shape + (4,), dtype=np.uint8)
    for i, code in enumerate(FUEL_CODES):
        m = fidx == i
        out[m, :3] = FUEL_COLORS[code]
        out[m, 3] = 150
    nf = fidx < 0
    out[nf] = (40, 60, 120, 150)
    return out
