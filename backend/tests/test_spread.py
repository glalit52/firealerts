import math

import numpy as np
import pytest

from firealerts.science import fwi as F
from firealerts.science import spread as S


def weather(n, wind=0.0, wind_dir=0.0, temp=25.0, rh=30.0, rain=0.0):
    return [S.HourWeather(f"t{i}", temp, rh, wind, wind_dir, rain) for i in range(n)]


def test_fbp_c2_rate_of_spread():
    # RSI = 110 * (1 - exp(-0.0282 * 10)) ** 1.5 with BUI at BUI0 (no build-up effect).
    assert S.head_ros(S.FUELS["C2"], isi=10, bui=64) == pytest.approx(13.39, abs=0.05)


def test_length_to_breadth_increases_with_wind():
    assert S.length_to_breadth(0) == pytest.approx(1.0)
    assert S.length_to_breadth(10) < S.length_to_breadth(30) < S.length_to_breadth(60)


def test_support_function_roundtrip_square():
    pts = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], dtype=float)
    ring = S.polygon_from_support(S.support_of_points(pts))
    xs, ys = ring[:, 0], ring[:, 1]
    assert xs.min() == pytest.approx(-1, abs=1e-6) and xs.max() == pytest.approx(1, abs=1e-6)
    assert ys.min() == pytest.approx(-1, abs=1e-6) and ys.max() == pytest.approx(1, abs=1e-6)


def test_no_wind_grows_a_circle_with_expected_area():
    res = S.forecast(S.SpreadInputs([(0.0, 0.0, 1.0)], weather(3), F.FWIState(90, 40, 300), "C2", horizons=(3,), members=1))
    radius_m = sum(h["ros_m_min"] for h in res["hourly"]) * 60
    expected_ha = math.pi * radius_m**2 / 1e4
    assert res["stats"][0]["area_ha_p50"] == pytest.approx(expected_ha, rel=0.01)


def test_wind_from_south_pushes_fire_north():
    res = S.forecast(S.SpreadInputs([(10.0, 45.0, 375.0)], weather(6, wind=30, wind_dir=180), F.FWIState(92, 50, 300), "O1b", horizons=(6,), members=1))
    ring = [f for f in res["perimeters"]["features"] if f["properties"]["kind"] == "likely"][0]["geometry"]["coordinates"][0]
    lats = [c[1] for c in ring]
    assert max(lats) - 45.0 > 3 * (45.0 - min(lats))


def test_areas_grow_with_horizon_and_p90_exceeds_p50():
    res = S.forecast(S.SpreadInputs([(-64.5, -31.4, 375.0), (-64.49, -31.41, 375.0)], weather(24, wind=20, wind_dir=270), F.FWIState(91, 40, 300), "O1b"))
    p50 = [s["area_ha_p50"] for s in res["stats"]]
    assert p50 == sorted(p50)
    for s in res["stats"]:
        assert s["area_ha_p90"] >= s["area_ha_p50"] >= s["area_ha_p10"]
    probs = [f["properties"]["p"] for f in res["burn_probability"]["features"]]
    assert max(probs) == pytest.approx(1.0) and min(probs) > 0


def test_heavy_rain_stalls_spread():
    dry = S.forecast(S.SpreadInputs([(0.0, 0.0, 375.0)], weather(6, wind=20), F.FWIState(92, 40, 300), "O1b", horizons=(6,), members=1))
    wet = S.forecast(S.SpreadInputs([(0.0, 0.0, 375.0)], weather(6, wind=20, rh=95, rain=8), F.FWIState(92, 40, 300), "O1b", horizons=(6,), members=1))
    assert wet["stats"][0]["growth_ha_p50"] < 0.05 * dry["stats"][0]["growth_ha_p50"]


def test_rejects_horizons_beyond_weather():
    with pytest.raises(ValueError):
        S.forecast(S.SpreadInputs([(0.0, 0.0, 375.0)], weather(2), F.FWIState(), "C2", horizons=(6,)))
