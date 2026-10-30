import asyncio
import json
import struct
import zlib
from datetime import date

import httpx
import numpy as np
import pytest

from firealerts import geo
from firealerts.integrations import cog, gee, gfw, nasa_power, osm, planetary, sentinel2


# ----------------------------------------------------------------------------- COG reader


def make_tiff(values: np.ndarray, tile: int, origin=(0.0, 0.0), res=1.0, predictor=1, nodata=None) -> bytes:
    """Tiled little-endian GeoTIFF; uint8/uint16/int16 single band, optional horizontal predictor."""
    h, w = values.shape
    dt = values.dtype
    fmt = {np.dtype("uint8"): (8, 1), np.dtype("uint16"): (16, 1), np.dtype("int16"): (16, 2)}[dt]
    tiles = []
    for ty in range(0, h, tile):
        for tx in range(0, w, tile):
            block = np.zeros((tile, tile), dt)
            part = values[ty : ty + tile, tx : tx + tile]
            block[: part.shape[0], : part.shape[1]] = part
            if predictor == 2:
                block = np.diff(block, axis=1, prepend=np.zeros((tile, 1), dt)).astype(dt)
            tiles.append(zlib.compress(block.astype(dt.newbyteorder("<")).tobytes()))
    entries = [(256, 3, 1, struct.pack("<H", w)), (257, 3, 1, struct.pack("<H", h)), (258, 3, 1, struct.pack("<H", fmt[0])), (259, 3, 1, struct.pack("<H", 8)),
               (277, 3, 1, struct.pack("<H", 1)), (317, 3, 1, struct.pack("<H", predictor)), (322, 3, 1, struct.pack("<H", tile)), (323, 3, 1, struct.pack("<H", tile)), (339, 3, 1, struct.pack("<H", fmt[1]))]
    extra_tags = 4 + (1 if nodata is not None else 0)
    n = len(entries) + extra_tags
    data_off = 8 + 2 + 12 * n + 4
    extra = b""

    def place(payload):
        nonlocal extra
        off = data_off + len(extra)
        extra += payload
        return off

    scale = place(struct.pack("<3d", res, res, 0))
    tie = place(struct.pack("<6d", 0, 0, 0, origin[0], origin[1], 0))
    nd_bytes = f"{nodata}\0".encode() if nodata is not None else b""
    nd = place(nd_bytes) if len(nd_bytes) > 4 else None
    many = len(tiles) > 1  # arrays of one 4-byte value are stored inline in the IFD entry
    offs_pos = place(b"\0" * 4 * len(tiles)) if many else None
    cnt_pos = place(struct.pack(f"<{len(tiles)}I", *[len(t) for t in tiles])) if many else None
    pos, offs = data_off + len(extra), []
    for t in tiles:
        offs.append(pos)
        pos += len(t)
    if many:
        extra = extra[: offs_pos - data_off] + struct.pack(f"<{len(tiles)}I", *offs) + extra[offs_pos - data_off + 4 * len(tiles):]
        entries += [(324, 4, len(tiles), struct.pack("<I", offs_pos)), (325, 4, len(tiles), struct.pack("<I", cnt_pos))]
    else:
        entries += [(324, 4, 1, struct.pack("<I", offs[0])), (325, 4, 1, struct.pack("<I", len(tiles[0])))]
    entries += [(33550, 12, 3, struct.pack("<I", scale)), (33922, 12, 6, struct.pack("<I", tie))]
    if nodata is not None:
        entries.append((42113, 2, len(nd_bytes), nd_bytes if nd is None else struct.pack("<I", nd)))
    entries.sort()
    ifd = struct.pack("<H", len(entries)) + b"".join(struct.pack("<HHI", t, ty, c) + p.ljust(4, b"\0") for t, ty, c, p in entries) + struct.pack("<I", 0)
    return b"II*\0" + struct.pack("<I", 8) + ifd + extra + b"".join(tiles)


