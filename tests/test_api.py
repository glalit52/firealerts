from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from firealerts.db import Detection, SessionLocal, utcnow
from firealerts.main import app
from firealerts.sources import demo


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_aoi_alert_flow_and_incident_forecast(client):
    # Watch an area around one demo fire *before* the first ingest so new detections alert.
    fresh = [d for d in demo.generate() if d["acq_time"] >= utcnow() - timedelta(hours=5)]
    target = fresh[0]
    r = client.post("/api/aois", json={"name": "Ranch", "center": [target["lat"], target["lon"]], "radius_km": 5, "min_confidence": "l"})
    assert r.status_code == 201, r.text

    run = client.post("/api/ingest").json()
    assert run["mode"] == "demo" and run["inserted"] > 100 and run["alerts"] >= 1

    again = client.post("/api/ingest").json()
    assert again["inserted"] == 0  # de-duplicated

    alerts = client.get("/api/alerts").json()
    assert alerts[0]["aoi_name"] == "Ranch" and alerts[0]["count"] >= 1

    status = client.get("/api/status").json()
    assert status["detections_24h"] > 100 and status["active_mode"] == "demo"

    fc = client.get("/api/detections?hours=24&bbox=-180,-90,180,90").json()
    assert fc["features"] and fc["features"][0]["geometry"]["type"] == "Point"

    incs = client.get("/api/incidents?min_count=5").json()["incidents"]
    assert incs and incs[0]["priority"] >= incs[-1]["priority"]

    detail = client.get(f"/api/incidents/{incs[0]['id']}").json()
    assert detail["detections"] and detail["timeline"]

    fc = client.get(f"/api/incidents/{incs[0]['id']}/forecast?hours=12&members=8").json()
    assert fc["perimeters"]["features"] and fc["stats"][-1]["horizon_h"] == 12
    assert fc["weather_source"] == "demo"
    assert fc["model"] == "raster" and fc["terrain"]["source"] == "synthetic" and fc["images"]["arrival"]

    uni = client.get(f"/api/incidents/{incs[0]['id']}/forecast?hours=6&members=4&model=uniform").json()
    assert uni["model"] == "uniform" and uni["burn_probability"]["features"]
    assert client.get(f"/api/incidents/{incs[0]['id']}/forecast?model=bogus").status_code == 400


def test_point_forecast_and_danger(client):
    r = client.get("/api/forecast/spread?lat=39.7&lon=-121.6&fuel=C7&hours=6&members=4")
    assert r.status_code == 200 and r.json()["fuel"]["code"] == "C7"
    assert client.get("/api/forecast/spread?lat=0&lon=0&fuel=XX").status_code == 400

    d = client.get("/api/danger?lat=-31.3&lon=-64.5").json()
    assert d["days"] and "fwi" in d["days"][0]

    g = client.get("/api/danger/grid?bbox=-66,-33,-62,-29&n=3").json()
    assert len(g["features"]) == 9 and len(g["dates"]) == len(g["features"][0]["properties"]["fwi"])
    assert client.get("/api/danger/grid?bbox=-180,-80,180,80").status_code == 400

    risk = client.get("/api/risk/ignition?bbox=-66,-33,-62,-29&n=3").json()
    assert len(risk["features"]) == 9 and risk["model"]["kind"] in ("baseline", "trained")
    p = risk["features"][0]["properties"]["p"]
    assert len(p) == len(risk["dates"]) and all(0 <= v <= 1 for v in p)
    assert client.get("/api/risk/model").json()["features"]


def test_aoi_validation_and_delete(client):
    assert client.post("/api/aois", json={"name": "bad"}).status_code == 400
    poly = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
    a = client.post("/api/aois", json={"name": "Poly", "geometry": poly, "buffer_km": 2}).json()
    assert client.delete(f"/api/aois/{a['id']}").status_code == 204
    assert client.delete(f"/api/aois/{a['id']}").status_code == 404


def test_old_detections_are_purged(client):
    with SessionLocal() as s:
        s.add(Detection(id="old", source="MODIS", lat=0, lon=0, acq_time=utcnow() - timedelta(days=10)))
        s.commit()
    client.post("/api/ingest")
    with SessionLocal() as s:
        assert s.get(Detection, "old") is None
