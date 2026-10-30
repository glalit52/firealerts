"""Deterministic synthetic fire activity so the platform runs without network access.

Fires grow as wind-driven ellipses and are "observed" at realistic satellite
overpass times (VIIRS/MODIS twice a day; GOES, Meteosat or Himawari every
20 minutes depending on longitude). Output is stable across calls, so re-ingesting does not duplicate.
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone

from ..geo import destination

SCENARIOS = [
    ("Sierras de Córdoba, AR", -31.30, -64.55),
    ("Butte County, US", 39.76, -121.62),
    ("Pará, BR", -6.45, -52.05),
    ("Gippsland, AU", -37.55, 147.10),
    ("Algarve, PT", 37.27, -8.45),
    ("Fort McMurray, CA", 56.70, -111.35),
    ("Uttarakhand, IN", 30.20, 79.25),
    ("Central Kalimantan, ID", -2.25, 113.90),
    ("Chaco, PY", -22.10, -60.30),
    ("Okavango, BW", -19.30, 22.80),
]

CYCLE_H = 48
LIFE_H = 40
EPOCH = datetime(2024, 1, 1, tzinfo=timezone.utc)

# (source, satellite, local overpass hours, pixel size m)
POLAR = [
    ("VIIRS_NOAA21", "N21", (0.6, 12.6), 375.0),
    ("VIIRS_NOAA20", "N20", (1.1, 13.1), 375.0),
    ("VIIRS_SNPP", "N", (1.5, 13.5), 375.0),
    ("MODIS", "Aqua", (1.5, 13.5), 1000.0),
    ("MODIS", "Terra", (10.5, 22.5), 1000.0),
]


def _det(source, sat, t, lat, lon, frp, conf, pixel, daynight):
    return {
        "id": f"{source}:{t:%Y%m%d%H%M}:{lat:.4f}:{lon:.4f}",
        "source": source,
        "satellite": sat,
        "lat": lat,
        "lon": lon,
        "acq_time": t,
        "frp": round(frp, 1),
        "brightness": round(310 + frp * 0.8, 1),
        "confidence": conf,
        "daynight": daynight,
        "pixel_m": pixel,
    }


def _front_points(rng, lat0, lon0, heading, head_km, back_km, width_km, n):
    """Points along the active (mostly downwind) part of an elliptical perimeter."""
    a = (head_km + back_km) / 2
    c = (head_km - back_km) / 2
    pts = []
    for _ in range(n):
        phi = rng.gauss(0, 1.1)  # concentrate on the head
        along = c + a * math.cos(phi)
        across = width_km * math.sin(phi)
        dist = math.hypot(along, across) * rng.uniform(0.92, 1.03)
        bearing = heading + math.degrees(math.atan2(across, along))
        pts.append(destination(lat0, lon0, bearing, dist))
    return pts


def generate(now: datetime | None = None, lookback_h: int = 24) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    out: list[dict] = []
    for i, (_, lat0, lon0) in enumerate(SCENARIOS):
        offset_h = (i * 4.7) % CYCLE_H
        age_now = ((now - EPOCH).total_seconds() / 3600 - offset_h) % CYCLE_H
        start = now - timedelta(hours=age_now)
        cycle = int(((start - EPOCH).total_seconds() / 3600) // CYCLE_H)
        frng = random.Random(f"fire:{i}:{cycle}")
        lat = lat0 + frng.uniform(-0.15, 0.15)
        lon = lon0 + frng.uniform(-0.15, 0.15)
        heading = frng.uniform(0, 360)
        speed = frng.uniform(0.25, 1.4)  # km/h head spread
        tz = lon / 15

        times: list[tuple[str, str, datetime, float]] = []
        for src, sat, locals_, px in POLAR:
            day0 = (start - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            for d in range(4):
                for lh in locals_:
                    t = day0 + timedelta(days=d, hours=(lh - tz))
                    t = t.replace(second=0, microsecond=0)
                    times.append((src, sat, t, px))
        geo = None
        if -140 <= lon <= -30:
            geo = ("GOES19" if lon > -105 else "GOES18", "G", 2000.0)
        elif -25 <= lon <= 60:
            geo = ("METEOSAT", "MSG", 3000.0)
        elif 85 <= lon <= 180:
            geo = ("HIMAWARI9", "H09", 2000.0)
        if geo:
            t = start.replace(minute=(start.minute // 20) * 20, second=0, microsecond=0)
            while t <= now:
                times.append((geo[0], geo[1], t, geo[2]))
                t += timedelta(minutes=20)

        for src, sat, t, px in times:
            age = (t - start).total_seconds() / 3600
            if age < 0.3 or age > LIFE_H or t > now or (now - t).total_seconds() > lookback_h * 3600:
                continue
            prng = random.Random(f"{i}:{cycle}:{src}:{sat}:{t:%Y%m%d%H%M}")
            local_h = (t.hour + t.minute / 60 + tz) % 24
            diurnal = 0.55 + 0.45 * math.cos(2 * math.pi * (local_h - 15) / 24)
            vigor = math.sin(math.pi * min(age / LIFE_H, 1)) ** 0.6
            head = speed * age * (0.8 + 0.4 * diurnal)
            n = max(1, int((4 + head * 3) * vigor * diurnal * (375 / px) ** 0.5 * prng.uniform(0.7, 1.3)))
            if px >= 2000:
                n = max(1, min(n, 3))
            pts = _front_points(prng, lat, lon, heading, head + 0.3, 0.12 * head + 0.2, 0.35 * head + 0.3, n)
            daynight = "D" if 6 <= local_h <= 18 else "N"
            for la, lo in pts:
                frp = prng.lognormvariate(math.log(18 * vigor * diurnal + 2), 0.8) * (px / 375) ** 0.5
                conf = "h" if frp > 25 else ("n" if frp > 4 else "l")
                out.append(_det(src, sat, t, round(la, 4), round(lo, 4), frp, conf, px, daynight))

    # Villarrica volcano's lava lake: hot on every pass (filtered as a static source).
    vt = now.replace(minute=0, second=0, microsecond=0)
    for h in range(0, lookback_h, 3):
        t = vt - timedelta(hours=h)
        out.append(_det("VIIRS_NOAA20", "N20", t, -39.4205, -71.9395, 35.0, "h", 375.0, "N"))

    # Scattered small agricultural burns.
    hour_idx = int((now - EPOCH).total_seconds() // 3600)
    for k in range(hour_idx - lookback_h, hour_idx + 1):
        rng = random.Random(f"ag:{k}")
        for _ in range(rng.randint(0, 3)):
            lat0, lon0 = SCENARIOS[rng.randrange(len(SCENARIOS))][1:]
            t = EPOCH + timedelta(hours=k, minutes=rng.randrange(60))
            if t > now:
                continue
            la, lo = round(lat0 + rng.uniform(-2, 2), 4), round(lon0 + rng.uniform(-2, 2), 4)
            out.append(_det("VIIRS_NOAA20", "N20", t, la, lo, rng.uniform(1, 9), "n", 375.0, "D"))
    return out
