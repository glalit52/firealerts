import asyncio
import hashlib
import hmac
from datetime import datetime, timedelta, timezone

import pytest
from conftest import Recorder, square

from firealerts.db import SessionLocal, init_db, utcnow
from firealerts.geo import circle_ring
from firealerts.models import Alert, Asset, Connector, Detection, NotificationRule, Organization
from firealerts.security import encrypt_json
from firealerts.services import alerting
from firealerts.services import assets as asset_svc

init_db()


def det(i, lat, lon, conf="n", frp=5.0, minutes_ago=10):
    return Detection(id=f"t{i}-{lat}-{lon}-{minutes_ago}", source="VIIRS_NOAA20", lat=lat, lon=lon, acq_time=utcnow() - timedelta(minutes=minutes_ago), confidence=conf, frp=frp)


def make_org_asset(session, geometry=None, **kw):
    org = Organization(name="Test org", plan="pro")
    session.add(org)
    session.flush()
    a = Asset(org_id=org.id, name="Pine Ridge", **kw)
    asset_svc.apply_geometry(a, geometry or square(10.0, 45.0, 0.02))
    session.add(a)
    session.flush()
    return org, a


def webhook(session, org, secret="topsecret"):
    c = Connector(org_id=org.id, type="webhook", name="hook", config_enc=encrypt_json({"url": "https://hooks.example.com/x", "secret": secret}))
    session.add(c)
    session.flush()
    return c


def test_match_respects_buffer_and_confidence():
    a = Asset(name="x", buffer_km=3, min_confidence="n")
    asset_svc.apply_geometry(a, {"type": "Polygon", "coordinates": [circle_ring(-31.3, -64.5, 5)]})
    dets = [det(0, -31.3, -64.5), det(1, -31.3 + 7 / 111, -64.5), det(2, -31.3 + 20 / 111, -64.5), det(3, -31.3, -64.5, conf="l")]
    hits = {d.id: km for d, km in asset_svc.match_detections(a, dets)}
    assert set(hits) == {dets[0].id, dets[1].id}
    assert hits[dets[0].id] == 0 and 1.5 < hits[dets[1].id] < 2.5


def test_multipolygon_with_hole_matching():
    g = {"type": "MultiPolygon", "coordinates": [
        [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]], [[0.04, 0.04], [0.06, 0.04], [0.06, 0.06], [0.04, 0.06], [0.04, 0.04]]],
        [[[1, 1], [1.1, 1], [1.1, 1.1], [1, 1.1], [1, 1]]],
    ]}
    a = Asset(name="m", buffer_km=0, min_confidence="l")
    asset_svc.apply_geometry(a, g)
    hits = {d.id for d, _ in asset_svc.match_detections(a, [det(0, 0.02, 0.02), det(1, 0.05, 0.05), det(2, 1.05, 1.05)])}
    assert hits == {"t0-0.02-0.02-10", "t2-1.05-1.05-10"}


def test_detection_alert_dedupes_escalates_and_signs_webhook():
    rec = Recorder()
    with SessionLocal() as s:
        org, a = make_org_asset(s, buffer_km=2)
        webhook(s, org)
        s.commit()
        client = rec.client()
        n = asyncio.run(alerting.on_new_detections(s, client, [det(1, 45.0, 10.0, frp=20)]))
        alert = s.scalar(__import__("sqlalchemy").select(Alert).where(Alert.asset_id == a.id))
        assert n == 1 and alert.type == "detection" and alert.severity == "high" and alert.data["count"] == 1
        assert len(rec.requests) == 1
        req = rec.requests[0]
        body = req.content
        expected = "sha256=" + hmac.new(b"topsecret", req.headers["X-Firealerts-Timestamp"].encode() + b"." + body, hashlib.sha256).hexdigest()
        assert req.headers["X-Firealerts-Signature"] == expected

        # Same severity: updated, not re-notified.
        asyncio.run(alerting.on_new_detections(s, client, [det(2, 45.001, 10.001, frp=10)]))
        s.refresh(alert)
        assert alert.data["count"] == 2 and len(rec.requests) == 1
        # Escalation to critical (>= 5 inside): re-notified, same alert.
        asyncio.run(alerting.on_new_detections(s, client, [det(10 + i, 45.0 + i * 0.001, 10.0, frp=30) for i in range(5)]))
        s.refresh(alert)
        assert alert.severity == "critical" and len(rec.requests) == 2
        assert s.query(Alert).filter(Alert.asset_id == a.id).count() == 1
        assert len(alert.deliveries) == 2 and alert.deliveries[0]["status"] == "ok"


