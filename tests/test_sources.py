import asyncio
import io
import math

import numpy as np
import pytest

from firealerts.sources import demo, firms, goes, weather

VIIRS_CSV = """latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
-31.30120,-64.55010,345.2,0.39,0.36,2026-10-21,1748,N20,VIIRS,h,2.0NRT,295.1,25.3,D
-31.30200,-64.55100,330.1,0.39,0.36,2026-10-21,0912,N20,VIIRS,l,2.0NRT,290.4,3.1,N
"""
MODIS_CSV = """latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight
39.7,-121.6,330.5,1.2,1.1,2026-10-21,2105,Aqua,85,6.1NRT,300.2,40.0,D
"""


def test_parse_viirs_csv():
    rows = firms.parse_csv(VIIRS_CSV, "VIIRS_NOAA20")
    assert len(rows) == 2
    r = rows[0]
    assert r["confidence"] == "h" and r["frp"] == 25.3 and r["pixel_m"] == pytest.approx(390)
    assert r["acq_time"].hour == 17 and r["acq_time"].minute == 48
    assert rows[1]["acq_time"].hour == 9  # zero-padded HHMM


def test_parse_modis_numeric_confidence():
    r = firms.parse_csv(MODIS_CSV, "MODIS")[0]
    assert r["confidence"] == "h" and r["pixel_m"] == pytest.approx(1200)


def test_firms_url_uses_api_with_key():
    from firealerts.config import Settings

    cfg = Settings()
    cfg.firms_map_key = "abc"
    cfg.region_bbox = "-70,-40,-50,-20"
    assert firms.source_url(cfg, "VIIRS_SNPP").endswith("/abc/VIIRS_SNPP_NRT/-70.0,-40.0,-50.0,-20.0/1")
    cfg.firms_map_key = ""
    assert "Global_24h" in firms.source_url(cfg, "MODIS")


PROJ = {"semi_major_axis": 6378137.0, "semi_minor_axis": 6356752.31414, "perspective_point_height": 35786023.0, "longitude_of_projection_origin": -75.0}


def test_goes_fixed_grid_nadir_and_off_disk():
    lat, lon = goes.fixed_grid_to_latlon(np.array([0.0, 0.2]), np.array([0.0, 0.2]), PROJ)
    assert lat[0] == pytest.approx(0, abs=1e-6) and lon[0] == pytest.approx(-75, abs=1e-6)
    assert math.isnan(lat[1])  # outside the Earth disk


def test_goes_scan_start_from_key():
    t = goes.scan_start("ABI-L2-FDCF/2026/295/13/OR_ABI-L2-FDCF-M6_G19_s20262951300205_e2026_c2026.nc")
    assert (t.year, t.month, t.day, t.hour, t.minute) == (2026, 10, 22, 13, 0)


def test_goes_parse_fdc_file():
    h5py = pytest.importorskip("h5py")
    buf = io.BytesIO()
    with h5py.File(buf, "w") as f:
        mask = np.zeros((5, 5), dtype="int16")
        mask[2, 2] = 10  # good fire at nadir
        mask[0, 0] = 15  # low probability, ignored
        f["Mask"] = mask
        f["Power"] = np.full((5, 5), 42.0, dtype="float32")
        xs = f.create_dataset("x", data=np.arange(-2, 3, dtype="int16"))
        xs.attrs["scale_factor"] = np.float32(1e-4)
        xs.attrs["add_offset"] = np.float32(0)
        ys = f.create_dataset("y", data=np.arange(2, -3, -1, dtype="int16"))
        ys.attrs["scale_factor"] = np.float32(1e-4)
        ys.attrs["add_offset"] = np.float32(0)
        p = f.create_dataset("goes_imager_projection", data=0)
        for k, v in PROJ.items():
            p.attrs[k] = v
    rows = goes.parse_fdc(buf.getvalue(), "goes19", "OR_ABI-L2-FDCF-M6_G19_s20262951300205_e.nc")
    assert len(rows) == 1
    r = rows[0]
    assert r["source"] == "GOES19" and r["confidence"] == "h" and r["frp"] == 42.0
    assert r["lat"] == pytest.approx(0, abs=1e-3) and r["lon"] == pytest.approx(-75, abs=1e-3)


def test_demo_is_deterministic_and_fresh():
    a = demo.generate()
    b = demo.generate()
    assert a and {r["id"] for r in a} == {r["id"] for r in b}
    assert len({r["id"] for r in a}) == len(a)


def test_open_meteo_parse_and_noon_series():
    hours = [f"2026-10-{d:02d}T{h:02d}:00" for d in range(1, 4) for h in range(24)]
    loc = {
        "utc_offset_seconds": -3 * 3600,
        "hourly": {
            "time": hours,
            "temperature_2m": [20.0] * len(hours),
            "relative_humidity_2m": [40.0] * len(hours),
            "wind_speed_10m": [10.0] * len(hours),
            "wind_direction_10m": [90.0] * len(hours),
            "precipitation": [0.5] * len(hours),
        },
    }
    parsed = weather._parse_location(loc)
    assert parsed["hours"][0]["time"].hour == 3  # local midnight at UTC-3
    days = weather.daily_noon(parsed["hours"], parsed["utc_offset"])
    # The first noon has no full 24 h rain window behind it and is skipped.
    assert [d["date"] for d in days] == ["2026-10-02", "2026-10-03"]
    assert days[-1]["rain"] == pytest.approx(12.0)


def test_fire_weather_demo_mode():
    fw = asyncio.run(weather.fire_weather(None, -31.3, -64.5, mode="demo"))
    assert fw["source"] == "demo"
    assert any(d["forecast"] for d in fw["days"]) and any(not d["forecast"] for d in fw["days"])
    assert len(fw["hourly"]) >= 72
