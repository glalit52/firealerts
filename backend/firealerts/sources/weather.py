"""Fire weather: Open-Meteo hourly observations/forecasts driving the FWI System.

`fire_weather()` returns the daily FWI series (spun up over the past 60 days of
observed weather, then carried 7 days into the forecast), the current moisture
code state, and the hour-by-hour forecast used by the spread model.
"""

from __future__ import annotations

import logging
import math
import random
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

import httpx

from ..science import fwi as F
from ..science.spread import HourWeather

log = logging.getLogger(__name__)

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
HOURLY_VARS = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation"

_CACHE: "OrderedDict[tuple, tuple[float, object]]" = OrderedDict()
_CACHE_TTL = 1800
_CACHE_MAX = 512


def _cache_get(key):
    hit = _CACHE.get(key)
    if hit and hit[0] > time.time():
        _CACHE.move_to_end(key)
        return hit[1]
    return None


def _cache_put(key, value):
    _CACHE[key] = (time.time() + _CACHE_TTL, value)
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


def _parse_location(loc: dict) -> dict:
    offset = int(loc.get("utc_offset_seconds", 0))
    h = loc["hourly"]
    hours = []
    for i, t in enumerate(h["time"]):
        vals = [h[k][i] for k in ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "precipitation")]
        if any(v is None for v in vals):
            continue
        local = datetime.fromisoformat(t)
        hours.append(
            {
                "time": (local - timedelta(seconds=offset)).replace(tzinfo=timezone.utc),
                "temp": float(vals[0]),
                "rh": float(vals[1]),
                "wind": float(vals[2]),
                "wind_dir": float(vals[3]),
                "rain": float(vals[4]),
            }
        )
    return {"utc_offset": offset, "hours": hours}


async def fetch_open_meteo(client: httpx.AsyncClient, points: list[tuple[float, float]], past_days: int = 60, forecast_days: int = 7) -> list[dict]:
    params = {
        "latitude": ",".join(f"{p[0]:.4f}" for p in points),
        "longitude": ",".join(f"{p[1]:.4f}" for p in points),
        "hourly": HOURLY_VARS,
        "past_days": past_days,
        "forecast_days": forecast_days,
        "timezone": "auto",
        "wind_speed_unit": "kmh",
    }
    resp = await client.get(OPEN_METEO, params=params)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict):
        data = [data]
    return [_parse_location(loc) for loc in data]


def synthetic_hours(lat: float, lon: float, past_days: int = 60, forecast_days: int = 7, now: datetime | None = None) -> dict:
    """Plausible, deterministic hourly weather for offline/demo use."""
    now = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    offset = int(round(lon / 15)) * 3600
    # Regional seed + smooth spatial field so neighbouring points get coherent weather.
    rng = random.Random(f"{round(lat / 3)}:{round(lon / 3)}:{now:%Y%m%d}")
    field = math.sin(math.radians(lat * 23)) * math.cos(math.radians(lon * 17))
    summer_month = 7 if lat >= 0 else 1
    season = math.cos(2 * math.pi * (now.month - summer_month) / 12)  # 1 = mid-summer
    base_t = 27 - 0.35 * abs(lat) + 7 * season + rng.uniform(-2, 2) + 2.5 * field
    base_rh = min(70, max(18, 42 - 12 * season + rng.uniform(-6, 6) - 8 * field))
    dir0 = rng.uniform(0, 360)
    start = now - timedelta(days=past_days)
    start = start.replace(hour=0)
    hours = []
    t = start
    rain_left = 0
    end = now + timedelta(days=forecast_days)
    while t < end:
        local_h = (t.hour + offset / 3600) % 24
        day = (t - start).total_seconds() / 86400
        diurnal = math.cos(2 * math.pi * (local_h - 15) / 24)  # 1 at 15:00 local
        synoptic = math.sin(2 * math.pi * day / 6.5 + lat)
        temp = base_t + 7 * diurnal + 3 * synoptic + rng.gauss(0, 0.6)
        rh = min(100, max(5, base_rh - 20 * diurnal - 8 * synoptic + rng.gauss(0, 2)))
        wind = max(0, 13 + 3 * field + 7 * diurnal + 5 * synoptic + rng.gauss(0, 2))
        wind_dir = (dir0 + 40 * math.sin(2 * math.pi * day / 4.3) + rng.gauss(0, 8)) % 360
        if rain_left <= 0 and rng.random() < 0.004 * (1.5 - season):
            rain_left = rng.randint(2, 8)
        rain = 0.0
        if rain_left > 0:
            rain = rng.uniform(0.3, 3.5)
            rh = max(rh, 85)
            rain_left -= 1
        hours.append({"time": t, "temp": round(temp, 1), "rh": round(rh), "wind": round(wind, 1), "wind_dir": round(wind_dir), "rain": round(rain, 1)})
        t += timedelta(hours=1)
    return {"utc_offset": offset, "hours": hours}


def daily_noon(hours: list[dict], utc_offset: int) -> list[dict]:
    """Noon local weather + 24 h rain ending at noon, the standard FWI observation."""
    by_local = [(h["time"] + timedelta(seconds=utc_offset), h) for h in hours]
    out = []
    for i, (local, h) in enumerate(by_local):
        if local.hour != 12 or i < 23:
            continue
        rain = sum(x["rain"] for _, x in by_local[i - 23 : i + 1])
        out.append({"date": local.strftime("%Y-%m-%d"), "temp": h["temp"], "rh": h["rh"], "wind": h["wind"], "rain": rain, "time": h["time"]})
    return out


