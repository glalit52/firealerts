from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session

from firealerts.alerts import match
from firealerts.config import Settings
from firealerts.db import AreaOfInterest, Base, Detection, IngestRun, migrate
from firealerts.geo import circle_ring
from firealerts.science.cluster import STATIC_PRIORITY_FACTOR, Hotspot, cluster
from firealerts.sources import static_sources
from firealerts.sources.static_sources import StaticIndex, StaticSource, bundled

T0 = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
AMBRYM = (-16.26, 168.09)  # GOES-West detection on the Ambrym lava lakes, Vanuatu
TABASCO = (17.85, -93.12)  # oil-field flare, Tabasco, Mexico
CORDOBA = (-31.3, -64.5)  # wildland in Argentina, nowhere near either


@pytest.fixture(scope="module")
def index():
    return StaticIndex(bundled(5.0, 2.0))


def test_bundled_sources_match_known_volcano_and_flare(index):
    src, km = index.match(*AMBRYM)
    assert src.type == "volcano" and src.name == "Ambrym" and km < 5
    src, km = index.match(*TABASCO)
    assert src.type == "flare" and "Mexico" in src.name and km < 2
    assert index.match(*CORDOBA) is None


def test_proximity_respects_radius_and_antimeridian():
    idx = StaticIndex([StaticSource("flare", "a", 10.0, 179.995, 2.0), StaticSource("volcano", "b", 60.0, 20.0, 5.0)])
    assert idx.match(10.0, -179.995)[0].name == "a"  # ~1.1 km across the antimeridian
    assert idx.match(10.0, 179.995 - 3 / 109.5) is None  # ~3 km away, outside 2 km
    assert idx.match(60.0, 20.08)[0].name == "b"  # ~4.4 km at 60° N
    assert idx.match(60.0, 20.12) is None
    assert StaticIndex([]).match(0, 0) is None


def _hs(i, lat, lon):
    return Hotspot(f"h{i}", lat + i * 1e-3, lon, T0 - timedelta(minutes=10 * i), "GOES18", 300.0, "h", 2000.0)


def test_incident_near_static_source_is_tagged_and_down_weighted(index):
    volcano = cluster([_hs(i, *AMBRYM) for i in range(20)])[0]
    plain = volcano.summary(now=T0)
    tagged = volcano.summary(now=T0, statics=index)
    assert plain["static_source"] is None
    assert tagged["static_source"]["type"] == "volcano" and tagged["static_source"]["name"] == "Ambrym"
    assert plain["priority"] >= 60
    assert tagged["priority"] <= round(plain["priority"] * STATIC_PRIORITY_FACTOR) + 1

    wildfire = cluster([_hs(i, *CORDOBA) for i in range(20)])[0].summary(now=T0, statics=index)
    assert wildfire["static_source"] is None and wildfire["priority"] == plain["priority"]


def _det(i, lat, lon):
    return Detection(id=f"d{i}", source="GOES18", lat=lat, lon=lon, acq_time=T0, confidence="h", frp=50.0)


def _aoi(lat, lon, include_static=False):
    ring = circle_ring(lat, lon, 15)
    return AreaOfInterest(id=1, name="x", geometry={"type": "Polygon", "coordinates": [ring]}, buffer_km=0, min_confidence="n", include_static=include_static)


def test_alerts_skip_static_sources_unless_area_opts_in(index):
    for lat, lon in (AMBRYM, TABASCO):
        dets = [_det(0, lat, lon), _det(1, lat + 0.1, lon)]  # second point is ~11 km away, outside every radius
        assert [d.id for d, _ in match(_aoi(lat, lon), dets, index)] == ["d1"]
        assert {d.id for d, _ in match(_aoi(lat, lon, include_static=True), dets, index)} == {"d0", "d1"}
        assert {d.id for d, _ in match(_aoi(lat, lon), dets)} == {"d0", "d1"}  # no index: unchanged behaviour


@pytest.fixture
def session(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path}/static.db")
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        yield s


def test_learned_persistence_flags_cells_seen_on_most_days(session):
    cfg = replace(Settings(), static_learn_days=30, static_learn_min_days=14, static_learn_fraction=0.6)
    today = date(2026, 3, 31)
    for k in range(20):  # 20 observed days
        day = datetime.combine(today - timedelta(days=k), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=3)
        session.add(IngestRun(mode="live", started_at=day, fetched=10))
        dets = [Detection(id=f"plant{k}", source="VIIRS_NOAA20", lat=45.0001, lon=7.0001, acq_time=day, confidence="n")]
        if k < 5:  # a wildfire that burned for five days
            dets.append(Detection(id=f"fire{k}", source="VIIRS_NOAA20", lat=44.0, lon=8.0, acq_time=day, confidence="n"))
        static_sources.record(session, dets, cfg.static_learn_days, today=today)
    session.commit()

    found = static_sources.learned(session, cfg, today=today)
    assert len(found) == 1 and found[0].type == "persistent"
    idx = StaticIndex(found)
    assert idx.match(45.0, 7.0) and idx.match(44.0, 8.0) is None

    # Too little history: nothing is learned yet.
    assert static_sources.learned(session, replace(cfg, static_learn_min_days=25), today=today) == []
    # Cells quiet for the whole window are pruned.
    static_sources.record(session, [], cfg.static_learn_days, today=today + timedelta(days=60))
    session.commit()
    assert static_sources.learned(session, cfg, today=today + timedelta(days=60)) == []


def test_migration_adds_include_static(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path}/old.db")
    with eng.begin() as c:
        c.execute(text("CREATE TABLE aois (id INTEGER PRIMARY KEY, name VARCHAR(120), geometry JSON)"))
        c.execute(text("INSERT INTO aois (id, name, geometry) VALUES (1, 'old', '{}')"))
    migrate(eng)
    assert "include_static" in {c["name"] for c in inspect(eng).get_columns("aois")}
    with eng.connect() as c:
        assert c.execute(text("SELECT include_static FROM aois")).scalar() == 0
