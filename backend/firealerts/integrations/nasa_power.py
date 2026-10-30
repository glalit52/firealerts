"""NASA POWER hourly meteorology (public, no key): fallback weather source.

POWER has a latency of a few days and no forecast, so the last observed day is
carried forward as a persistence forecast and the source is labelled as such.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

API = "https://power.larc.nasa.gov/api/temporal/hourly/point"
PARAMS = "T2M,RH2M,WS10M,WD10M,PRECTOTCORR"


def parse(data: dict) -> list[dict]:
    p = data["properties"]["parameter"]
    hours = []
    for key in sorted(p["T2M"]):
        vals = [p[k].get(key) for k in ("T2M", "RH2M", "WS10M", "WD10M", "PRECTOTCORR")]
        if any(v is None or v <= -999 for v in vals):
            continue
        t = datetime.strptime(key, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        hours.append({"time": t, "temp": vals[0], "rh": vals[1], "wind": vals[2] * 3.6, "wind_dir": vals[3], "rain": max(0.0, vals[4])})
    return hours


def persistence(hours: list[dict], until: datetime) -> list[dict]:
    """Repeat the last observed day's diurnal cycle until `until`."""
    if len(hours) < 24:
        return hours
    last_day = hours[-24:]
    out = list(hours)
    t = hours[-1]["time"]
    i = 0
    while t < until:
        t += timedelta(hours=1)
        src = last_day[i % 24]
        out.append({**src, "time": t, "rain": 0.0})
        i += 1
    return out


async def fetch(client: httpx.AsyncClient, lat: float, lon: float, past_days: int = 60, forecast_days: int = 7) -> dict:
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=past_days)).strftime("%Y%m%d")
    end = now.strftime("%Y%m%d")
    resp = await client.get(API, params={"parameters": PARAMS, "community": "AG", "latitude": lat, "longitude": lon, "start": start, "end": end, "format": "JSON", "time-standard": "UTC"}, timeout=60)
    resp.raise_for_status()
    hours = parse(resp.json())
    return {"utc_offset": int(round(lon / 15)) * 3600, "hours": persistence(hours, now + timedelta(days=forecast_days))}
