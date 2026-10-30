import asyncio
from datetime import timedelta

from conftest import Recorder, square
from sqlalchemy import delete, func, select

from firealerts.db import SessionLocal, init_db, utcnow
from firealerts.models import Asset, Detection, Organization, StaticSource
from firealerts.services import alerting, static_sources
from firealerts.services import assets as asset_svc
from firealerts.sources import demo

init_db()

AMBRYM_LAKES = (-16.26, 168.09)  # GOES-West detection on Ambrym's lava lakes, Vanuatu
TABASCO = (17.85, -93.12)  # oil-field flare, Tabasco, Mexico
LENGAI = (-2.764, 35.914)  # Ol Doinyo Lengai: in the GVP list, not curated


def _fresh(session):
    static_sources.invalidate()
    static_sources.ensure_curated(session)


def test_catalog_classifies_known_volcanoes_and_flares():
    with SessionLocal() as s:
        _fresh(s)
        assert static_sources.classify(s, *AMBRYM_LAKES)["name"] == "Ambrym"
        flare = static_sources.classify(s, *TABASCO)
        assert flare["type"] == "industrial" and "Mexico" in flare["name"] and flare["distance_km"] < 2
        lengai = static_sources.classify(s, *LENGAI)
        assert lengai["type"] == "volcano" and "Lengai" in lengai["name"]
        assert static_sources.classify(s, -31.3, -64.5) is None  # wildland in Córdoba, AR


def test_catalog_skips_curated_duplicates_and_is_seeded_once():
    with SessionLocal() as s:
        _fresh(s)
        n = s.scalar(select(func.count()).select_from(StaticSource).where(StaticSource.source == "catalog"))
        assert n > 9000
        static_sources.ensure_curated(s)
        assert s.scalar(select(func.count()).select_from(StaticSource).where(StaticSource.source == "catalog")) == n
        near_villarrica = [r for r in s.scalars(select(StaticSource).where(StaticSource.kind == "volcano", StaticSource.lat.between(-39.5, -39.3), StaticSource.lon.between(-72.0, -71.8)))]
        assert [r.source for r in near_villarrica] == ["curated"]


def test_catalog_backfills_databases_seeded_before_it():
    with SessionLocal() as s:
        _fresh(s)
        s.execute(delete(StaticSource).where(StaticSource.source == "catalog"))
        s.commit()
        static_sources.invalidate()
        assert static_sources.classify(s, *TABASCO)["type"] == "industrial"


def test_demo_fires_are_not_static_sources():
    with SessionLocal() as s:
        _fresh(s)
        for name, lat, lon in demo.SCENARIOS:
            assert static_sources.classify(s, lat, lon) is None, name


def test_catalog_flares_do_not_alert():
    rec = Recorder()
    with SessionLocal() as s:
        _fresh(s)
        org = Organization(name="Tabasco ranch", plan="pro")
        s.add(org)
        s.flush()
        a = Asset(org_id=org.id, name="Ranch next to the oil field", buffer_km=5)
        asset_svc.apply_geometry(a, square(TABASCO[1], TABASCO[0], 0.1))
        s.add(a)
        s.commit()
        flare = Detection(id="cat-flare", source="VIIRS_NOAA20", lat=TABASCO[0], lon=TABASCO[1], acq_time=utcnow() - timedelta(minutes=10), confidence="h", frp=40)
        # ~6 km from the nearest catalogued flare: a real fire
        fire = Detection(id="cat-fire", source="VIIRS_NOAA20", lat=TABASCO[0] - 0.06, lon=TABASCO[1] - 0.06, acq_time=utcnow() - timedelta(minutes=10), confidence="h", frp=40)
        assert static_sources.classify(s, fire.lat, fire.lon) is None
        assert asyncio.run(alerting.on_new_detections(s, rec.client(), [flare])) == 0
        assert asyncio.run(alerting.on_new_detections(s, rec.client(), [fire])) == 1
