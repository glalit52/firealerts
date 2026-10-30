import io
import json
import zipfile
from datetime import timedelta

import httpx
import pytest
from conftest import Recorder, bearer, register, square

from firealerts.db import SessionLocal, utcnow
from firealerts.models import Detection
from firealerts.sources import demo


def test_meta_health_sources(client):
    assert client.get("/api/health").json()["status"] == "ok"
    meta = client.get("/api/meta").json()
    assert "forest" in meta["asset_kinds"] and "slack" in meta["connector_types"] and "free" in meta["plans"]
    assert {s["id"] for s in client.get("/api/sources").json()["sources"]} >= {"firms", "sentinel2", "worldcover", "gibs"}


def test_asset_alert_lifecycle_anonymous(client):
    # Watch an area around a demo fire *before* ingesting, so new detections alert.
    fresh = [d for d in demo.generate() if d["acq_time"] >= utcnow() - timedelta(hours=5)]
    target = fresh[0]
    r = client.post("/api/assets", json={"name": "Ranch", "kind": "farm", "center": [target["lat"], target["lon"]], "radius_km": 5, "min_confidence": "l", "tags": ["north", " "]})
    assert r.status_code == 201, r.text
    asset = r.json()
    assert asset["tags"] == ["north"] and 7000 < asset["area_ha"] < 8600 and len(asset["bbox"]) == 4

    run = client.post("/api/ingest").json()
    assert run["mode"] == "demo" and run["inserted"] > 100 and run["alerts"] >= 1
    assert client.post("/api/ingest").json()["inserted"] == 0  # de-duplicated

    alerts = client.get(f"/api/alerts?asset_id={asset['id']}").json()
    assert alerts["total"] >= 1
    al = alerts["items"][0]
    assert al["type"] == "detection" and al["asset_name"] == "Ranch" and al["severity"] in ("high", "critical", "moderate")
    assert client.post(f"/api/alerts/{al['id']}/ack").json()["status"] == "acknowledged"
    assert client.post(f"/api/alerts/{al['id']}/resolve").json()["status"] == "resolved"
    assert client.post(f"/api/alerts/{al['id']}/reopen").json()["status"] == "open"
    assert client.get("/api/alerts?status=resolved").json()["total"] == 0
    stats = client.get("/api/alerts/stats").json()
    assert stats["by_type"]["detection"] >= 1 and stats["open"] >= 1

    s = client.get(f"/api/assets/{asset['id']}/summary").json()
    assert s["fires"]["within_25km_7d"] >= 1 and s["open_alerts"]
    det = client.get(f"/api/assets/{asset['id']}/detections?days=2").json()
    assert det["features"] and "distance_km" in det["features"][0]["properties"]

    risk = client.get(f"/api/assets/{asset['id']}/risk").json()["days"]
    assert len(risk) >= 7 and all(0 <= d["ignition_p"] <= 1 for d in risk) and any(d["forecast"] for d in risk)

    patched = client.patch(f"/api/assets/{asset['id']}", json={"buffer_km": 5, "risk_min_danger": "extreme"}).json()
    assert patched["buffer_km"] == 5 and patched["risk_min_danger"] == "extreme"
    assert client.patch(f"/api/assets/{asset['id']}", json={"kind": "spaceship"}).status_code == 422

    listed = client.get("/api/assets").json()
    assert any(a["id"] == asset["id"] and a["open_alerts"] >= 1 and a["risk_today"] for a in listed)
    report = client.get(f"/api/assets/{asset['id']}/report")
    assert report.status_code == 200 and "Ranch" in report.text and "Fire danger" in report.text
    ts = client.get(f"/api/export/assets/{asset['id']}/timeseries.csv")
    assert ts.status_code == 200 and ts.text.startswith("date,ndvi")


def test_asset_validation(client):
    assert client.post("/api/assets", json={"name": "x"}).status_code == 422
    bad = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0]]]}
    assert client.post("/api/assets", json={"name": "x", "geometry": bad}).status_code == 422
    assert client.post("/api/assets", json={"name": "x", "kind": "volcano", "geometry": square(0, 0)}).status_code == 422
    assert client.get("/api/assets/999999").status_code == 404


def _shapefile_zip() -> bytes:
    import shapefile

    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON)
    w.field("NAME", "C")
    w.poly([[[10, 10], [10, 10.05], [10.05, 10.05], [10.05, 10], [10, 10]]])
    w.record("Block A")
    w.close()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for ext, b in (("shp", shp), ("shx", shx), ("dbf", dbf)):
            z.writestr(f"stands.{ext}", b.getvalue())
        z.writestr("stands.prj", 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]')
    return buf.getvalue()


KML = """<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>North stand</name><Polygon><outerBoundaryIs><LinearRing><coordinates>20,20,0 20.05,20,0 20.05,20.05,0 20,20.05,0 20,20,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>A point</name><Point><coordinates>1,1</coordinates></Point></Placemark>
</Document></kml>"""


