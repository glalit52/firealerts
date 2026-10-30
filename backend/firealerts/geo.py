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
    return distance_to_ring_edge_km(lon, lat, ring)


def distance_to_ring_edge_km(lon: float, lat: float, ring: Sequence[Sequence[float]]) -> float:
    """Distance to the nearest edge of a ring (regardless of inside/outside)."""
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


# ----------------------------------------------------------------------------- (multi)polygons

def polygons(geometry: dict) -> list[list[list[list[float]]]]:
    """GeoJSON Polygon/MultiPolygon (or Feature) -> list of polygons, each [outer, *holes]."""
    if geometry.get("type") == "Feature":
        geometry = geometry["geometry"]
    t = geometry.get("type")
    if t == "Polygon":
        return [geometry["coordinates"]]
    if t == "MultiPolygon":
        return list(geometry["coordinates"])
    raise ValueError("geometry must be a Polygon or MultiPolygon")


def point_in_geometry(lon: float, lat: float, geometry: dict) -> bool:
    for poly in polygons(geometry):
        if point_in_polygon(lon, lat, poly[0]) and not any(point_in_polygon(lon, lat, h) for h in poly[1:]):
            return True
    return False


def points_in_geometry(lon, lat, geometry: dict):
    """Vectorised point-in-(multi)polygon test (numpy arrays of lon/lat)."""
    import numpy as np

    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)

    def ring_mask(ring):
        r = np.asarray(ring, dtype=float)
        inside = np.zeros(lon.shape, dtype=bool)
        xj, yj = r[-1, 0], r[-1, 1]
        for xi, yi in r[:, :2]:
            crosses = (yi > lat) != (yj > lat)
            with np.errstate(divide="ignore", invalid="ignore"):
                xc = (xj - xi) * (lat - yi) / (yj - yi) + xi
            inside ^= crosses & (lon < xc)
            xj, yj = xi, yi
        return inside

    out = np.zeros(lon.shape, dtype=bool)
    for poly in polygons(geometry):
        m = ring_mask(poly[0])
        for hole in poly[1:]:
            m &= ~ring_mask(hole)
        out |= m
    return out


def distance_to_geometry_km(lon: float, lat: float, geometry: dict) -> float:
    if point_in_geometry(lon, lat, geometry):
        return 0.0
    # Outside every polygon (or inside a hole): distance to the nearest ring edge.
    return min(distance_to_ring_edge_km(lon, lat, ring) for poly in polygons(geometry) for ring in poly)


def geometry_stats(geometry: dict) -> dict:
    """Geodesic-ish area (ha), area-weighted centroid and bbox."""
    polys = polygons(geometry)
    pts = [p for poly in polys for p in poly[0]]
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    lat0, lon0 = sum(lats) / len(lats), sum(lons) / len(lons)
    proj = LocalProjection(lat0, lon0)
    total, cx, cy = 0.0, 0.0, 0.0
    for poly in polys:
        for k, ring in enumerate(poly):
            xy = [proj.to_xy(p[0], p[1]) for p in ring]
            a = polygon_area(xy)
            sign = 1 if k == 0 else -1
            total += sign * a
            # Shoelace centroid of the ring, weighted by its (signed) area.
            s2, mx, my = 0.0, 0.0, 0.0
            for i in range(len(xy)):
                x1, y1 = xy[i]
                x2, y2 = xy[(i + 1) % len(xy)]
                c = x1 * y2 - x2 * y1
                s2 += c
                mx += (x1 + x2) * c
                my += (y1 + y2) * c
            if s2:
                cx += sign * a * mx / (3 * s2)
                cy += sign * a * my / (3 * s2)
    if total > 0:
        clon, clat = proj.to_lonlat(cx / total, cy / total)
    else:
        clon, clat = lon0, lat0
    return {"area_ha": total / 1e4, "centroid": (clon, clat), "bbox": [min(lons), min(lats), max(lons), max(lats)]}


def validate_geometry(geometry: dict, max_vertices: int = 20000) -> dict:
    """Normalise to Polygon/MultiPolygon with closed rings and valid coordinates."""
    polys = polygons(geometry)
    if not polys:
        raise ValueError("empty geometry")
    out, nverts = [], 0
    for poly in polys:
        rings = []
        for ring in poly:
            ring = [[float(c[0]), float(c[1])] for c in ring]
            if len(ring) < 3:
                raise ValueError("a ring needs at least 3 vertices")
            for lon, lat in ring:
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError("coordinates must be WGS84 longitude/latitude")
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            nverts += len(ring)
            rings.append(ring)
        out.append(rings)
    if nverts > max_vertices:
        raise ValueError(f"geometry has {nverts} vertices; simplify it below {max_vertices}")
    if len(out) == 1:
        return {"type": "Polygon", "coordinates": out[0]}
    return {"type": "MultiPolygon", "coordinates": out}


