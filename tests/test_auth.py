import pytest
from fastapi.testclient import TestClient

from firealerts import auth
from firealerts.config import settings
from firealerts.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def required():
    settings.auth_required = True
    yield
    settings.auth_required = False


def register(client, email, org="Brigade", **extra):
    r = client.post("/api/auth/register", json={"email": email, "password": "correct horse", "name": email.split("@")[0], "org_name": org, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def bearer(token, org=None):
    h = {"authorization": f"Bearer {token}"}
    if org:
        h["x-org-id"] = str(org)
    return h


def test_password_hashing():
    h = auth.hash_password("s3cret-pass")
    assert h.startswith("scrypt$") and "s3cret" not in h
    assert auth.verify_password("s3cret-pass", h)
    assert not auth.verify_password("wrong", h)
    assert not auth.verify_password("x", "garbage")


def test_anonymous_mode_still_works(client):
    me = client.get("/api/me").json()
    assert me["authenticated"] is False and me["role"] == "owner" and me["org"]["name"] == "Default organization"
    assert client.get("/api/aois").status_code == 200


def test_auth_required_blocks_anonymous(client, required):
    assert client.get("/api/detections").status_code == 401
    assert client.get("/api/aois").status_code == 401
    me = client.get("/api/me").json()
    assert me == {**me, "authenticated": False, "auth_required": True}
    assert client.get("/api/status").status_code == 200  # health stays public


def test_register_login_and_org_isolation(client, required):
    a = register(client, "alice@example.com", "Alice Fire")
    b = register(client, "bob@example.com", "Bob Rescue")
    ha, hb = bearer(a["token"]), bearer(b["token"])
    assert client.post("/api/auth/register", json={"email": "ALICE@example.com", "password": "another one"}).status_code == 409

    r = client.post("/api/aois", headers=ha, json={"name": "Ridge", "center": [-31.3, -64.5], "radius_km": 5})
    assert r.status_code == 201
    aoi_id = r.json()["id"]
    assert [x["name"] for x in client.get("/api/aois", headers=ha).json()] == ["Ridge"]
    assert client.get("/api/aois", headers=hb).json() == []
    assert client.delete(f"/api/aois/{aoi_id}", headers=hb).status_code == 404  # cannot touch other orgs
    assert client.get(f"/api/aois/{aoi_id}/detections", headers=hb).status_code == 404

    login = client.post("/api/auth/login", json={"email": "alice@example.com", "password": "correct horse"})
    assert login.status_code == 200 and login.json()["memberships"][0]["role"] == "owner"
    tok = login.json()["token"]
    assert client.post("/api/auth/logout", headers=bearer(tok)).status_code == 204
    assert client.get("/api/aois", headers=bearer(tok)).status_code == 401


def test_invites_roles_and_keys(client, required):
    owner = register(client, "owner@example.com", "Team")
    ho = bearer(owner["token"])
    inv = client.post("/api/org/invites", headers=ho, json={"email": "viewer@example.com", "role": "viewer"}).json()
    token = inv["invite_url"].split("invite=")[1]
    assert client.get(f"/api/invites/{token}").json()["org_name"] == "Team"

    # Wrong e-mail cannot use the invite.
    r = client.post("/api/auth/register", json={"email": "mallory@example.com", "password": "password123", "invite_token": token})
    assert r.status_code == 403

    viewer = register(client, "viewer@example.com", invite_token=token)
    team = [m for m in viewer["memberships"] if m["org_name"] == "Team"][0]
    hv = bearer(viewer["token"], team["org_id"])
    assert client.get("/api/aois", headers=hv).status_code == 200
    assert client.post("/api/aois", headers=hv, json={"name": "x", "center": [0, 0], "radius_km": 1}).status_code == 403
    assert client.post("/api/org/invites", headers=hv, json={"email": "z@example.com"}).status_code == 403

    members = client.get("/api/org/members", headers=ho).json()["members"]
    vid = [m for m in members if m["email"] == "viewer@example.com"][0]["user_id"]
    oid = [m for m in members if m["email"] == "owner@example.com"][0]["user_id"]
    assert client.patch(f"/api/org/members/{vid}", headers=ho, json={"role": "member"}).json()["role"] == "member"
    assert client.post("/api/aois", headers=hv, json={"name": "x", "center": [0, 0], "radius_km": 1}).status_code == 201
    assert client.patch(f"/api/org/members/{oid}", headers=ho, json={"role": "admin"}).status_code == 400  # last owner

    key = client.post("/api/keys", headers=ho, json={"name": "dispatch"}).json()["key"]
    assert key.startswith("fa_")
    assert client.get("/api/detections?hours=1", headers=bearer(key)).status_code == 200
    kid = client.get("/api/keys", headers=ho).json()[0]["id"]
    assert client.delete(f"/api/keys/{kid}", headers=ho).status_code == 204
    assert client.get("/api/detections?hours=1", headers=bearer(key)).status_code == 401


def test_login_throttling(client):
    register(client, "throttle@example.com")
    codes = [client.post("/api/auth/login", json={"email": "throttle@example.com", "password": "nope"}).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    auth._failures.clear()


def test_x_org_id_must_be_a_membership(client, required):
    a = register(client, "solo@example.com", "Solo")
    assert client.get("/api/aois", headers=bearer(a["token"], 999999)).status_code == 403
