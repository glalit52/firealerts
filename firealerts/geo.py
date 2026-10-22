"""Small spherical-geometry helpers (no GIS dependencies)."""

from __future__ import annotations

import math
from typing import Iterable, Sequence

EARTH_RADIUS_KM = 6371.0088

Point = tuple[float, float]  # (lon, lat)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def destination(lat: float, lon: float, bearing_deg: float, dist_km: float) -> tuple[float, float]:
    """Point reached travelling dist_km from (lat, lon) on the given bearing. Returns (lat, lon)."""
    d = dist_km / EARTH_RADIUS_KM
    b = math.radians(bearing_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


class LocalProjection:
    """Equirectangular projection around an origin; accurate to <0.5% within ~100 km."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.radians(1) * EARTH_RADIUS_KM * 1000 * math.cos(math.radians(lat0))
        self.ky = math.radians(1) * EARTH_RADIUS_KM * 1000

    def to_xy(self, lon: float, lat: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def to_lonlat(self, x: float, y: float) -> Point:
        return self.lon0 + x / self.kx, self.lat0 + y / self.ky


def convex_hull(points: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    """Andrew's monotone chain. Returns hull counter-clockwise, without repeating the first point."""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def polygon_area(ring: Sequence[tuple[float, float]]) -> float:
    """Planar shoelace area (absolute) of a ring in projected units."""
    n = len(ring)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def point_in_polygon(lon: float, lat: float, ring: Sequence[Sequence[float]]) -> bool:
    """Ray casting; ring is a list of [lon, lat]."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def distance_to_polygon_km(lon: float, lat: float, ring: Sequence[Sequence[float]]) -> float:
    """0 inside the polygon, otherwise the distance to the nearest edge."""
    if point_in_polygon(lon, lat, ring):
        return 0.0
    proj = LocalProjection(lat, lon)
    best = math.inf
    pts = [proj.to_xy(p[0], p[1]) for p in ring]
    for i in range(len(pts)):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % len(pts)]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        px, py = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(px, py))
    return best / 1000


def circle_ring(lat: float, lon: float, radius_km: float, n: int = 64) -> list[list[float]]:
    ring = []
    for i in range(n):
        la, lo = destination(lat, lon, 360 * i / n, radius_km)
        ring.append([lo, la])
    ring.append(ring[0])
    return ring


def bbox_contains(bbox: tuple[float, float, float, float], lon: float, lat: float) -> bool:
    w, s, e, n = bbox
    if not (s <= lat <= n):
        return False
    if w <= e:
        return w <= lon <= e
    return lon >= w or lon <= e  # crosses the antimeridian
