import math

import numpy as np
import pytest

from firealerts.science import fwi as F
from firealerts.science import raster_spread as R
from firealerts.science import spread as S
from firealerts.sources import terrain as T


def wx(n, wind=0.0, wind_dir=0.0):
    return [S.HourWeather(f"t{i}", 28, 25, wind, wind_dir, 0) for i in range(n)]


def run(grid, fuel, weather, slope=None, up=None, horizons=None, seed=((0.0, 0.0, 1.0),)):
    fidx = fuel if isinstance(fuel, np.ndarray) else np.full((grid.ny, grid.nx), R.FUEL_CODES.index(fuel))
    zero = np.zeros((grid.ny, grid.nx))
    return R.forecast_raster(
        R.RasterInputs(grid, fidx, zero if slope is None else slope, zero if up is None else up, list(seed), weather, F.FWIState(90, 40, 300), horizons=horizons or (len(weather),), members=1)
    )


def uniform(fuel, weather, seed=((0.0, 0.0, 1.0),)):
    return S.forecast(S.SpreadInputs(list(seed), weather, F.FWIState(90, 40, 300), fuel, horizons=(len(weather),), members=1))


def test_calm_circle_matches_exact_solution():
    r = run(T.Grid(0, 0, 101, 101, 40), "C2", wx(3))
    u = uniform("C2", wx(3))
    assert r["stats"][0]["area_ha_p50"] == pytest.approx(u["stats"][0]["area_ha_p50"], rel=0.06)


@pytest.mark.parametrize("wind,fuel", [(25, "O1b"), (40, "C2")])
def test_wind_driven_ellipse_close_to_exact_huygens(wind, fuel):
    w = wx(6, wind, 250)
    u = uniform(fuel, w, seed=((0.0, 0.0, 375.0),))
    run_km = u["stats"][0]["max_run_km"]
    cell = run_km * 1000 * 2.6 / 200
    r = run(T.Grid(0, 0, 200, 200, cell), fuel, w, seed=((0.0, 0.0, 375.0),))
    ratio = r["stats"][0]["area_ha_p50"] / u["stats"][0]["area_ha_p50"]
    assert 0.88 < ratio < 1.05
    assert r["stats"][0]["max_run_km"] == pytest.approx(run_km, rel=0.08)


def test_upslope_runs_faster_than_downslope():
    g = T.Grid(0, 0, 121, 121, 40)
    elev = np.tile(np.arange(121)[:, None] * 12.0, (1, 121))  # 30 % slope rising north
    slope, up = T.slope_aspect(elev, g.cell_m)
    r = run(g, "C2", wx(2), slope, up)
    assert r["hourly"][0]["spread_dir"] in (0, 360)
    assert r["hourly"][0]["ros_m_min"] > 2 * uniform("C2", wx(2))["hourly"][0]["ros_m_min"]


def test_water_barrier_stops_the_fire():
    g = T.Grid(0, 0, 80, 80, 50)
    fuel = np.full((80, 80), R.FUEL_CODES.index("O1b"))
    fuel[:, 50] = -1  # a one-cell river north-south, east of the ignition
    r = run(g, fuel, wx(6, 30, 270))  # wind from the west pushes fire east
    lines = [f for f in r["perimeters"]["features"] if f["properties"]["kind"] == "likely"][0]["geometry"]["coordinates"]
    east = max(p[0] for seg in lines for p in seg)
    river_lon = g.proj.to_lonlat(g.x0 + 50.5 * g.cell_m, 0)[0]
    assert east <= river_lon + 1e-6
    assert r["fuel_mix"]["non-fuel"] > 0


def test_outputs_are_complete():
    g = T.Grid(-31.3, -64.5, 60, 60, 100)
    r = R.forecast_raster(
        R.RasterInputs(g, np.full((60, 60), R.FUEL_CODES.index("O1a")), np.zeros((60, 60)), np.zeros((60, 60)), [(-64.5, -31.3, 375)], wx(6, 15, 90), F.FWIState(90, 40, 300), horizons=(1, 3, 6), members=6)
    )
    assert r["model"] == "raster" and r["members"] == 6
    assert [s["horizon_h"] for s in r["stats"]] == [1, 3, 6]
    assert all(r["images"][k].startswith("data:image/png;base64,") for k in ("arrival", "burn", "fuel"))
    assert len(r["images"]["coordinates"]) == 4
    for s in r["stats"]:
        assert s["area_ha_p10"] <= s["area_ha_p50"] <= s["area_ha_p90"]


def test_fuel_for_landcover_mapping():
    assert S.fuel_for_landcover(10, 60) == "C2"
    assert S.fuel_for_landcover(10, 38) == "C7"
    assert S.fuel_for_landcover(10, 5) == "D1"
    assert S.fuel_for_landcover(30, 0) == "O1b"
    assert S.fuel_for_landcover(80, 0) is None and S.fuel_for_landcover(50, 0) is None
    assert S.slope_factor(0) == pytest.approx(1.0) and S.slope_factor(100) == pytest.approx(S.slope_factor(60))
