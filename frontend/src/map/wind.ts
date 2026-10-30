/* Wind layer helpers: request bbox, arrow geometry (as an SDF image for MapLibre), colours and features.
 * Pure functions (no MapLibre import) so they can be unit-tested. */
import type { Feature, FeatureCollection, Point } from "geojson";
import type { WindField } from "../api/types";
import type { BBox } from "../lib/geo";

export const WIND_IMAGE = "fa-wind-arrow";
export const WIND_SOURCE = "wind";
export const WIND_LAYER = "wind-arrows";
/** Max request area accepted by the API, and the minimum (coarser grids are pointless below 1°). */
export const WIND_MAX: [number, number] = [60, 40];
export const WIND_MIN: [number, number] = [1, 1];

/** Speed classes for colour and legend (km/h, lower bounds). */
export const WIND_BANDS: { min: number; color: string }[] = [
  { min: 0, color: "#9fd3ff" },
  { min: 10, color: "#5aa9ff" },
  { min: 20, color: "#3ecf8e" },
  { min: 30, color: "#ffd84d" },
  { min: 40, color: "#ff9a3c" },
  { min: 60, color: "#ff4d5e" },
];

export function windColor(kmh: number): string {
  let c = WIND_BANDS[0]!.color;
  for (const b of WIND_BANDS) if (kmh >= b.min) c = b.color;
  return c;
}

/** Legend labels: "0–10", "10–20", … "60+". */
export function windLegend(): { label: string; color: string }[] {
  return WIND_BANDS.map((b, i) => {
    const next = WIND_BANDS[i + 1];
    return { label: next ? `${b.min}–${next.min}` : `${b.min}+`, color: b.color };
  });
}

/** Meteorological direction (wind comes FROM) → bearing the arrow points TO. */
export function toBearing(dirFrom: number): number {
  return (((dirFrom + 180) % 360) + 360) % 360;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Request bbox for a map view: at least 1°×1°, at most 60°×40° around the view centre, clipped to the globe. */
export function windBBox([w, s, e, n]: BBox, min = WIND_MIN, max = WIND_MAX): BBox {
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hw = Math.min(max[0] / 2, Math.max(min[0] / 2, (e - w) / 2));
  const hh = Math.min(max[1] / 2, Math.max(min[1] / 2, (n - s) / 2));
  let west = cx - hw, east = cx + hw, south = cy - hh, north = cy + hh;
  // Shift (rather than shrink) at the edges of the world so the box keeps its size.
  if (west < -180) (east += -180 - west), (west = -180);
  if (east > 180) (west -= east - 180), (east = 180);
  if (south < -85) (north += -85 - south), (south = -85);
  if (north > 85) (south -= north - 85), (north = 85);
  return [r2(Math.max(-180, west)), r2(Math.max(-85, south)), r2(Math.min(180, east)), r2(Math.min(85, north))];
}

/** True when `inner` lies within `outer` (used to skip refetching after small pans). */
export function bboxContains(outer: BBox, inner: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export interface WindPointProps {
  speed: number;
  dir: number;
  rot: number;
}

/** Arrow features for one forecast hour index. */
export function windFeatures(field: WindField | null | undefined, hour: number): FeatureCollection<Point, WindPointProps> {
  const features: Feature<Point, WindPointProps>[] = [];
  for (const f of field?.features ?? []) {
    const speed = f.properties.speed[hour];
    const dir = f.properties.dir[hour];
    if (speed == null || dir == null || !Number.isFinite(speed) || !Number.isFinite(dir)) continue;
    features.push({ type: "Feature", geometry: f.geometry, properties: { speed, dir, rot: toBearing(dir) } });
  }
  return { type: "FeatureCollection", features };
}

/** Index of the forecast hour closest to `now` (the first hour by default). */
export function nearestHour(hours: string[], now = Date.now()): number {
  let best = 0, bd = Infinity;
  hours.forEach((h, i) => {
    const d = Math.abs(new Date(h).getTime() - now);
    if (d < bd) (bd = d), (best = i);
  });
  return best;
}

// ------------------------------------------------------------------ arrow image (signed distance field)

/** Arrow outline pointing north, in unit coordinates (x right, y down). */
export const ARROW_SHAPE: [number, number][] = [
  [0.5, 0.06], [0.78, 0.44], [0.58, 0.44], [0.58, 0.94], [0.42, 0.94], [0.42, 0.44], [0.22, 0.44],
];

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * RGBA pixels for the arrow as a MapLibre SDF icon: alpha 191 (0.75) on the outline, higher inside, lower outside,
 * so `icon-color` tints it by speed and `icon-halo-*` draws an outline.
 */
export function arrowSDF(size = 48, buffer = 6): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(size * size * 4);
  const pad = buffer / size;
  const poly = ARROW_SHAPE.map(([x, y]) => [(pad + x * (1 - 2 * pad)) * size, (pad + y * (1 - 2 * pad)) * size] as [number, number]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let d = Infinity;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(px, py, poly[j]![0], poly[j]![1], poly[i]![0], poly[i]![1]));
      const signed = pointInPolygon(px, py, poly) ? d : -d;
      const a = Math.max(0, Math.min(255, Math.round(191 + (signed / buffer) * 64)));
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = a;
    }
  }
  return { width: size, height: size, data };
}