def compute(lat: float, wx: dict, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    hours = wx["hours"]
    days = daily_noon(hours, wx["utc_offset"])
    observed = [d for d in days if d["time"] <= now]
    future = [d for d in days if d["time"] > now]
    obs_series, state = F.run_series(observed, lat)
    fut_series, _ = F.run_series(future, lat, F.FWIState(state.ffmc, state.dmc, state.dc))

    # Bring the fine fuel moisture forward hour by hour from the last noon to now.
    last_noon = observed[-1]["time"] if observed else now - timedelta(hours=24)
    ffmc_now = state.ffmc
    for h in hours:
        if last_noon < h["time"] <= now:
            ffmc_now = F.hourly_ffmc(ffmc_now, h["temp"], h["rh"], h["wind"], h["rain"])
    current = F.FWIState(ffmc_now, state.dmc, state.dc)

    cur_hour = now.replace(minute=0, second=0, microsecond=0)
    hourly = [
        HourWeather(h["time"].isoformat(), h["temp"], h["rh"], h["wind"], h["wind_dir"], h["rain"])
        for h in hours
        if h["time"] >= cur_hour
    ]
    now_wx = next((h for h in hours if h["time"] >= cur_hour), hours[-1])
    return {
        "days": [dict(d.as_dict(), forecast=False) for d in obs_series[-14:]] + [dict(d.as_dict(), forecast=True) for d in fut_series],
        "state": current,
        "hourly": hourly,
        "current": {
            "temp": now_wx["temp"],
            "rh": now_wx["rh"],
            "wind": now_wx["wind"],
            "wind_dir": now_wx["wind_dir"],
            "ffmc": round(ffmc_now, 1),
            "isi": round(F.isi(ffmc_now, now_wx["wind"]), 1),
        },
        "utc_offset": wx["utc_offset"],
    }


async def fire_weather(client: httpx.AsyncClient, lat: float, lon: float, mode: str = "auto") -> dict:
    key = ("fw", round(lat, 2), round(lon, 2), mode)
    cached = _cache_get(key)
    if cached:
        return cached
    source = "open-meteo"
    if mode == "demo":
        wx, source = synthetic_hours(lat, lon), "demo"
    else:
        try:
            wx = (await fetch_open_meteo(client, [(lat, lon)]))[0]
        except Exception as exc:  # network, HTTP or schema errors
            log.warning("Open-Meteo unavailable (%s); trying NASA POWER", exc)
            try:
                from ..integrations import nasa_power

                wx, source = await nasa_power.fetch(client, lat, lon), "nasa-power (persistence forecast)"
            except Exception as exc2:
                if mode == "live":
                    raise
                log.warning("NASA POWER unavailable (%s); using synthetic weather", exc2)
                wx, source = synthetic_hours(lat, lon), "demo"
    result = compute(lat, wx)
    result["source"] = source
    _cache_put(key, result)
    return result


async def grid_series(client: httpx.AsyncClient, bbox: tuple[float, float, float, float], n: int = 8, mode: str = "auto") -> dict:
    """Daily FWI series (today + 7-day forecast) for the centres of an n×n grid (one batched request)."""
    w, s, e, nn = bbox
    key = ("gridseries", round(w, 2), round(s, 2), round(e, 2), round(nn, 2), n, mode)
    cached = _cache_get(key)
    if cached:
        return cached
    dx, dy = (e - w) / n, (nn - s) / n
    centres = [(s + (j + 0.5) * dy, w + (i + 0.5) * dx) for j in range(n) for i in range(n)]
    source = "open-meteo"
    wxs = None
    if mode != "demo":
        try:
            wxs = await fetch_open_meteo(client, centres, past_days=45)
        except Exception as exc:
            if mode == "live":
                raise
            log.warning("Open-Meteo grid unavailable (%s); using synthetic weather", exc)
    if wxs is None:
        wxs, source = [synthetic_hours(la, lo, past_days=45) for la, lo in centres], "demo"
    series = []
    for (la, _), wx in zip(centres, wxs):
        days = compute(la, wx)["days"]
        series.append([d for d in days if not d["forecast"]][-1:] + [d for d in days if d["forecast"]])
    out = {"centres": centres, "dx": dx, "dy": dy, "series": series, "dates": [d["date"] for d in series[0]], "source": source}
    _cache_put(key, out)
    return out


def cell_polygon(lat: float, lon: float, dx: float, dy: float) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [[[lon - dx / 2, lat - dy / 2], [lon + dx / 2, lat - dy / 2], [lon + dx / 2, lat + dy / 2], [lon - dx / 2, lat + dy / 2], [lon - dx / 2, lat - dy / 2]]],
    }


async def danger_grid(client: httpx.AsyncClient, bbox: tuple[float, float, float, float], n: int = 8, mode: str = "auto") -> dict:
    """FWI forecast on an n×n grid of cells covering the bbox."""
    g = await grid_series(client, bbox, n, mode)
    cells = [
        {
            "type": "Feature",
            "properties": {"fwi": [d["fwi"] for d in ser], "danger": [d["danger"] for d in ser]},
            "geometry": cell_polygon(la, lo, g["dx"], g["dy"]),
        }
        for (la, lo), ser in zip(g["centres"], g["series"])
    ]
    return {"type": "FeatureCollection", "features": cells, "dates": g["dates"], "source": g["source"]}
