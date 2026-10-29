from urllib.parse import parse_qs, urlparse

import pytest
from conftest import bearer, register, square, unique_email

from firealerts.api.routers import auth as auth_routes
from firealerts.config import settings
from firealerts.security import decrypt_json, encrypt_json, hash_password, verify_password


@pytest.fixture()
def required():
    settings.auth_required = True
    yield
    settings.auth_required = False


def token_from(link: str) -> str:
    q = urlparse(link).query
    return parse_qs(q)["token"][0] if q else link.rsplit("/", 1)[-1]


def test_password_hashing_and_secret_encryption():
    h = hash_password("s3cret-pass")
    assert h.startswith("scrypt$") and verify_password("s3cret-pass", h) and not verify_password("x", h) and not verify_password("x", "garbage")
    enc = encrypt_json({"api_key": "abc"})
    assert "abc" not in enc and decrypt_json(enc) == {"api_key": "abc"} and decrypt_json("") == {}


def test_anonymous_mode(client):
    me = client.get("/api/me").json()
    assert me["authenticated"] is False and me["role"] == "owner" and me["org"]["plan"] == "enterprise"
    assert client.get("/api/assets").status_code == 200


def test_auth_required_blocks_anonymous(client, required):
    assert client.get("/api/detections").status_code == 401
    assert client.get("/api/assets").status_code == 401
    assert client.get("/api/me").json()["authenticated"] is False
    assert client.get("/api/health").status_code == 200 and client.get("/api/meta").status_code == 200


def test_register_verify_login_logout(client, required):
    email = unique_email("ana")
    reg = register(client, email, org="Ana Fire")
    assert reg["user"]["email_verified"] is False and reg["memberships"][0]["role"] == "owner"
    assert reg["memberships"][0]["plan"] == settings.default_plan
    assert client.post("/api/auth/register", json={"email": email.upper(), "password": "another one"}).status_code == 409
    tok = token_from(reg["verification"]["dev_link"])
    assert client.post("/api/auth/verify-email", json={"token": tok}).json()["verified"]
    assert client.post("/api/auth/verify-email", json={"token": tok}).status_code == 400  # single use
    login = client.post("/api/auth/login", json={"email": email, "password": "correct horse"}).json()
    assert login["user"]["email_verified"] is True
    h = bearer(login["token"])
    assert client.post("/api/auth/logout", headers=h).status_code == 204
    assert client.get("/api/assets", headers=h).status_code == 401


def test_forgot_and_reset_password_revokes_sessions(client):
    email = unique_email("reset")
    reg = register(client, email)
    old = bearer(reg["token"])
    r = client.post("/api/auth/forgot-password", json={"email": email}).json()
    assert r["accepted"] and "dev_link" in r
    assert client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"}).json() == {"accepted": True}
    new = client.post("/api/auth/reset-password", json={"token": token_from(r["dev_link"]), "password": "brand new pass"})
    assert new.status_code == 200
    assert client.get("/api/keys", headers=old).status_code == 401  # old session revoked
    assert client.post("/api/auth/login", json={"email": email, "password": "brand new pass"}).status_code == 200


def test_profile_password_change_and_delete(client):
    reg = register(client)
    h = bearer(reg["token"])
    assert client.patch("/api/me", headers=h, json={"name": "Renamed"}).json()["name"] == "Renamed"
    assert client.post("/api/me/password", headers=h, json={"current_password": "wrong", "new_password": "whatever123"}).status_code == 400
    assert client.post("/api/me/password", headers=h, json={"current_password": "correct horse", "new_password": "whatever123"}).json()["changed"]
    assert client.get("/api/keys", headers=h).status_code == 200  # current session survives
    assert client.delete("/api/me", headers=h).status_code == 204
    assert client.post("/api/auth/login", json={"email": reg["user"]["email"], "password": "whatever123"}).status_code == 401


def test_org_isolation(client, required):
    a, b = register(client, org="Alice Fire"), register(client, org="Bob Rescue")
    ha, hb = bearer(a["token"]), bearer(b["token"])
    asset = client.post("/api/assets", headers=ha, json={"name": "Ridge", "geometry": square(-64.5, -31.3)}).json()
    assert [x["name"] for x in client.get("/api/assets", headers=ha).json()] == ["Ridge"]
    assert client.get("/api/assets", headers=hb).json() == []
    for method, path in (("get", f"/api/assets/{asset['id']}"), ("delete", f"/api/assets/{asset['id']}"), ("get", f"/api/assets/{asset['id']}/summary")):
        assert getattr(client, method)(path, headers=hb).status_code == 404
    assert client.get("/api/assets", headers=bearer(a["token"], 999999)).status_code == 403