@pytest.mark.parametrize(
    "filename,payload,names",
    [
        ("forests.geojson", json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Gum block"}, "geometry": square(147, -37, 0.02)}, {"type": "Feature", "properties": {}, "geometry": square(147.2, -37, 0.02)}]}).encode(), ["Gum block", "forests 2"]),
        ("stands.kml", KML.encode(), ["North stand"]),
        ("stands.zip", _shapefile_zip(), ["Block A"]),
    ],
)
def test_import_formats(client, filename, payload, names):
    r = client.post("/api/assets/import?kind=plantation&buffer_km=1", files={"file": (filename, payload)})
    assert r.status_code == 201, r.text
    created = r.json()["created"]
    assert [a["name"] for a in created] == names and all(a["kind"] == "plantation" and a["buffer_km"] == 1 for a in created)


def test_import_kmz_and_errors(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("doc.kml", KML)
    assert client.post("/api/assets/import", files={"file": ("x.kmz", buf.getvalue())}).status_code == 201
    assert client.post("/api/assets/import", files={"file": ("x.txt", b"hello")}).status_code == 422
    empty = json.dumps({"type": "FeatureCollection", "features": []}).encode()
    assert client.post("/api/assets/import", files={"file": ("x.geojson", empty)}).status_code == 422


def test_connectors_rules_and_test_endpoint(client):
    r = client.post("/api/connectors", json={"type": "slack", "name": "Ops", "config": {"webhook_url": "https://hooks.slack.com/services/A/B/C"}})
    assert r.status_code == 201
    con = r.json()
    assert con["config"]["webhook_url"] == "••••••" and con["category"] == "notification"
    assert client.post("/api/connectors", json={"type": "slack", "name": "bad", "config": {}}).status_code == 422
    # Updating with the redaction marker keeps the stored secret.
    upd = client.patch(f"/api/connectors/{con['id']}", json={"name": "Ops room", "config": {"webhook_url": "••••••"}}).json()
    assert upd["name"] == "Ops room"

    rec = Recorder()
    original = client.app.state.client
    client.app.state.client = rec.client()
    try:
        t = client.post(f"/api/connectors/{con['id']}/test").json()
    finally:
        client.app.state.client = original
    assert t["ok"] and str(rec.requests[0].url) == "https://hooks.slack.com/services/A/B/C"

    rule = client.post("/api/notification-rules", json={"name": "Critical", "min_severity": "critical", "alert_types": ["threat"], "connector_ids": [con["id"]]})
    assert rule.status_code == 201
    assert client.post("/api/notification-rules", json={"name": "x", "connector_ids": [999999]}).status_code == 422
    assert client.post("/api/notification-rules", json={"name": "x", "alert_types": ["meteor"]}).status_code == 422
    rid = rule.json()["id"]
    assert client.put(f"/api/notification-rules/{rid}", json={"name": "Critical+", "min_severity": "high", "connector_ids": [con["id"]]}).json()["min_severity"] == "high"
    assert client.delete(f"/api/connectors/{con['id']}").status_code == 204
    assert [r for r in client.get("/api/notification-rules").json() if r["id"] == rid][0]["connector_ids"] == []


def test_exports(client):
    for fmt, needle in (("csv", "acq_time"), ("geojson", "FeatureCollection"), ("kml", "<kml")):
        r = client.get(f"/api/export/detections.{fmt}?hours=48")
        assert r.status_code == 200 and needle in r.text and "attachment" in r.headers["content-disposition"]
    for fmt, needle in (("csv", "area_ha"), ("geojson", "FeatureCollection"), ("kml", "<Polygon>")):
        assert needle in client.get(f"/api/export/assets.{fmt}").text
    assert client.get("/api/export/alerts.csv").text.startswith("id,created_at")
    assert client.get("/api/export/detections.xml").status_code == 400
    assert client.get("/api/data/usage").json()["platform_detections"] > 0


def test_fire_data_endpoints(client):
    incs = client.get("/api/incidents?min_count=5").json()["incidents"]
    assert incs
    fc = client.get(f"/api/incidents/{incs[0]['id']}/forecast?hours=6&members=4&model=uniform").json()
    assert fc["model"] == "uniform" and fc["stats"][-1]["horizon_h"] == 6
    r = client.get(f"/api/incidents/{incs[0]['id']}/forecast?hours=6&members=4")
    assert r.status_code == 200 and r.json()["model"] == "raster"
    assert client.get("/api/forecast/spread?lat=0&lon=0&fuel=XX").status_code == 400
    g = client.get("/api/danger/grid?bbox=-66,-33,-62,-29&n=3").json()
    assert len(g["features"]) == 9
    risk = client.get("/api/risk/ignition?bbox=-66,-33,-62,-29&n=3").json()
    assert len(risk["features"]) == 9
    assert client.get("/api/danger/grid?bbox=-180,-80,180,80").status_code == 400
    assert client.get("/api/detections?bbox=1,2,3").status_code == 400


def test_plan_limits_for_free_org(client):
    t = register(client, org="Tiny")
    h = bearer(t["token"])
    for i in range(3):
        assert client.post("/api/assets", headers=h, json={"name": f"a{i}", "geometry": square(i, 0, 0.01)}).status_code == 201
    r = client.post("/api/assets", headers=h, json={"name": "a4", "geometry": square(5, 0, 0.01)})
    assert r.status_code == 402 and "plan" in r.json()["detail"]
    org = client.get("/api/org", headers=h).json()
    assert org["usage"]["assets"] == 3 and org["limits"]["assets"] == 3


def test_purge_keeps_archive_within_retention(client):
    with SessionLocal() as s:
        s.add(Detection(id="ancient", source="MODIS", lat=0, lon=0, acq_time=utcnow() - timedelta(days=500)))
        s.add(Detection(id="last-month", source="MODIS", lat=0, lon=0, acq_time=utcnow() - timedelta(days=30)))
        s.commit()
    client.post("/api/ingest")
    with SessionLocal() as s:
        assert s.get(Detection, "ancient") is None and s.get(Detection, "last-month") is not None
