from datetime import datetime, timezone

from firealerts.alerts import match
from firealerts.db import AreaOfInterest, Detection
from firealerts.geo import circle_ring, distance_to_polygon_km, point_in_polygon


def det(i, lat, lon, conf="n"):
    return Detection(id=f"d{i}", source="VIIRS_NOAA20", lat=lat, lon=lon, acq_time=datetime.now(timezone.utc), confidence=conf, frp=5.0)


def test_point_in_polygon_and_distance():
    ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    assert point_in_polygon(0.5, 0.5, ring)
    assert not point_in_polygon(1.5, 0.5, ring)
    assert distance_to_polygon_km(0.5, 0.5, ring) == 0
    assert 55 < distance_to_polygon_km(1.5, 0.5, ring) < 56


def test_match_respects_buffer_and_confidence():
    aoi = AreaOfInterest(id=1, name="x", geometry={"type": "Polygon", "coordinates": [circle_ring(-31.3, -64.5, 5)]}, buffer_km=3, min_confidence="n")
    dets = [det(0, -31.3, -64.5), det(1, -31.3 + 7 / 111, -64.5), det(2, -31.3 + 20 / 111, -64.5), det(3, -31.3, -64.5, conf="l")]
    hits = {d.id: km for d, km in match(aoi, dets)}
    assert set(hits) == {"d0", "d1"}
    assert hits["d0"] == 0 and 1.5 < hits["d1"] < 2.5
