"""Static-source filtering, wind, public map, history/stats, Web Push, voice calls and translated alerts."""

import asyncio
import json
from datetime import timedelta
from urllib.parse import parse_qs

import pytest
from conftest import Recorder, bearer, register, square
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from firealerts.config import settings
from firealerts.db import SessionLocal, init_db, utcnow
from firealerts.integrations import notify, webpush
from firealerts.models import Alert, Asset, Detection, Organization, PushSubscription, StaticSource
from firealerts.services import alerting, i18n, static_sources
from firealerts.services import assets as asset_svc

init_db()


def det(i, lat, lon, minutes_ago=10, frp=10.0):
    return Detection(id=f"p{i}-{lat}-{lon}-{minutes_ago}", source="VIIRS_NOAA20", lat=lat, lon=lon, acq_time=utcnow() - timedelta(minutes=minutes_ago), confidence="h", frp=frp)


# ----------------------------------------------------------------------------- static sources


def test_curated_volcano_and_learned_persistent_source():
    with SessionLocal() as s:
        static_sources.invalidate()
        hit = static_sources.classify(s, 13.601, 40.671)
        assert hit["type"] == "volcano" and hit["name"] == "Erta Ale"
        assert static_sources.classify(s, 0.0, 0.0) is None
        # A flare stack burning on 9 distinct days becomes a learned persistent source.
        for d in range(9):
            s.add(Detection(id=f"flare-{d}", source="VIIRS_NOAA20", lat=5.0101, lon=6.3001, acq_time=utcnow() - timedelta(days=d, hours=1), confidence="h", frp=20))
        s.add(Detection(id="once", source="VIIRS_NOAA20", lat=-20.0, lon=-50.0, acq_time=utcnow() - timedelta(days=1)))
        s.commit()
        assert static_sources.learn(s) >= 1
        assert static_sources.classify(s, 5.0102, 6.3002)["type"] == "persistent"
        assert static_sources.classify(s, -20.0, -50.0) is None


def test_static_detections_do_not_alert():
    rec = Recorder()
    with SessionLocal() as s:
        org = Organization(name="Volcano watchers", plan="pro")
        s.add(org)
        s.flush()
        a = Asset(org_id=org.id, name="Near Villarrica", buffer_km=5)
        asset_svc.apply_geometry(a, square(-71.93, -39.42, 0.05))
        s.add(a)
        s.commit()
        assert asyncio.run(alerting.on_new_detections(s, rec.client(), [det(1, -39.4205, -71.9395)])) == 0
        assert asyncio.run(alerting.on_new_detections(s, rec.client(), [det(2, -39.42, -71.85)])) == 1  # ~7 km from the vent: a real fire


def test_incidents_and_features_are_tagged(client):
    client.post("/api/ingest")  # demo data includes the Villarrica lava lake
    incs = client.get("/api/incidents?bbox=-73,-41,-70,-38").json()["incidents"]
    volcano = [i for i in incs if i["static_source"]]
    assert volcano and volcano[0]["static_source"]["type"] == "volcano" and volcano[0]["priority"] <= 20
    feats = client.get("/api/detections?bbox=-73,-41,-70,-38&hours=24").json()["features"]
    assert any(f["properties"]["static_source"] == "volcano" for f in feats)
    assert client.get("/api/static-sources?bbox=-73,-41,-70,-38").json()[0]["name"] == "Villarrica"


# ----------------------------------------------------------------------------- wind, history, stats


def test_wind_grid(client):
    w = client.get("/api/weather/wind?bbox=-66,-34,-62,-30&n=3").json()
    assert len(w["features"]) == 9 and len(w["hours"]) == 17
    props = w["features"][0]["properties"]
    assert len(props["speed"]) == len(props["dir"]) == 17
    assert client.get("/api/weather/wind?bbox=-180,-80,180,80").status_code == 400


