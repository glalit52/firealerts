"""Minimal cloud-optimised GeoTIFF reader over HTTP range requests (no GDAL).

Supports tiled, little/big-endian classic TIFF with DEFLATE or no compression,
horizontal-differencing predictor (2), 8/16/32-bit integer and 32-bit float
samples, pixel-interleaved multi-band data, internal overviews, the GDAL nodata
tag and a north-up geotransform (ModelPixelScale + ModelTiepoint) in any CRS.
That covers ESA WorldCover, Sentinel-2 L2A on AWS, MODIS products on Planetary
Computer and most COGs in the wild.
"""

from __future__ import annotations

import asyncio
import struct
import zlib
from collections import OrderedDict
from dataclasses import dataclass, field

import httpx
import numpy as np

_TYPES = {1: ("B", 1), 2: ("c", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 6: ("b", 1), 8: ("h", 2), 9: ("i", 4), 11: ("f", 4), 12: ("d", 8), 16: ("Q", 8)}
_WANTED = (256, 257, 258, 259, 277, 284, 317, 322, 323, 324, 325, 339, 33550, 33922, 42113)


@dataclass
class Level:
    width: int
    height: int
    tile_w: int
    tile_h: int
    offsets: list[int]
    counts: list[int]


@dataclass
class COG:
    url: str
    levels: list[Level]
    dtype: np.dtype
    samples: int
    compression: int
    predictor: int
    nodata: float | None
    origin_x: float
    origin_y: float
    res_x: float
    res_y: float  # positive; rows go down from origin_y
    headers: dict = field(default_factory=dict)

    def level_res(self, level: int) -> tuple[float, float]:
        f = self.levels[0].width / self.levels[level].width
        return self.res_x * f, self.res_y * f

    def best_level(self, resolution: float) -> int:
        """Coarsest overview whose pixels are no larger than `resolution` (CRS units)."""
        best = 0
        for i in range(len(self.levels)):
            if self.level_res(i)[0] <= resolution:
                best = i
        return best


class _LRU(OrderedDict):
    def __init__(self, maxsize):
        super().__init__()
        self.maxsize = maxsize

    def get_(self, k):
        if k in self:
            self.move_to_end(k)
            return self[k]
        return None

    def put(self, k, v):
        self[k] = v
        self.move_to_end(k)
        while len(self) > self.maxsize:
            self.popitem(last=False)


_cache = _LRU(512)


async def _read(client: httpx.AsyncClient, url: str, start: int, length: int, headers: dict | None = None) -> bytes:
    h = {"Range": f"bytes={start}-{start + length - 1}", **(headers or {})}
    resp = await client.get(url, headers=h)
    if resp.status_code == 404:
        raise FileNotFoundError(url)
    resp.raise_for_status()
    data = resp.content
    if resp.status_code == 200 and len(data) > length:  # server ignored the range
        data = data[start : start + length]
    return data


def _dtype(bits: int, fmt: int, bo: str) -> np.dtype:
    kind = {1: "u", 2: "i", 3: "f"}.get(fmt, "u")
    return np.dtype(f"{'<' if bo == '<' else '>'}{kind}{bits // 8}")


async def open_cog(client: httpx.AsyncClient, url: str, headers: dict | None = None) -> COG:
    key = ("cog", url)
    hit = _cache.get_(key)
    if hit is not None:
        return hit
    head = await _read(client, url, 0, 131072, headers)
    bo = "<" if head[:2] == b"II" else ">"
    if struct.unpack(bo + "H", head[2:4])[0] != 42:
        raise ValueError("BigTIFF is not supported")

    async def value(typ: int, count: int, raw: bytes):
        nonlocal head
        fmt, size = _TYPES[typ]
        total = size * count
        if total <= 4:
            data = raw[:total]
        else:
            off = struct.unpack(bo + "I", raw)[0]
            data = head[off : off + total] if off + total <= len(head) else await _read(client, url, off, total, headers)
        if typ == 2:
            return data.rstrip(b"\0").decode("ascii", "replace")
        if typ == 5:
            v = struct.unpack(bo + "I" * (2 * count), data)
            return [v[i] / v[i + 1] for i in range(0, len(v), 2)]
        return list(struct.unpack(bo + fmt * count, data))

    levels: list[Level] = []
    first: dict = {}
    off = struct.unpack(bo + "I", head[4:8])[0]
    while off:
        if off + 2 > len(head):
            head += await _read(client, url, len(head), off + 65536 - len(head), headers)
        n = struct.unpack(bo + "H", head[off : off + 2])[0]
        if off + 2 + 12 * n + 4 > len(head):
            head += await _read(client, url, len(head), off + 2 + 12 * n + 4 - len(head) + 65536, headers)
        tags = {}
        for i in range(n):
            e = head[off + 2 + 12 * i : off + 14 + 12 * i]
            tag, typ, count = struct.unpack(bo + "HHI", e[:8])
            if typ in _TYPES and tag in _WANTED:
                tags[tag] = await value(typ, count, e[8:12])
        if 322 not in tags:
            raise ValueError("only tiled TIFFs are supported (not a COG)")
        levels.append(Level(tags[256][0], tags[257][0], tags[322][0], tags[323][0], tags[324], tags[325]))
        if not first:
            first = tags
        off = struct.unpack(bo + "I", head[off + 2 + 12 * n : off + 6 + 12 * n])[0]
    # Keep only full-image overviews (skip masks, which share the IFD chain in some files).
    levels = [lv for lv in levels if lv.width * levels[0].height == lv.height * levels[0].width or lv is levels[0]]
    bits = first.get(258, [8])[0]
    nod = first.get(42113)
    nodata = None
    if isinstance(nod, str) and nod.strip():
        try:
            nodata = float(nod)
        except ValueError:
            nodata = None
    scale = first.get(33550, [1.0, 1.0, 0.0])
    tie = first.get(33922, [0, 0, 0, 0.0, 0.0, 0])
    cog = COG(
        url=url,
        levels=levels,
        dtype=_dtype(bits, first.get(339, [1])[0], bo),
        samples=first.get(277, [1])[0],
        compression=first.get(259, [1])[0],
        predictor=first.get(317, [1])[0],
        nodata=nodata,
        origin_x=tie[3] - tie[0] * scale[0],
        origin_y=tie[4] + tie[1] * scale[1],
        res_x=scale[0],
        res_y=scale[1],
        headers=headers or {},
    )
    _cache.put(key, cog)
    return cog


def _decode(raw: bytes, cog: COG, lv: Level) -> np.ndarray:
    if cog.compression in (8, 32946):
        raw = zlib.decompress(raw)
    elif cog.compression != 1:
        raise ValueError(f"unsupported TIFF compression {cog.compression}")
    arr = np.frombuffer(raw, dtype=cog.dtype, count=lv.tile_w * lv.tile_h * cog.samples).reshape(lv.tile_h, lv.tile_w, cog.samples)
    if cog.predictor == 2:
        arr = np.cumsum(arr, axis=1, dtype=arr.dtype)  # modular, like the encoder
    elif cog.predictor == 3:
        raise ValueError("floating-point predictor is not supported")
    return arr


async def tile(client: httpx.AsyncClient, cog: COG, level: int, index: int) -> np.ndarray | None:
    key = ("tile", cog.url, level, index)
    hit = _cache.get_(key)
    if hit is not None:
        return hit
    lv = cog.levels[level]
    if lv.counts[index] == 0:  # sparse tile: all nodata
        arr = None
    else:
        arr = _decode(await _read(client, cog.url, lv.offsets[index], lv.counts[index], cog.headers), cog, lv)
    _cache.put(key, arr)
    return arr


async def read_points(client: httpx.AsyncClient, cog: COG, x, y, level: int = 0) -> np.ndarray:
    """Pixel values at CRS coordinates (nearest neighbour). Returns float array (n, samples); NaN off-image/nodata."""
    x = np.asarray(x, dtype=float).ravel()
    y = np.asarray(y, dtype=float).ravel()
    lv = cog.levels[level]
    rx, ry = cog.level_res(level)
    col = np.floor((x - cog.origin_x) / rx).astype(np.int64)
    row = np.floor((cog.origin_y - y) / ry).astype(np.int64)
    out = np.full((x.size, cog.samples), np.nan)
    ok = (col >= 0) & (row >= 0) & (col < lv.width) & (row < lv.height)
    if not ok.any():
        return out
    across = -(-lv.width // lv.tile_w)
    tidx = np.where(ok, (row // lv.tile_h) * across + col // lv.tile_w, -1)
    uniq = [int(t) for t in np.unique(tidx[ok])]
    arrays = await asyncio.gather(*[tile(client, cog, level, t) for t in uniq])
    for t, arr in zip(uniq, arrays):
        sel = tidx == t
        if arr is None:
            continue
        out[sel] = arr[row[sel] % lv.tile_h, col[sel] % lv.tile_w].astype(float)
    if cog.nodata is not None:
        out[out == cog.nodata] = np.nan
    return out