def test_stale_detections_never_alert():
    rec = Recorder()
    with SessionLocal() as s:
        org, a = make_org_asset(s, geometry=square(20.0, 10.0, 0.02))
        s.commit()
        assert asyncio.run(alerting.on_new_detections(s, rec.client(), [det(1, 10.0, 20.0, minutes_ago=60 * 8)])) == 0


def test_rules_route_by_type_severity_and_asset():
    with SessionLocal() as s:
        org, a = make_org_asset(s, geometry=square(30.0, 10.0, 0.02))
        hook = webhook(s, org)
        alert = Alert(org_id=org.id, asset_id=a.id, type="detection", severity="moderate", title="t", dedupe_key="k")
        s.add(alert)
        s.flush()
        assert [c.id for c in alerting.route(s, alert)] == [hook.id]  # default routing: moderate+ to all
        s.add(NotificationRule(org_id=org.id, name="threats only", alert_types=["threat"], min_severity="low", connector_ids=[hook.id]))
        s.flush()
        assert alerting.route(s, alert) == []
        s.add(NotificationRule(org_id=org.id, name="this asset, high+", asset_ids=[a.id], alert_types=["detection"], min_severity="high", connector_ids=[hook.id]))
        s.flush()
        assert alerting.route(s, alert) == []
        alert.severity = "critical"
        assert [c.id for c in alerting.route(s, alert)] == [hook.id]
        s.rollback()


def test_eta_from_forecast_perimeters():
    a = Asset(name="target")
    asset_svc.apply_geometry(a, square(0.1, 0.0, 0.01))
    ring = lambda r: [[-r, -r], [r, -r], [r, r], [-r, r], [-r, -r]]  # noqa: E731
    result = {"perimeters": {"features": [
        {"properties": {"horizon_h": 3, "kind": "likely"}, "geometry": {"coordinates": [ring(0.02)]}},
        {"properties": {"horizon_h": 3, "kind": "p90"}, "geometry": {"coordinates": [ring(0.095)]}},
        {"properties": {"horizon_h": 6, "kind": "likely"}, "geometry": {"coordinates": [ring(0.095)]}},
        {"properties": {"horizon_h": 6, "kind": "p90"}, "geometry": {"coordinates": [ring(0.2)]}},
    ]}}
    assert alerting._eta(result, a) == (6, 3)


def test_check_threats_creates_predictive_alert(monkeypatch):
    from firealerts.services import incidents as incident_svc
    from firealerts.science.cluster import Hotspot, Incident

    with SessionLocal() as s:
        org, a = make_org_asset(s, geometry=square(50.1, 0.0, 0.02), threat_radius_km=40)
        s.commit()
    inc = Incident("inc1", [Hotspot("h1", 0.0, 50.0, datetime.now(timezone.utc), "VIIRS_NOAA20", 50.0, "h", 375)])
    summary = inc.summary()
    monkeypatch.setattr(incident_svc, "incidents", lambda session, hours=24: ({"inc1": inc}, {"inc1": summary}))
    ring = [[49.9, -0.1], [50.2, -0.1], [50.2, 0.1], [49.9, 0.1], [49.9, -0.1]]
    fake = {"perimeters": {"features": [{"properties": {"horizon_h": 6, "kind": "likely"}, "geometry": {"coordinates": [ring]}}]}}
    monkeypatch.setattr(alerting.spread, "forecast", lambda inp: fake)
    with SessionLocal() as s:
        n = asyncio.run(alerting.check_threats(s, Recorder().client()))
        alert = s.query(Alert).filter(Alert.asset_id == a.id, Alert.type == "threat").one()
    assert n == 1 and alert.severity == "critical" and alert.data["eta_likely_h"] == 6 and "~6 h" in alert.title


def test_risk_alert_threshold():
    with SessionLocal() as s:
        org, a = make_org_asset(s, geometry=square(60.0, 10.0, 0.02), risk_min_danger="very_high")
        s.commit()
        base = {"temp": 35, "rh": 15, "wind": 30, "forecast": True, "ignition_p": 0.12}
        low = [dict(base, date=f"2030-01-0{i}", fwi=30, danger="high") for i in range(1, 4)]
        assert not asyncio.run(alerting.raise_risk_alert(s, Recorder().client(), a, low))
        high = low[:1] + [dict(base, date="2030-01-02", fwi=45, danger="very_high")]
        assert asyncio.run(alerting.raise_risk_alert(s, Recorder().client(), a, high))
        alert = s.query(Alert).filter(Alert.asset_id == a.id, Alert.type == "risk").one()
        assert alert.severity == "high" and "2030-01-02" in alert.title and alert.data["ignition_p"] == 0.12