def test_history_range_and_stats(client):
    end = utcnow()
    start = end - timedelta(days=2)
    r = client.get("/api/detections", params={"from": start.isoformat(), "to": end.isoformat()})
    assert r.status_code == 200 and r.json()["features"]
    assert client.get("/api/detections", params={"from": (end - timedelta(days=40)).isoformat()}).status_code == 400
    assert client.get("/api/detections", params={"from": "yesterday"}).status_code == 400
    st = client.get("/api/stats/fires?days=7").json()
    assert st["total"] > 0 and st["daily"] and sum(st["by_source"].values()) == st["total"]


# ----------------------------------------------------------------------------- public map


def test_public_map(client):
    settings.auth_required = True
    try:
        assert client.get("/api/detections").status_code == 401
        assert client.get("/api/public/status").json()["detections_24h"] > 0
        fc = client.get("/api/public/detections?bbox=-180,-60,-120,-20&hours=24")
        assert fc.status_code == 200
        assert client.get("/api/public/detections?bbox=-180,-90,180,90").status_code == 400  # too large
        assert client.get("/api/public/detections").status_code == 422  # bbox required
        assert "incidents" in client.get("/api/public/incidents?bbox=-66,-34,-62,-29").json()
        assert client.get("/api/public/wind?bbox=-66,-34,-62,-30&n=2").status_code == 200
        assert client.get("/api/meta").json()["public_map"] is True
        settings.public_map = False
        assert client.get("/api/public/status").status_code == 404
    finally:
        settings.auth_required = False
        settings.public_map = True


def test_public_rate_limit(client):
    from firealerts.api.routers import public

    public._hits.clear()
    codes = [client.get("/api/public/status", headers={"x-forwarded-for": "203.0.113.9"}).status_code for _ in range(public.LIMIT_PER_MIN + 1)]
    assert codes[-1] == 429 and codes[0] == 200
    public._hits.clear()


# ----------------------------------------------------------------------------- web push & voice


def test_webpush_encryption_roundtrip_and_vapid_jwt():
    ua = ec.generate_private_key(ec.SECP256R1())
    pub = webpush.b64u(webpush._raw_public(ua.public_key()))
    auth = webpush.b64u(b"0123456789abcdef")
    body = webpush.encrypt(b'{"title":"x"}', pub, auth)
    assert body[16:20] == (4096).to_bytes(4, "big") and body[20] == 65
    assert webpush.decrypt(body, ua, auth) == b'{"title":"x"}'
    header = webpush.vapid_header("https://updates.push.services.mozilla.com/wpush/v2/abc", "mailto:ops@example.com")
    token = header.split("t=")[1].split(",")[0]
    h, c, sig = token.split(".")
    raw = webpush.b64u_decode(sig)
    webpush.vapid_private_key().public_key().verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")), f"{h}.{c}".encode(), ec.ECDSA(hashes.SHA256()))
    assert json.loads(webpush.b64u_decode(c))["aud"] == "https://updates.push.services.mozilla.com"
    assert header.endswith("k=" + webpush.vapid_public_key()) and len(webpush.b64u_decode(webpush.vapid_public_key())) == 65


def _subscription():
    ua = ec.generate_private_key(ec.SECP256R1())
    return {"endpoint": "https://fcm.googleapis.com/fcm/send/device-1", "keys": {"p256dh": webpush.b64u(webpush._raw_public(ua.public_key())), "auth": webpush.b64u(b"authsecret123456")}}


def test_push_subscription_api_and_test_send(client):
    t = register(client)
    h = bearer(t["token"])
    key = client.get("/api/push/vapid-public-key").json()
    assert key["enabled"] and key["key"] == webpush.vapid_public_key()
    sub = _subscription()
    assert client.post("/api/push/subscriptions", headers=h, json=sub).status_code == 201
    assert client.post("/api/push/subscriptions", headers=h, json={**sub, "endpoint": "http://insecure"}).status_code == 422
    listed = client.get("/api/push/subscriptions", headers=h).json()
    assert len(listed) == 1 and listed[0]["endpoint_host"] == "fcm.googleapis.com"
    rec = Recorder(status=201)
    original = client.app.state.client
    client.app.state.client = rec.client()
    try:
        assert client.post("/api/push/test", headers=h).json() == {"sent": 1, "failed": 0}
    finally:
        client.app.state.client = original
    req = rec.requests[0]
    assert req.headers["content-encoding"] == "aes128gcm" and req.headers["authorization"].startswith("vapid t=")
    assert client.request("DELETE", "/api/push/subscriptions", headers=h, json={"endpoint": sub["endpoint"]}).status_code == 204
    assert client.get("/api/push/subscriptions", headers=h).json() == []


