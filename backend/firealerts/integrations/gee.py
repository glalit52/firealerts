"""Google Earth Engine connector (service-account credentials per organisation or global).

Analyses run server-side in Earth Engine:
* MODIS MCD64A1 monthly burned area inside an asset,
* Hansen/UMD Global Forest Change tree-cover loss by year,
* Sentinel-2 SR harmonised monthly median NDVI/NBR with SCL cloud masking.
The ``earthengine-api`` client is blocking, so calls run in a worker thread.
"""

from __future__ import annotations

import asyncio
import json
import threading

HANSEN = "UMD/hansen/global_forest_change_2024_v1_12"
_lock = threading.Lock()
_initialised: dict[str, bool] = {}


def parse_credentials(raw: str | dict) -> dict:
    data = json.loads(raw) if isinstance(raw, str) else dict(raw)
    for k in ("client_email", "private_key"):
        if not data.get(k):
            raise ValueError(f"service account JSON is missing '{k}'")
    return data


def _init(credentials: str | dict, project: str = "") -> None:
    import ee

    creds = parse_credentials(credentials)
    key = creds["client_email"] + project
    with _lock:
        if _initialised.get(key):
            return
        sa = ee.ServiceAccountCredentials(creds["client_email"], key_data=json.dumps(creds))
        ee.Initialize(sa, project=project or creds.get("project_id"))
        _initialised.clear()
        _initialised[key] = True


def _geom(geometry: dict):
    import ee

    return ee.Geometry(geometry)


def shape_monthly(features: list[dict], value_key: str) -> list[dict]:
    rows = [{"month": f["properties"]["month"], value_key: round(float(f["properties"].get(value_key) or 0), 2)} for f in features]
    return sorted(rows, key=lambda r: r["month"])


def burned_area_sync(credentials, project: str, geometry: dict, start: str, end: str) -> list[dict]:
    import ee

    _init(credentials, project)
    g = _geom(geometry)
    col = ee.ImageCollection("MODIS/061/MCD64A1").filterDate(start, end).select("BurnDate")

    def per_image(img):
        burned = img.gt(0).multiply(ee.Image.pixelArea()).divide(1e4)
        ha = burned.reduceRegion(ee.Reducer.sum(), g, 500, maxPixels=1e9).get("BurnDate")
        return ee.Feature(None, {"month": img.date().format("YYYY-MM"), "burned_ha": ha})

    return shape_monthly(col.map(per_image).getInfo()["features"], "burned_ha")


def tree_cover_loss_sync(credentials, project: str, geometry: dict) -> list[dict]:
    import ee

    _init(credentials, project)
    g = _geom(geometry)
    img = ee.Image(HANSEN)
    area = ee.Image.pixelArea().divide(1e4).addBands(img.select("lossyear"))
    res = area.reduceRegion(ee.Reducer.sum().group(groupField=1, groupName="year"), g, 30, maxPixels=1e10).getInfo()
    return [{"year": 2000 + int(r["year"]), "loss_ha": round(r["sum"], 2)} for r in res.get("groups", []) if int(r["year"]) > 0]


def s2_monthly_sync(credentials, project: str, geometry: dict, start: str, end: str) -> list[dict]:
    import ee

    _init(credentials, project)
    g = _geom(geometry)

    def mask(img):
        scl = img.select("SCL")
        ok = scl.eq(4).Or(scl.eq(5)).Or(scl.eq(7))
        return img.updateMask(ok)

    col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(g).filterDate(start, end).map(mask)
    months = ee.List.sequence(0, ee.Date(end).difference(ee.Date(start), "month").floor().subtract(1))

    def monthly(m):
        d0 = ee.Date(start).advance(m, "month")
        img = col.filterDate(d0, d0.advance(1, "month")).median()
        nd = img.normalizedDifference(["B8", "B4"]).rename("ndvi").addBands(img.normalizedDifference(["B8", "B12"]).rename("nbr"))
        st = nd.reduceRegion(ee.Reducer.mean(), g, 20, maxPixels=1e9)
        return ee.Feature(None, {"month": d0.format("YYYY-MM"), "ndvi": st.get("ndvi"), "nbr": st.get("nbr")})

    feats = ee.FeatureCollection(months.map(monthly)).getInfo()["features"]
    return [{"month": f["properties"]["month"], "ndvi": f["properties"].get("ndvi"), "nbr": f["properties"].get("nbr")} for f in feats]


def test_sync(credentials, project: str) -> str:
    import ee

    _init(credentials, project)
    return str(ee.Number(1).add(1).getInfo())


async def burned_area(credentials, project, geometry, start, end):
    return await asyncio.to_thread(burned_area_sync, credentials, project, geometry, start, end)


async def tree_cover_loss(credentials, project, geometry):
    return await asyncio.to_thread(tree_cover_loss_sync, credentials, project, geometry)


async def s2_monthly(credentials, project, geometry, start, end):
    return await asyncio.to_thread(s2_monthly_sync, credentials, project, geometry, start, end)


async def test(credentials, project=""):
    return await asyncio.to_thread(test_sync, credentials, project)
