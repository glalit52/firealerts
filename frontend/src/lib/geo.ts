/* Small, dependency-free geometry helpers (WGS84 lon/lat). */

import type { Geometry, MultiPolygon, Polygon, Position } from "geojson";

export type LngLat = [number, number];
export type BBox = [number, number, number, number];

const R_EARTH_M = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Area of a ring on the sphere in m² (Chamberlain & Duquette; same as @mapbox/geojson-area). */
export function ringAreaM2(ring: Position[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i]!;
    const p2 = ring[(i + 1) % n]!;
    const p3 = ring[(i + 2) % n]!;
    total += (rad(p3[0]!) - rad(p1[0]!)) * Math.sin(rad(p2[1]!));
  }
  return Math.abs((total * R_EARTH_M * R_EARTH_M) / 2);
}

/** Area in hectares of a Polygon or MultiPolygon (outer rings minus holes). */
export function areaHa(geom: Polygon | MultiPolygon): number {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let m2 = 0;
  for (const rings of polys) {
    rings.forEach((ring, i) => {
      const a = ringAreaM2(ring);
      m2 += i === 0 ? a : -a;
    });
  }
  return m2 / 10_000;
}

/** Remove consecutive duplicates and an explicit closing vertex. */
export function cleanVertices(vertices: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const v of vertices) {
    const last = out[out.length - 1];
    if (!last || last[0] !== v[0] || last[1] !== v[1]) out.push([v[0], v[1]]);
  }
  if (out.length > 1) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  return out;
}

/** Closed ring from open vertices. */
export function closeRing(vertices: LngLat[]): LngLat[] {
  const v = cleanVertices(vertices);
  return v.length ? [...v, [v[0]![0], v[0]![1]]] : [];
}

function orient(a: LngLat, b: LngLat, c: LngLat): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) < 1e-14 ? 0 : v > 0 ? 1 : -1;
}

function onSegment(a: LngLat, b: LngLat, p: LngLat): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** Do segments ab and cd intersect (including touching)? */
export function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/** True if the closed polygon through these vertices crosses itself. */
export function isSelfIntersecting(vertices: LngLat[]): boolean {
  const v = cleanVertices(vertices);
  const n = v.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = v[i]!, b = v[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // skip adjacent edges (they share a vertex)
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = v[j]!, d = v[(j + 1) % n]!;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

export type PolygonCheck = { ok: true; polygon: Polygon; areaHa: number } | { ok: false; reason: string };

/** Build and validate a polygon from drawn vertices. */
export function polygonFromVertices(vertices: LngLat[]): PolygonCheck {
  const v = cleanVertices(vertices);
  if (v.length < 3) return { ok: false, reason: "Add at least 3 points to make an area." };
  if (isSelfIntersecting(v)) return { ok: false, reason: "The outline crosses itself. Undo the last points and try again." };
  const polygon: Polygon = { type: "Polygon", coordinates: [closeRing(v)] };
  const ha = areaHa(polygon);
  if (ha <= 0.01) return { ok: false, reason: "The area is too small." };
  return { ok: true, polygon, areaHa: ha };
}

/** Destination point given start, bearing (deg) and distance (km). */
export function destination([lon, lat]: LngLat, bearingDeg: number, km: number): LngLat {
  const d = km / 6371.0088;
  const b = rad(bearingDeg);
  const p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(((l2 * 180) / Math.PI + 540) % 360) - 180, (p2 * 180) / Math.PI];
}

/** Circle approximated by a polygon. */
export function circlePolygon(center: LngLat, radiusKm: number, steps = 64): Polygon {
  const ring: LngLat[] = [];
  for (let i = 0; i < steps; i++) ring.push(destination(center, (i * 360) / steps, radiusKm));
  ring.push([ring[0]![0], ring[0]![1]]);
  return { type: "Polygon", coordinates: [ring] };
}

/** All positions of any geometry. */
export function flatCoords(geom: Geometry): LngLat[] {
  const out: LngLat[] = [];
  const walk = (a: unknown): void => {
    if (Array.isArray(a) && typeof a[0] === "number") out.push([a[0] as number, a[1] as number]);
    else if (Array.isArray(a)) a.forEach(walk);
  };
  if (geom.type === "GeometryCollection") geom.geometries.forEach((g) => out.push(...flatCoords(g)));
  else walk((geom as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates);
  return out;
}

export function bboxOf(points: LngLat[]): BBox | null {
  if (!points.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

export function bboxString(b: BBox, digits = 4): string {
  return b.map((v) => v.toFixed(digits)).join(",");
}

/** Expand a bbox to at least the given size in degrees (the weather grid is ~10 km). */
export function expandBBox([w, s, e, n]: BBox, minW = 3, minH = 2): BBox {
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const hw = Math.max(minW / 2, (e - w) / 2), hh = Math.max(minH / 2, (n - s) / 2);
  return [Math.max(-180, cx - hw), Math.max(-85, cy - hh), Math.min(180, cx + hw), Math.min(85, cy + hh)];
}

/** Clamp a bbox to the API's maximum area (60° × 40°) around its centre. */
export function clampBBox([w, s, e, n]: BBox, maxW = 59.9, maxH = 39.9): BBox {
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const hw = Math.min(maxW / 2, (e - w) / 2), hh = Math.min(maxH / 2, (n - s) / 2);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}