def test_push_channel_removes_gone_devices():
    with SessionLocal() as s:
        from firealerts.models import Membership, User

        org = Organization(name="Push org", plan="pro")
        u = User(email="push-member@example.com", password_hash="x")
        s.add_all([org, u])
        s.flush()
        s.add(Membership(user_id=u.id, org_id=org.id, role="member"))
        sub = _subscription()
        from firealerts.security import sha256

        s.add(PushSubscription(user_id=u.id, endpoint=sub["endpoint"] + "-gone", endpoint_hash=sha256(sub["endpoint"] + "-gone"), p256dh=sub["keys"]["p256dh"], auth=sub["keys"]["auth"]))
        from firealerts.models import Connector
        from firealerts.security import encrypt_json

        s.add(Connector(org_id=org.id, type="push", name="Mobile push", config_enc=encrypt_json({})))
        alert = Alert(org_id=org.id, type="detection", severity="high", title="t", dedupe_key="push-test")
        s.add(alert)
        s.commit()
        results = asyncio.run(alerting.dispatch(s, Recorder(status=410).client(), alert))
        s.commit()
        assert results[0]["status"].startswith("error") and s.query(PushSubscription).filter(PushSubscription.user_id == u.id).count() == 0


def test_voice_call_twiml_in_org_language():
    rec = Recorder()
    msg = notify.Message(title="Fuego cerca", text="Detalle", severity="critical", language="es")
    asyncio.run(notify.twilio_voice(rec.client(), {"account_sid": "AC1", "auth_token": "t", "from_number": "+1", "to": ["+5491"]}, msg))
    form = parse_qs(rec.requests[0].content.decode())
    assert "/Calls.json" in str(rec.requests[0].url) and 'language="es-MX"' in form["Twiml"][0] and "Fuego cerca" in form["Twiml"][0]


# ----------------------------------------------------------------------------- translations


def test_translation_tables_are_complete():
    for key, entry in i18n.T.items():
        assert set(entry) == set(i18n.LANGUAGES), key
    assert i18n.plural("es", "det.title", 3, where="dentro de X") == "3 focos de calor dentro de X"
    assert i18n.plural("en", "det.title", 1, where="inside X") == "1 fire detection inside X"
    assert i18n.t("de", "open") == "Open in Firealerts"  # unknown languages fall back to English


def test_alerts_follow_org_language(client):
    t = register(client, language="pt")
    h = bearer(t["token"])
    assert client.get("/api/me", headers=h).json()["user"]["language"] == "pt"
    assert client.get("/api/org", headers=h).json()["settings"]["language"] == "pt"
    assert client.patch("/api/org", headers=h, json={"settings": {"language": "es"}}).json()["settings"]["language"] == "es"
    assert client.patch("/api/org", headers=h, json={"settings": {"language": "fr"}}).status_code == 422
    assert client.patch("/api/me", headers=h, json={"language": "es"}).json()["language"] == "es"
    assert client.patch("/api/me", headers=h, json={"language": "xx"}).status_code == 422
    with SessionLocal() as s:
        org_id = t["memberships"][0]["org_id"]
        a = Asset(org_id=org_id, name="Bosque Norte", buffer_km=1)
        asset_svc.apply_geometry(a, square(-58.0, -27.0, 0.02))
        s.add(a)
        s.commit()
        asyncio.run(alerting.on_new_detections(s, Recorder().client(), [det(77, -27.0, -58.0)]))
        alert = s.query(Alert).filter(Alert.asset_id == a.id).one()
    assert alert.title == "1 foco de calor dentro de Bosque Norte" and "Los satélites detectaron" in alert.message


def test_meta_lists_new_capabilities(client):
    meta = client.get("/api/meta").json()
    assert meta["languages"] == ["en", "es", "pt"] and meta["push_enabled"]
    assert {"push", "twilio_voice"} <= set(meta["connector_types"])
