"""Terrain and land cover on a local forecast grid.

* Elevation: AWS Terrain Tiles (Mapzen "terrarium" PNG, public S3 bucket), ~30 m at z14.
* Land cover: ESA WorldCover 10 m v200 (2021) cloud-optimised GeoTIFFs on AWS. A
  minimal COG reader fetches only the internal tiles it needs, from the overview
  level that matches the grid resolution, using HTTP range requests (no GDAL).

Both have deterministic synthetic fallbacks so the terrain-aware spread model
also runs offline.
"""

from __future__ import annotations

import asyncio
import io
import logging
import math
from collections import OrderedDict
from dataclasses import dataclass

import httpx
import numpy as np

from ..geo import LocalProjection
from ..integrations import cog

log = logging.getLogger(__name__)

TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
WORLDCOVER = "https://esa-worldcover.s3.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{name}_Map.tif"

# ESA WorldCover classes
TREE, SHRUB, GRASS, CROP, BUILT, BARE, SNOW, WATER, WETLAND, MANGROVE, MOSS = 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100
LANDCOVER_NAMES = {
    TREE: "Tree cover",
    SHRUB: "Shrubland",
    GRASS: "Grassland",
    CROP: "Cropland",
    BUILT: "Built-up",
    BARE: "Bare / sparse",
    SNOW: "Snow and ice",
    WATER: "Water",
    WETLAND: "Herbaceous wetland",
    MANGROVE: "Mangroves",
    MOSS: "Moss and lichen",
}


