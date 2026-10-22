"""Canadian Forest Fire Weather Index (FWI) System.

Implements the daily codes of Van Wagner (1987), with the latitude adjustments of
Lawson & Armitage (2008) / Wang et al. (2015), and the hourly FFMC of Van Wagner
(1977) used to drive the hour-by-hour spread forecast.

Inputs are noon local standard time observations: temperature (°C), relative
humidity (%), 10 m wind speed (km/h) and 24 h precipitation (mm).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

FFMC_START, DMC_START, DC_START = 85.0, 6.0, 15.0

_DMC_DAYLENGTH = {
    "n30": [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0],
    "n10": [7.9, 8.4, 8.9, 9.5, 9.9, 10.2, 10.1, 9.7, 9.1, 8.6, 8.1, 7.8],
    "eq": [9.0] * 12,
    "s10": [10.1, 9.6, 9.1, 8.5, 8.1, 7.8, 7.9, 8.3, 8.9, 9.4, 9.9, 10.2],
    "s30": [11.5, 10.5, 9.2, 7.9, 6.8, 6.2, 6.5, 7.4, 8.7, 10.0, 11.2, 11.8],
}
_DC_DAYLENGTH = {
    "n": [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6],
    "eq": [1.4] * 12,
    "s": [6.4, 5.0, 2.4, 0.4, -1.6, -1.6, -1.6, -1.6, -1.6, 0.9, 3.8, 5.8],
}

# European Forest Fire Information System danger classes on the FWI value.
DANGER_CLASSES = [
    (5.2, "very_low"),
    (11.2, "low"),
    (21.3, "moderate"),
    (38.0, "high"),
    (50.0, "very_high"),
    (math.inf, "extreme"),
]


def danger_class(fwi: float) -> str:
    for upper, name in DANGER_CLASSES:
        if fwi < upper:
            return name
    return "extreme"


def _ffmc_to_moisture(ffmc: float) -> float:
    return 147.2 * (101.0 - ffmc) / (59.5 + ffmc)


def _moisture_to_ffmc(m: float) -> float:
    return max(0.0, min(101.0, 59.5 * (250.0 - m) / (147.2 + m)))


def _rain_wetting(mo: float, rf: float) -> float:
    if rf <= 0:
        return mo
    gain = 42.5 * rf * math.exp(-100.0 / (251.0 - mo)) * (1.0 - math.exp(-6.93 / rf))
    if mo > 150.0:
        gain += 0.0015 * (mo - 150.0) ** 2 * math.sqrt(rf)
    return min(mo + gain, 250.0)


def _drying(mo: float, temp: float, rh: float, wind: float, rate: float) -> float:
    """Equilibrium-moisture drying/wetting step shared by daily and hourly FFMC."""
    ed = 0.942 * rh**0.679 + 11.0 * math.exp((rh - 100.0) / 10.0) + 0.18 * (21.1 - temp) * (1.0 - math.exp(-0.115 * rh))
    if mo > ed:
        ko = 0.424 * (1.0 - (rh / 100.0) ** 1.7) + 0.0694 * math.sqrt(wind) * (1.0 - (rh / 100.0) ** 8)
        kd = ko * rate * math.exp(0.0365 * temp)
        return ed + (mo - ed) * 10.0 ** (-kd)
    ew = 0.618 * rh**0.753 + 10.0 * math.exp((rh - 100.0) / 10.0) + 0.18 * (21.1 - temp) * (1.0 - math.exp(-0.115 * rh))
    if mo < ew:
        k1 = 0.424 * (1.0 - ((100.0 - rh) / 100.0) ** 1.7) + 0.0694 * math.sqrt(wind) * (1.0 - ((100.0 - rh) / 100.0) ** 8)
        kw = k1 * rate * math.exp(0.0365 * temp)
        return ew - (ew - mo) * 10.0 ** (-kw)
    return mo


def ffmc(ffmc0: float, temp: float, rh: float, wind: float, rain: float) -> float:
    rh = min(max(rh, 0.0), 100.0)
    mo = _ffmc_to_moisture(ffmc0)
    if rain > 0.5:
        mo = _rain_wetting(mo, rain - 0.5)
    return _moisture_to_ffmc(_drying(mo, temp, rh, wind, 0.581))


def hourly_ffmc(ffmc0: float, temp: float, rh: float, wind: float, rain: float) -> float:
    """Van Wagner (1977) hourly fine fuel moisture code."""
    rh = min(max(rh, 0.0), 100.0)
    mo = _ffmc_to_moisture(ffmc0)
    if rain > 0:
        mo = _rain_wetting(mo, rain)
    return _moisture_to_ffmc(_drying(mo, temp, rh, wind, 0.0579))


def _dmc_daylength(lat: float, month: int) -> float:
    if lat > 30:
        key = "n30"
    elif lat > 10:
        key = "n10"
    elif lat > -10:
        key = "eq"
    elif lat > -30:
        key = "s10"
    else:
        key = "s30"
    return _DMC_DAYLENGTH[key][month - 1]


def _dc_daylength(lat: float, month: int) -> float:
    key = "n" if lat > 20 else ("eq" if lat > -20 else "s")
    return _DC_DAYLENGTH[key][month - 1]


def dmc(dmc0: float, temp: float, rh: float, rain: float, month: int, lat: float) -> float:
    rk = 0.0
    if temp > -1.1:
        rk = 1.894 * (temp + 1.1) * (100.0 - rh) * _dmc_daylength(lat, month) * 1e-4
    pr = dmc0
    if rain > 1.5:
        rw = 0.92 * rain - 1.27
        wmi = 20.0 + 280.0 / math.exp(0.023 * dmc0)
        if dmc0 <= 33.0:
            b = 100.0 / (0.5 + 0.3 * dmc0)
        elif dmc0 <= 65.0:
            b = 14.0 - 1.3 * math.log(dmc0)
        else:
            b = 6.2 * math.log(dmc0) - 17.2
        wmr = wmi + 1000.0 * rw / (48.77 + b * rw)
        pr = 43.43 * (5.6348 - math.log(wmr - 20.0))
    return max(pr, 0.0) + rk


def dc(dc0: float, temp: float, rain: float, month: int, lat: float) -> float:
    pe = 0.0
    if temp > -2.8:
        pe = max((0.36 * (temp + 2.8) + _dc_daylength(lat, month)) / 2.0, 0.0)
    if rain > 2.8:
        rd = 0.83 * rain - 1.27
        qr = 800.0 * math.exp(-dc0 / 400.0) + 3.937 * rd
        dr = max(400.0 * math.log(800.0 / qr), 0.0)
        return dr + pe
    return dc0 + pe


def isi(ffmc_val: float, wind: float) -> float:
    m = _ffmc_to_moisture(ffmc_val)
    ff = 91.9 * math.exp(-0.1386 * m) * (1.0 + m**5.31 / 4.93e7)
    return 0.208 * math.exp(0.05039 * wind) * ff


def bui(dmc_val: float, dc_val: float) -> float:
    if dmc_val == 0 and dc_val == 0:
        return 0.0
    if dmc_val <= 0.4 * dc_val:
        out = 0.8 * dmc_val * dc_val / (dmc_val + 0.4 * dc_val)
    else:
        out = dmc_val - (1.0 - 0.8 * dc_val / (dmc_val + 0.4 * dc_val)) * (0.92 + (0.0114 * dmc_val) ** 1.7)
    return max(out, 0.0)


def fwi(isi_val: float, bui_val: float) -> float:
    if bui_val <= 80.0:
        fd = 0.626 * bui_val**0.809 + 2.0
    else:
        fd = 1000.0 / (25.0 + 108.64 * math.exp(-0.023 * bui_val))
    b = 0.1 * isi_val * fd
    if b > 1.0:
        return math.exp(2.72 * (0.434 * math.log(b)) ** 0.647)
    return b


@dataclass
class FWIState:
    ffmc: float = FFMC_START
    dmc: float = DMC_START
    dc: float = DC_START


@dataclass
class FWIDay:
    date: str
    temp: float
    rh: float
    wind: float
    rain: float
    ffmc: float
    dmc: float
    dc: float
    isi: float
    bui: float
    fwi: float
    danger: str

    def as_dict(self) -> dict:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


def step(state: FWIState, temp: float, rh: float, wind: float, rain: float, month: int, lat: float) -> tuple[FWIState, float, float, float]:
    """Advance one day. Returns (new_state, isi, bui, fwi)."""
    new = FWIState(
        ffmc=ffmc(state.ffmc, temp, rh, wind, rain),
        dmc=dmc(state.dmc, temp, rh, rain, month, lat),
        dc=dc(state.dc, temp, rain, month, lat),
    )
    i = isi(new.ffmc, wind)
    b = bui(new.dmc, new.dc)
    return new, i, b, fwi(i, b)


def run_series(days: list[dict], lat: float, state: FWIState | None = None) -> tuple[list[FWIDay], FWIState]:
    """Run the system over daily noon weather dicts: {date: 'YYYY-MM-DD', temp, rh, wind, rain}."""
    state = state or FWIState()
    out: list[FWIDay] = []
    for d in days:
        month = int(d["date"][5:7])
        state, i, b, f = step(state, d["temp"], d["rh"], d["wind"], d["rain"], month, lat)
        out.append(
            FWIDay(d["date"], d["temp"], d["rh"], d["wind"], d["rain"], state.ffmc, state.dmc, state.dc, i, b, f, danger_class(f))
        )
    return out, state
