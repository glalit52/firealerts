import os
import sys
import tempfile

_tmp = tempfile.mkdtemp(prefix="firealerts-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp}/test.db")
os.environ["DATA_MODE"] = "demo"
os.environ["SCHEDULER_ENABLED"] = "0"
os.environ["GOES_ENABLED"] = "0"
os.environ["MODEL_PATH"] = f"{_tmp}/no-model.joblib"
os.environ["SECRET_KEY"] = "test-secret-key-for-encryption"
os.environ["DEV_EXPOSE_EMAIL_LINKS"] = "1"
os.environ["SUPERUSER_EMAILS"] = "root@example.com"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import itertools  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402

_seq = itertools.count()


def unique_email(prefix: str = "user") -> str:
    return f"{prefix}{next(_seq)}-{os.getpid()}@example.com"


class Recorder:
    """httpx MockTransport that records requests and answers 200."""

    def __init__(self, status: int = 200, body=None):
        self.requests: list[httpx.Request] = []
        self.status = status
        self.body = body if body is not None else {"ok": True}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


@pytest.fixture()
def recorder():
    return Recorder()


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from firealerts.main import app

    with TestClient(app) as c:
        yield c


def register(client, email=None, password="correct horse", org="Brigade", **extra) -> dict:
    email = email or unique_email()
    r = client.post("/api/auth/register", json={"email": email, "password": password, "name": email.split("@")[0], "org_name": org, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def bearer(token, org=None) -> dict:
    h = {"authorization": f"Bearer {token}"}
    if org:
        h["x-org-id"] = str(org)
    return h


def square(lon: float, lat: float, d: float = 0.05) -> dict:
    return {"type": "Polygon", "coordinates": [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]]}