def serve(blob: bytes):
    def handler(request: httpx.Request):
        a, b = request.headers["range"].removeprefix("bytes=").split("-")
        return httpx.Response(206, content=blob[int(a) : int(b) + 1])

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_cog_uint16_with_horizontal_predictor_and_nodata():
    rng = np.random.default_rng(0)
    vals = rng.integers(1, 60000, size=(40, 40)).astype("uint16")
    vals[5, 7] = 0
    blob = make_tiff(vals, 16, origin=(300000.0, 6600040.0), res=10.0, predictor=2, nodata=0)

    async def run():
        async with serve(blob) as c:
            co = await cog.open_cog(c, "mem://pred.tif")
            assert co.predictor == 2 and co.dtype == np.dtype("<u2") and co.nodata == 0
            rows, cols = np.array([0, 17, 39, 5]), np.array([0, 33, 39, 7])
            x = 300000.0 + (cols + 0.5) * 10
            y = 6600040.0 - (rows + 0.5) * 10
            return (await cog.read_points(c, co, x, y))[:, 0], vals[rows, cols]

    got, want = asyncio.run(run())
    assert got[:3].tolist() == want[:3].astype(float).tolist() and np.isnan(got[3])


def test_cog_off_image_points_are_nan():
    blob = make_tiff(np.full((16, 16), 7, "uint8"), 16, origin=(10.0, 20.0), res=0.1)

    async def run():
        async with serve(blob) as c:
            co = await cog.open_cog(c, "mem://small.tif")
            return (await cog.read_points(c, co, [10.05, 50.0], [19.95, 0.0]))[:, 0]

    v = asyncio.run(run())
    assert v[0] == 7 and np.isnan(v[1])


# ----------------------------------------------------------------------------- geometry / projections


@pytest.mark.parametrize("lat,lon,tile", [(-31.207, -64.54, (20, "J", "LL")), (51.5, -0.12, (30, "U", "XC")), (40.4, -3.7, (30, "T", "VK"))])
def test_mgrs_tiles(lat, lon, tile):
    assert geo.mgrs_tile(lat, lon) == tile


def test_utm_roundtrip_and_known_point():
    e, n = geo.utm_forward(-31.20738, -64.54078, 20, True)
    assert float(e) == pytest.approx(353218.8, abs=0.5) and float(n) == pytest.approx(6546392.0, abs=0.5)
    la, lo = geo.utm_inverse(e, n, 20, True)
    assert float(la) == pytest.approx(-31.20738, abs=1e-7) and float(lo) == pytest.approx(-64.54078, abs=1e-7)
    assert geo.epsg_utm(32720) == (20, True) and geo.epsg_utm(32633) == (33, False)


def test_geometry_validation_and_stats():
    g = geo.validate_geometry({"type": "Polygon", "coordinates": [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]]})
    assert g["coordinates"][0][0] == g["coordinates"][0][-1]
    st = geo.geometry_stats(g)
    assert st["area_ha"] == pytest.approx(123.9, rel=0.01) and st["centroid"] == pytest.approx((0.005, 0.005))
    with pytest.raises(ValueError):
        geo.validate_geometry({"type": "Point", "coordinates": [0, 0]})
    with pytest.raises(ValueError):
        geo.validate_geometry({"type": "Polygon", "coordinates": [[[0, 0], [200, 0], [0, 1]]]})


def test_ring_intersection():
    target = {"type": "Polygon", "coordinates": [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]]}
    assert geo.ring_intersects_geometry([[0, 0], [1.5, 0], [1.5, 1.5], [0, 1.5], [0, 0]], target)  # overlap
    assert geo.ring_intersects_geometry([[0, 1.2], [3, 1.2], [3, 1.3], [0, 1.3], [0, 1.2]], target)  # crossing, no vertex inside
    assert not geo.ring_intersects_geometry([[3, 3], [4, 3], [4, 4], [3, 4], [3, 3]], target)