def test_invites_roles_and_keys(client, required):
    owner = register(client, org="Team")
    ho = bearer(owner["token"])
    invitee = unique_email("viewer")
    inv = client.post("/api/org/invites", headers=ho, json={"email": invitee, "role": "viewer"}).json()
    token = inv["invite_url"].rsplit("/", 1)[-1]
    assert client.get(f"/api/invites/{token}").json()["org_name"] == "Team"
    r = client.post("/api/auth/register", json={"email": unique_email("mallory"), "password": "password123", "invite_token": token})
    assert r.status_code == 403
    viewer = register(client, invitee, invite_token=token)
    assert viewer["user"]["email_verified"] is True  # invite proves the address
    team = [m for m in viewer["memberships"] if m["org_name"] == "Team"][0]
    hv = bearer(viewer["token"], team["org_id"])
    assert client.get("/api/assets", headers=hv).status_code == 200
    assert client.post("/api/assets", headers=hv, json={"name": "x", "geometry": square(0, 0)}).status_code == 403
    assert client.post("/api/connectors", headers=hv, json={"type": "slack", "name": "x", "config": {"webhook_url": "https://x"}}).status_code == 403
    members = client.get("/api/org/members", headers=ho).json()["members"]
    vid = [m for m in members if m["email"] == invitee][0]["user_id"]
    oid = [m for m in members if m["email"] == owner["user"]["email"]][0]["user_id"]
    assert client.patch(f"/api/org/members/{vid}", headers=ho, json={"role": "member"}).json()["role"] == "member"
    assert client.post("/api/assets", headers=hv, json={"name": "x", "geometry": square(0, 0)}).status_code == 201
    assert client.patch(f"/api/org/members/{oid}", headers=ho, json={"role": "admin"}).status_code == 400  # last owner
    key = client.post("/api/keys", headers=ho, json={"name": "dispatch"}).json()["key"]
    assert key.startswith("fa_") and client.get("/api/detections?hours=1", headers=bearer(key)).status_code == 200
    kid = client.get("/api/keys", headers=ho).json()[0]["id"]
    assert client.delete(f"/api/keys/{kid}", headers=ho).status_code == 204
    assert client.get("/api/detections?hours=1", headers=bearer(key)).status_code == 401
    audit = client.get("/api/org/audit", headers=ho).json()
    assert {"invite.create", "member.role", "api_key.create", "api_key.delete"} <= {e["action"] for e in audit}


def test_login_throttling(client):
    reg = register(client)
    email = reg["user"]["email"]
    codes = [client.post("/api/auth/login", json={"email": email, "password": "nope"}).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    auth_routes._failures.clear()


def test_email_verification_can_be_required(client, required):
    settings.require_email_verification = True
    try:
        reg = register(client)
        assert client.get("/api/assets", headers=bearer(reg["token"])).status_code == 403
        client.post("/api/auth/verify-email", json={"token": token_from(reg["verification"]["dev_link"])})
        assert client.get("/api/assets", headers=bearer(reg["token"])).status_code == 200
    finally:
        settings.require_email_verification = False


def test_superuser_admin(client):
    plain = register(client)
    assert client.get("/api/admin/stats", headers=bearer(plain["token"])).status_code == 403
    root = register(client, "root@example.com")
    assert root["user"]["is_superuser"]
    h = bearer(root["token"])
    stats = client.get("/api/admin/stats", headers=h).json()
    assert stats["users"] >= 2 and "free" in stats["plans"]
    org_id = plain["memberships"][0]["org_id"]
    assert client.patch(f"/api/admin/orgs/{org_id}", headers=h, json={"plan": "pro"}).json()["plan"] == "pro"
    assert client.patch(f"/api/admin/orgs/{org_id}", headers=h, json={"plan": "platinum"}).status_code == 422
    assert client.get("/api/admin/users?q=root", headers=h).json()[0]["email"] == "root@example.com"
    # Support access: a superuser may act inside another organisation.
    assert client.get("/api/org", headers=bearer(root["token"], org_id)).json()["id"] == org_id
