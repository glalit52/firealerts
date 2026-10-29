import asyncio
from datetime import timedelta

from conftest import Recorder, square

from firealerts import worker
from firealerts.db import SessionLocal, init_db, utcnow
from firealerts.models import Alert, Asset, AssetRisk, AuthToken, Organization, User
from firealerts.services import assets as asset_svc
from firealerts.sources import demo

init_db()


def test_jobs_run_end_to_end(monkeypatch):
    fresh = [d for d in demo.generate() if d["acq_time"] >= utcnow() - timedelta(hours=5)]
    with SessionLocal() as s:
        org = Organization(name="Worker org", plan="pro")
        s.add(org)
        s.flush()
        a = Asset(org_id=org.id, name="Worker forest", risk_min_danger="very_low")
        asset_svc.apply_geometry(a, square(fresh[-1]["lon"], fresh[-1]["lat"], 0.05))
        s.add(a)
        u = User(email="worker-test@example.com", password_hash="x")
        s.add(u)
        s.flush()
        s.add(AuthToken(token_hash="x" * 64, user_id=u.id, kind="session", expires_at=utcnow() - timedelta(days=1)))
        s.commit()
        aid = a.id

    # Sentinel-2 is network-bound: stub the analysis for the vegetation job.
    async def fake_refresh(session, client, asset, days=30, max_new=3):
        return {"scenes_found": 0, "analysed": 0}

    monkeypatch.setattr(worker.intel, "refresh_vegetation", fake_refresh)
    client = Recorder().client()
    assert "inserted=" in asyncio.run(worker.job_ingest(client))
    assert "assets=" in asyncio.run(worker.job_risk(client))
    assert "scenes analysed=" in asyncio.run(worker.job_vegetation(client))
    assert "skipped" in asyncio.run(worker.job_digest(client))
    assert asyncio.run(worker.job_cleanup(client)) == "ok"
    with SessionLocal() as s:
        assert s.query(AssetRisk).filter(AssetRisk.asset_id == aid).count() >= 7
        types = {x.type for x in s.query(Alert).filter(Alert.asset_id == aid)}
        assert "risk" in types  # threshold very_low always triggers
        assert s.query(AuthToken).filter(AuthToken.token_hash == "x" * 64).count() == 0


def test_scheduler_loop_stops():
    stop = asyncio.Event()

    async def run():
        calls = []

        async def fake(client):
            calls.append(1)
            stop.set()
            return "ok"

        monkey = [worker.Job("ingest", 3600, fake)]  # the ingest slot runs immediately
        orig = worker.jobs
        worker.jobs = lambda: monkey
        try:
            await asyncio.wait_for(worker.run_forever(Recorder().client(), stop), timeout=10)
        finally:
            worker.jobs = orig
        return calls

    assert asyncio.run(run()) == [1]


def test_cli_create_user_and_set_plan(capsys):
    from firealerts import cli

    cli.main(["create-user", "cli-admin@example.com", "--password", "longenough1", "--superuser", "--org", "CLI Org", "--plan", "pro"])
    out = capsys.readouterr().out
    assert "CLI Org" in out and "plan pro" in out
    org_id = int(out.split("(id ")[2].split(",")[0])
    cli.main(["set-plan", str(org_id), "enterprise"])
    assert "plan enterprise" in capsys.readouterr().out
    cli.main(["stats"])
    assert '"users"' in capsys.readouterr().out