# ----------------------------------------------------------------------------- Sentinel-2


def test_sample_grid_inside_polygon():
    g = {"type": "Polygon", "coordinates": [[[0, 0], [0.05, 0], [0.05, 0.05], [0, 0.05], [0, 0]]]}
    lon, lat, spacing = sentinel2.sample_grid(g, 500)
    assert 300 <= lon.size <= 600 and geo.points_in_geometry(lon, lat, g).all() and spacing > 10


def test_harmonised_offset_decision():
    valid = np.ones(100, bool)
    dark = np.full(100, 500.0)  # harmonised: dark land pixels below 1000 DN
    bright = np.full(100, 1500.0)  # offset still present
    assert sentinel2.harmonised(dark, valid, 1e-4, -0.1)
    assert not sentinel2.harmonised(bright, valid, 1e-4, -0.1)
    assert not sentinel2.harmonised(dark, valid, 1e-4, 0.0)


def test_colorize_and_ratio():
    rgba = sentinel2.colorize(np.array([[0.8, np.nan]]), "ndvi")
    assert tuple(rgba[0, 0, :3]) == (20, 110, 40) and rgba[0, 1, 3] == 0
    r = sentinel2._ratio(np.array([0.3, 0.0]), np.array([0.1, 0.0]))
    assert r[0] == pytest.approx(0.5) and np.isnan(r[1])


def test_bucket_search_lists_scenes_and_dedupes(monkeypatch):
    item = lambda sid, dt, cloud: {  # noqa: E731
        "id": sid,
        "properties": {"datetime": dt, "eo:cloud_cover": cloud, "proj:epsg": 32720},
        "assets": {k: {"href": f"https://x/{sid}/{k}.tif", "raster:bands": [{"scale": 0.0001, "offset": -0.1}]} for k in ("red", "nir", "swir16", "swir22", "scl")},
    }
    items = {
        "S2A_20JLL_20261005_1_L2A": item("S2A_20JLL_20261005_1_L2A", "2026-10-05T14:31:36Z", 5.0),
        "S2A_20JLL_20261005_0_L2A": item("S2A_20JLL_20261005_0_L2A", "2026-10-05T14:31:36Z", 5.0),
        "S2B_20JLL_20261008_0_L2A": item("S2B_20JLL_20261008_0_L2A", "2026-10-08T14:31:36Z", 80.0),
    }

    def handler(request: httpx.Request):
        if "earth-search" in str(request.url):
            return httpx.Response(503)
        if request.url.params.get("list-type"):
            pref = request.url.params["prefix"]
            if pref.endswith("/2026/10/"):
                body = "".join(f"<CommonPrefixes><Prefix>{pref}{sid}/</Prefix></CommonPrefixes>" for sid in items)
                return httpx.Response(200, text=f"<ListBucketResult><Prefix>{pref}</Prefix>{body}</ListBucketResult>")
            return httpx.Response(200, text=f"<ListBucketResult><Prefix>{pref}</Prefix></ListBucketResult>")
        sid = str(request.url).rsplit("/", 1)[-1].removesuffix(".json")
        return httpx.Response(200, json=items[sid])

    geom = {"type": "Polygon", "coordinates": [[[-64.40, -31.36], [-64.35, -31.36], [-64.35, -31.33], [-64.40, -31.33], [-64.40, -31.36]]]}

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await sentinel2.search(c, geom, date(2026, 10, 1), date(2026, 10, 28), max_cloud=40)

    scenes = asyncio.run(run())
    assert [s.id for s in scenes] == ["S2A_20JLL_20261005_1_L2A"]  # cloudy scene dropped, older processing deduped
    assert scenes[0].epsg == 32720 and scenes[0].scale_offset["red"] == (0.0001, -0.1)


# ----------------------------------------------------------------------------- other providers