def _segments_intersect(p1, p2, p3, p4) -> bool:
    def orient(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-15 else (1 if v > 0 else -1)

    o1, o2, o3, o4 = orient(p1, p2, p3), orient(p1, p2, p4), orient(p3, p4, p1), orient(p3, p4, p2)
    return o1 != o2 and o3 != o4


def ring_intersects_geometry(ring: Sequence[Sequence[float]], geometry: dict) -> bool:
    """True if a closed ring (e.g. a forecast perimeter) overlaps a (multi)polygon."""
    if any(point_in_geometry(p[0], p[1], geometry) for p in ring):
        return True
    for poly in polygons(geometry):
        if any(point_in_polygon(p[0], p[1], ring) for p in poly[0]):
            return True
        outer = poly[0]
        for i in range(len(ring) - 1):
            for j in range(len(outer) - 1):
                if _segments_intersect(ring[i], ring[i + 1], outer[j], outer[j + 1]):
                    return True
    return False


# ----------------------------------------------------------------------------- UTM / MGRS (WGS84, Krüger series)

_A, _F, _K0 = 6378137.0, 1 / 298.257223563, 0.9996
_N = _F / (2 - _F)
_AA = _A / (1 + _N) * (1 + _N**2 / 4 + _N**4 / 64)
_ALPHA = (_N / 2 - 2 * _N**2 / 3 + 5 * _N**3 / 16, 13 * _N**2 / 48 - 3 * _N**3 / 5, 61 * _N**3 / 240)
_BETA = (_N / 2 - 2 * _N**2 / 3 + 37 * _N**3 / 96, _N**2 / 48 + _N**3 / 15, 17 * _N**3 / 480)
_DELTA = (2 * _N - 2 * _N**2 / 3 - 2 * _N**3, 7 * _N**2 / 3 - 8 * _N**3 / 5, 56 * _N**3 / 15)
_E = 2 * math.sqrt(_N) / (1 + _N)


def utm_zone(lon: float) -> int:
    return int((lon + 180) // 6) % 60 + 1


def epsg_utm(epsg: int) -> tuple[int, bool]:
    """EPSG 326xx / 327xx -> (zone, southern hemisphere)."""
    if 32601 <= epsg <= 32660:
        return epsg - 32600, False
    if 32701 <= epsg <= 32760:
        return epsg - 32700, True
    raise ValueError(f"EPSG:{epsg} is not a WGS84 UTM zone")


def utm_forward(lat, lon, zone: int, south: bool):
    """Geographic -> UTM easting/northing (metres). Accepts numpy arrays."""
    import numpy as np

    phi = np.radians(np.asarray(lat, dtype=float))
    lam = np.radians(np.asarray(lon, dtype=float)) - math.radians(zone * 6 - 183)
    t = np.sinh(np.arctanh(np.sin(phi)) - _E * np.arctanh(_E * np.sin(phi)))
    xi_p = np.arctan2(t, np.cos(lam))
    eta_p = np.arctanh(np.sin(lam) / np.sqrt(1 + t * t))
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi = xi + a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta = eta + a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    e = 500000 + _K0 * _AA * eta
    n = _K0 * _AA * xi + (10_000_000 if south else 0)
    return e, n


def utm_inverse(e, n, zone: int, south: bool):
    """UTM easting/northing -> (lat, lon) degrees. Accepts numpy arrays."""
    import numpy as np

    xi = (np.asarray(n, dtype=float) - (10_000_000 if south else 0)) / (_K0 * _AA)
    eta = (np.asarray(e, dtype=float) - 500000) / (_K0 * _AA)
    xi_p, eta_p = xi.copy(), eta.copy()
    for j, b in enumerate(_BETA, start=1):
        xi_p = xi_p - b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta_p = eta_p - b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    phi = chi.copy()
    for j, d in enumerate(_DELTA, start=1):
        phi = phi + d * np.sin(2 * j * chi)
    lam = math.radians(zone * 6 - 183) + np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    return np.degrees(phi), np.degrees(lam)


_BANDS = "CDEFGHJKLMNPQRSTUVWX"
_COL_SETS = ("STUVWXYZ", "ABCDEFGH", "JKLMNPQR")  # indexed by zone % 3
_ROWS = "ABCDEFGHJKLMNPQRSTUV"


def mgrs_tile(lat: float, lon: float) -> tuple[int, str, str]:
    """Sentinel-2 / MGRS 100 km tile: (zone, latitude band, two-letter square)."""
    zone = utm_zone(lon)
    band = _BANDS[min(len(_BANDS) - 1, max(0, int((lat + 80) // 8)))]
    e, n = utm_forward(lat, lon, zone, lat < 0)
    col = _COL_SETS[zone % 3][int(float(e) // 100000) - 1]
    row = _ROWS[(int(float(n) // 100000) + (5 if zone % 2 == 0 else 0)) % 20]
    return zone, band, col + row
