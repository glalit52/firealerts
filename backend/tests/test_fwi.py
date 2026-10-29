import pytest

from firealerts.science import fwi as F


def test_reference_day_van_wagner_pickett():
    # First day of the standard FWI test data set (Van Wagner & Pickett 1985).
    state, isi, bui, fwi = F.step(F.FWIState(), temp=17, rh=42, wind=25, rain=0, month=4, lat=45)
    assert state.ffmc == pytest.approx(87.7, abs=0.1)
    assert state.dmc == pytest.approx(8.5, abs=0.1)
    assert state.dc == pytest.approx(19.0, abs=0.1)
    assert isi == pytest.approx(10.9, abs=0.1)
    assert bui == pytest.approx(8.5, abs=0.1)
    assert fwi == pytest.approx(10.1, abs=0.1)


def test_rain_wets_all_codes():
    dry = F.FWIState(92, 60, 400)
    wet, *_ = F.step(dry, temp=15, rh=90, wind=5, rain=20, month=7, lat=45)
    assert wet.ffmc < dry.ffmc - 20
    assert wet.dmc < dry.dmc
    assert wet.dc < dry.dc


def test_hourly_ffmc_dries_slower_than_daily():
    daily = F.ffmc(80, 30, 20, 20, 0)
    hourly = F.hourly_ffmc(80, 30, 20, 20, 0)
    assert 80 < hourly < daily


@pytest.mark.parametrize(
    "value,expected",
    [(0, "very_low"), (8, "low"), (15, "moderate"), (30, "high"), (45, "very_high"), (80, "extreme")],
)
def test_danger_classes(value, expected):
    assert F.danger_class(value) == expected


def test_southern_hemisphere_day_length_used():
    north = F.dmc(10, 25, 30, 0, month=1, lat=-40)
    south_summer = F.dmc(10, 25, 30, 0, month=1, lat=40)
    assert north > south_summer  # January is summer in the south
