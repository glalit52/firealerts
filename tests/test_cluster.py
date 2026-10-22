from datetime import datetime, timedelta, timezone

from firealerts.science.cluster import Hotspot, cluster

T0 = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def hs(i, lat, lon, minutes=0, pixel=375.0):
    return Hotspot(f"h{i}", lat, lon, T0 + timedelta(minutes=minutes), "VIIRS_NOAA20", 10.0, "n", pixel)


def test_separate_fires_form_separate_incidents():
    pts = [hs(0, 0, 0), hs(1, 0.005, 0.005), hs(2, 1, 1), hs(3, 1.004, 1)]
    incs = cluster(pts)
    assert sorted(len(i.detections) for i in incs) == [2, 2]


def test_chain_links_transitively():
    pts = [hs(i, 0, i * 0.02) for i in range(10)]  # ~2.2 km apart, eps 2.5 km
    assert len(cluster(pts)) == 1


def test_high_latitude_neighbours_are_found():
    # At 70° a 0.05° longitude step is only ~1.9 km.
    pts = [hs(0, 70, 10), hs(1, 70, 10.05)]
    assert len(cluster(pts)) == 1


def test_incident_id_is_stable_and_summary_sane():
    pts = [hs(0, 10, 10, 0), hs(1, 10.003, 10.003, 60)]
    a = cluster(pts)[0]
    b = cluster(list(reversed(pts)))[0]
    assert a.id == b.id
    s = a.summary(now=T0 + timedelta(hours=2))
    assert s["count"] == 2 and s["area_ha"] > 0 and 0 <= s["priority"] <= 100
    assert s["hull"]["coordinates"][0][0] == s["hull"]["coordinates"][0][-1]


def test_active_front_prefers_fine_pixels():
    pts = [hs(0, 0, 0, 0), hs(1, 0, 0.001, 30, pixel=2000.0), hs(2, 0, 0.002, -24 * 60)]
    front = cluster(pts)[0].active_front(window_h=12)
    assert [d.id for d in front] == ["h0"]