@dataclass
class Grid:
    """A north-up grid of square cells centred on (lat0, lon0). Row 0 is the southern edge."""

    lat0: float
    lon0: float
    nx: int
    ny: int
    cell_m: float

    @property
    def proj(self) -> LocalProjection:
        return LocalProjection(self.lat0, self.lon0)

    @property
    def x0(self) -> float:
        return -self.nx * self.cell_m / 2

    @property
    def y0(self) -> float:
        return -self.ny * self.cell_m / 2

    def centres_xy(self) -> tuple[np.ndarray, np.ndarray]:
        xs = self.x0 + (np.arange(self.nx) + 0.5) * self.cell_m
        ys = self.y0 + (np.arange(self.ny) + 0.5) * self.cell_m
        return np.meshgrid(xs, ys)

    def centres_lonlat(self) -> tuple[np.ndarray, np.ndarray]:
        gx, gy = self.centres_xy()
        p = self.proj
        return self.lon0 + gx / p.kx, self.lat0 + gy / p.ky

    def corners_lonlat(self) -> list[list[float]]:
        """Image corners for MapLibre: top-left, top-right, bottom-right, bottom-left."""
        p = self.proj
        w, e = self.x0, -self.x0
        s, n = self.y0, -self.y0
        return [list(p.to_lonlat(w, n)), list(p.to_lonlat(e, n)), list(p.to_lonlat(e, s)), list(p.to_lonlat(w, s))]

    def cell_of(self, lon: float, lat: float) -> tuple[int, int]:
        x, y = self.proj.to_xy(lon, lat)
        return int((y - self.y0) // self.cell_m), int((x - self.x0) // self.cell_m)


class _LRU(OrderedDict):
    def __init__(self, maxsize: int):
        super().__init__()
        self.maxsize = maxsize

    def get_(self, key):
        if key in self:
            self.move_to_end(key)
            return self[key]
        return None

    def put(self, key, value):
        self[key] = value
        self.move_to_end(key)
        while len(self) > self.maxsize:
            self.popitem(last=False)


_tile_cache = _LRU(256)


# ----------------------------------------------------------------------------- elevation


def _merc_pixel(lon: np.ndarray, lat: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    n = 2**z * 256
    x = (lon + 180) / 360 * n
    lat_r = np.radians(np.clip(lat, -85.05, 85.05))
    y = (1 - np.log(np.tan(lat_r) + 1 / np.cos(lat_r)) / math.pi) / 2 * n
    return x, y


async def _terrarium_tile(client: httpx.AsyncClient, z: int, x: int, y: int) -> np.ndarray:
    key = ("dem", z, x, y)
    hit = _tile_cache.get_(key)
    if hit is not None:
        return hit
    from PIL import Image

    resp = await client.get(TERRARIUM.format(z=z, x=x, y=y))
    resp.raise_for_status()
    rgb = np.asarray(Image.open(io.BytesIO(resp.content)).convert("RGB"), dtype=np.float64)
    elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    _tile_cache.put(key, elev)
    return elev


async def elevation(client: httpx.AsyncClient, grid: Grid, max_tiles: int = 16) -> np.ndarray:
    lon, lat = grid.centres_lonlat()
    res0 = 156543.03 * math.cos(math.radians(grid.lat0))
    z = int(min(14, max(1, math.ceil(math.log2(res0 / grid.cell_m)))))
    while True:
        px, py = _merc_pixel(lon, lat, z)
        tx, ty = np.floor(px / 256).astype(int), np.floor(py / 256).astype(int)
        tiles = sorted(set(zip(tx.ravel().tolist(), ty.ravel().tolist())))
        if len(tiles) <= max_tiles or z <= 1:
            break
        z -= 1
    arrays = await asyncio.gather(*[_terrarium_tile(client, z, x, y) for x, y in tiles])
    lookup = dict(zip(tiles, arrays))
    out = np.empty(lon.shape)
    for (x, y), arr in lookup.items():
        m = (tx == x) & (ty == y)
        ix = np.clip((px[m] - x * 256).astype(int), 0, 255)
        iy = np.clip((py[m] - y * 256).astype(int), 0, 255)
        out[m] = arr[iy, ix]
    return out


def synthetic_elevation(grid: Grid) -> np.ndarray:
    """Smooth hills and valleys, deterministic in absolute coordinates."""
    lon, lat = grid.centres_lonlat()
    k = 111.0  # km per degree
    x, y = lon * k * math.cos(math.radians(grid.lat0)), lat * k
    z = 400 + 260 * np.sin(x / 6.0) * np.cos(y / 7.5) + 140 * np.sin((x + y) / 2.7) + 60 * np.cos(x / 1.3 - y / 1.9)
    return z


def slope_aspect(elev: np.ndarray, cell_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Slope (percent) and the bearing of the upslope direction (degrees from north)."""
    dzdy, dzdx = np.gradient(elev, cell_m)  # rows go north, columns go east
    slope = np.hypot(dzdx, dzdy) * 100
    upslope = (np.degrees(np.arctan2(dzdx, dzdy)) + 360) % 360
    return slope, upslope


# ----------------------------------------------------------------------------- land cover (COG)


def worldcover_tile_name(lat: float, lon: float) -> str:
    la = int(math.floor(lat / 3) * 3)
    lo = int(math.floor(lon / 3) * 3)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


async def landcover_points(client: httpx.AsyncClient, lon: np.ndarray, lat: np.ndarray, resolution_m: float) -> np.ndarray:
    """WorldCover class at arbitrary points, read from the overview matching resolution_m."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    out = np.full(lon.shape, WATER, dtype=np.uint8)  # missing WorldCover tiles are open ocean
    names = np.vectorize(worldcover_tile_name)(lat, lon)
    for name in np.unique(names):
        try:
            c = await cog.open_cog(client, WORLDCOVER.format(name=name))
        except FileNotFoundError:
            continue
        m = names == name
        deg = (resolution_m / 2) / (111320 * max(0.1, math.cos(math.radians(float(lat[m].mean())))))
        vals = (await cog.read_points(client, c, lon[m], lat[m], c.best_level(deg)))[:, 0]
        vals = np.nan_to_num(vals, nan=0).astype(np.uint8)
        vals[vals == 0] = WATER  # nodata is open sea within coastal tiles
        out[m] = vals
    return out


async def landcover(client: httpx.AsyncClient, grid: Grid) -> np.ndarray:
    lon, lat = grid.centres_lonlat()
    return await landcover_points(client, lon, lat, grid.cell_m)


def synthetic_landcover(grid: Grid, elev: np.ndarray | None = None) -> np.ndarray:
    """Patchy mosaic: forest on high ground, grass and crops below, a river and a road."""
    lon, lat = grid.centres_lonlat()
    k = 111.0
    x, y = lon * k * math.cos(math.radians(grid.lat0)), lat * k
    elev = synthetic_elevation(grid) if elev is None else elev
    noise = np.sin(x * 1.7 + np.cos(y * 1.3)) + np.cos(y * 2.1 - x * 0.7)
    lc = np.full(lon.shape, GRASS, dtype=np.uint8)
    lc[noise > 0.9] = CROP
    lc[elev > 520] = TREE
    lc[(elev > 450) & (elev <= 520) & (noise < 0)] = SHRUB
    river = np.abs(np.sin(x / 9.0) * 4.0 - (y % 40 - 20)) < 0.12
    lc[river] = WATER
    road = np.abs((x + 0.5 * y) % 25 - 12.5) < 0.04
    lc[road] = BUILT
    return lc


async def load(client: httpx.AsyncClient | None, grid: Grid, mode: str = "auto") -> dict:
    """Elevation + land cover for the grid; falls back to synthetic data offline."""
    if mode != "demo" and client is not None:
        try:
            elev, lc = await asyncio.gather(elevation(client, grid), landcover(client, grid))
            return {"elevation": elev, "landcover": lc, "source": "AWS Terrain Tiles + ESA WorldCover 2021"}
        except Exception as exc:
            if mode == "live":
                raise
            log.warning("terrain/land cover unavailable (%s); using synthetic terrain", exc)
    elev = synthetic_elevation(grid)
    return {"elevation": elev, "landcover": synthetic_landcover(grid, elev), "source": "synthetic"}