def test_planetary_sinusoidal_and_burned_fraction():
    x, y = planetary.sinusoidal(np.array([0.0, 10.0]), np.array([0.0, 20.0]))
    assert x[0] == 0 and y[1] == pytest.approx(planetary.MODIS_R * np.radians(10))
    assert x[1] == pytest.approx(planetary.MODIS_R * np.radians(20) * np.cos(np.radians(10)))
    assert planetary.burned_fraction(np.array([0, 0, 150, 200, -1, -2, np.nan])) == (0.5, 4)


def test_gfw_queries_and_shapes():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        if "umd_tree_cover_loss" in str(request.url):
            return httpx.Response(200, json={"data": [{"umd_tree_cover_loss__year": 2019, "loss_ha": 12.345}, {"umd_tree_cover_loss__year": 2021, "loss_ha": 3.0}]})
        return httpx.Response(200, json={"data": [{"alerts": 7, "area_ha": 1.5}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await gfw.tree_cover_loss(c, "k", {"type": "Polygon", "coordinates": []}), await gfw.integrated_alerts(c, "k", {"type": "Polygon", "coordinates": []}, "2026-01-01")

    loss, alerts = asyncio.run(run())
    assert loss == [{"year": 2019, "loss_ha": 12.35}, {"year": 2021, "loss_ha": 3.0}] and alerts["alerts"] == 7
    assert "GROUP BY" in seen[0]["sql"] and seen[0]["geometry"]["type"] == "Polygon"


def test_osm_query_and_parse():
    q = osm.query(-31.3, -64.5, 5000)
    assert q.count("out count;") == 3 and "around:5000,-31.300000,-64.500000" in q
    res = osm.parse({"elements": [{"type": "count", "tags": {"total": "2"}}, {"type": "count", "tags": {"total": "50"}}, {"type": "count", "tags": {"total": "9"}}, {"type": "node", "lat": 1, "lon": 2, "tags": {"name": "Villa", "place": "town", "population": "1200"}}]})
    assert (res["settlements"], res["buildings"], res["road_segments"]) == (2, 50, 9) and res["places"][0]["name"] == "Villa"


def test_nasa_power_parse_and_persistence():
    p = {"T2M": {"2026010100": 20.0, "2026010101": -999}, "RH2M": {"2026010100": 40, "2026010101": 40}, "WS10M": {"2026010100": 5.0, "2026010101": 5}, "WD10M": {"2026010100": 90, "2026010101": 90}, "PRECTOTCORR": {"2026010100": 0.0, "2026010101": 0}}
    hours = nasa_power.parse({"properties": {"parameter": p}})
    assert len(hours) == 1 and hours[0]["wind"] == pytest.approx(18.0)
    day = [dict(hours[0], time=hours[0]["time"].replace(hour=h)) for h in range(24)]
    ext = nasa_power.persistence(day, day[-1]["time"].replace(day=3))
    assert len(ext) > 24 and all(h["rain"] == 0 for h in ext[24:])


def test_gee_credentials_and_shaping():
    with pytest.raises(ValueError):
        gee.parse_credentials('{"client_email": "a@b"}')
    assert gee.parse_credentials({"client_email": "a@b", "private_key": "k"})["client_email"] == "a@b"
    rows = gee.shape_monthly([{"properties": {"month": "2024-02", "burned_ha": 3.14159}}, {"properties": {"month": "2024-01", "burned_ha": None}}], "burned_ha")
    assert rows == [{"month": "2024-01", "burned_ha": 0.0}, {"month": "2024-02", "burned_ha": 3.14}]


def test_best_recent_prefers_clear_scenes():
    mk = lambda d, c: sentinel2.Scene(f"S2A_X_{d}", f"2026-10-{d}T10:00:00Z", c, 32720, {})  # noqa: E731
    assert sentinel2.best_recent([mk("28", 46), mk("25", 39), mk("05", 6)]).id == "S2A_X_05"
    assert sentinel2.best_recent([mk("28", 60), mk("25", 39)]).id == "S2A_X_25"
    assert sentinel2.best_recent([]) is None
