import asyncio
import struct
import zlib

import httpx
import numpy as np
import pytest

from firealerts.sources import terrain as T


def make_cog(values: np.ndarray, tile: int, origin_lon: float, origin_lat: float, res: float) -> bytes:
    """Minimal little-endian tiled, DEFLATE-compressed GeoTIFF (one level)."""
    h, w = values.shape
    tiles = []
    for ty in range(0, h, tile):
        for tx in range(0, w, tile):
            block = np.zeros((tile, tile), np.uint8)
            part = values[ty : ty + tile, tx : tx + tile]
            block[: part.shape[0], : part.shape[1]] = part
            tiles.append(zlib.compress(block.tobytes()))
    entries = []  # (tag, type, count, payload bytes)
    entries.append((256, 3, 1, struct.pack("<H", w)))
    entries.append((257, 3, 1, struct.pack("<H", h)))
    entries.append((258, 3, 1, struct.pack("<H", 8)))
    entries.append((259, 3, 1, struct.pack("<H", 8)))
    entries.append((277, 3, 1, struct.pack("<H", 1)))
    entries.append((322, 3, 1, struct.pack("<H", tile)))
    entries.append((323, 3, 1, struct.pack("<H", tile)))
    n_entries = len(entries) + 4
    ifd_off = 8
    data_off = ifd_off + 2 + 12 * n_entries + 4
    extra = b""

    def place(payload: bytes) -> int:
        nonlocal extra
        off = data_off + len(extra)
        extra += payload
        return off

    pixel_scale = place(struct.pack("<3d", res, res, 0))
    tiepoint = place(struct.pack("<6d", 0, 0, 0, origin_lon, origin_lat, 0))
    offsets_pos = place(b"\0" * 4 * len(tiles))
    counts_pos = place(struct.pack(f"<{len(tiles)}I", *[len(t) for t in tiles]))
    tile_start = data_off + len(extra)
    offs, pos = [], tile_start
    for t in tiles:
        offs.append(pos)
        pos += len(t)
    extra = extra[: offsets_pos - data_off] + struct.pack(f"<{len(tiles)}I", *offs) + extra[offsets_pos - data_off + 4 * len(tiles) :]
    entries.append((324, 4, len(tiles), struct.pack("<I", offsets_pos)))
    entries.append((325, 4, len(tiles), struct.pack("<I", counts_pos)))
    entries.append((33550, 12, 3, struct.pack("<I", pixel_scale)))
    entries.append((33922, 12, 6, struct.pack("<I", tiepoint)))
    entries.sort()
    ifd = struct.pack("<H", len(entries)) + b"".join(struct.pack("<HHI", tag, typ, cnt) + payload.ljust(4, b"\0") for tag, typ, cnt, payload in entries) + struct.pack("<I", 0)
    return b"II*\0" + struct.pack("<I", ifd_off) + ifd + extra + b"".join(tiles)


def test_cog_reader_reads_classes_at_points():
    vals = np.full((32, 32), T.GRASS, np.uint8)
    vals[:16, :16] = T.TREE  # north-west quadrant
    vals[20, 25] = 0  # nodata -> water
    blob = make_cog(vals, 16, origin_lon=10.0, origin_lat=46.0, res=0.01)

    def handler(request: httpx.Request):
        if "N45E009" not in str(request.url):
            return httpx.Response(404)
        rng = request.headers.get("range", "bytes=0-")
        a, b = rng.removeprefix("bytes=").split("-")
        chunk = blob[int(a) : int(b) + 1]
        return httpx.Response(206, content=chunk)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            lon = np.array([10.05, 10.25, 10.255, 20.0])
            lat = np.array([45.95, 45.75, 45.795, 45.9])
            return await T.landcover_points(c, lon, lat, resolution_m=500)

    # The tile name encodes the lower-left 3° corner: 45N, 9E covers 45–48N, 9–12E.
    assert T.worldcover_tile_name(45.95, 10.05) == "N45E009"
    out = asyncio.run(run())
    assert out.tolist() == [T.TREE, T.GRASS, T.WATER, T.WATER]


def test_grid_geometry_and_slope():
    g = T.Grid(-31.0, -64.0, 10, 8, 100)
    lon, lat = g.centres_lonlat()
    assert lon.shape == (8, 10) and lat[0, 0] < lat[-1, 0]  # row 0 is south
    assert g.cell_of(-64.0, -31.0) == (4, 5)
    elev = np.tile(np.arange(8)[:, None] * 10.0, (1, 10))  # rises to the north, 10 m per 100 m
    slope, up = T.slope_aspect(elev, 100)
    assert slope.mean() == pytest.approx(10) and up.mean() == pytest.approx(0)


def test_synthetic_terrain_is_deterministic_and_mixed():
    g = T.Grid(39.7, -121.6, 60, 60, 150)
    a = asyncio.run(T.load(None, g, mode="demo"))
    b = asyncio.run(T.load(None, g, mode="demo"))
    assert np.array_equal(a["landcover"], b["landcover"]) and a["source"] == "synthetic"
    assert len(np.unique(a["landcover"])) >= 3
