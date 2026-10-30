import { t } from "../i18n";
/* A small, robust draw tool: click to add vertices (polygon) or centre + radius (circle).
 * The geometry logic is pure (and unit-tested); DrawController binds it to a MapLibre map. */
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { circlePolygon, haversineKm, polygonFromVertices } from "../lib/geo";
import type { LngLat } from "../lib/geo";

export type DrawMode = "polygon" | "circle";

export interface DrawState {
  mode: DrawMode;
  vertices: LngLat[];
  center: LngLat | null;
  radiusKm: number | null;
  /** Mouse position for the rubber-band preview. */
  cursor: LngLat | null;
}

export const emptyDraw = (mode: DrawMode = "polygon"): DrawState => ({ mode, vertices: [], center: null, radiusKm: null, cursor: null });

export function addPoint(s: DrawState, p: LngLat): DrawState {
  if (s.mode === "polygon") return { ...s, vertices: [...s.vertices, p] };
  if (!s.center) return { ...s, center: p, radiusKm: null };
  return { ...s, radiusKm: Math.max(0.05, haversineKm(s.center, p)) };
}

export function undoPoint(s: DrawState): DrawState {
  if (s.mode === "polygon") return { ...s, vertices: s.vertices.slice(0, -1) };
  if (s.radiusKm != null) return { ...s, radiusKm: null };
  return { ...s, center: null };
}

export function setRadius(s: DrawState, km: number): DrawState {
  return { ...s, radiusKm: km > 0 ? km : null };
}

export type DrawResult = { ok: true; polygon: Polygon; areaHa: number; center?: LngLat; radiusKm?: number } | { ok: false; reason: string };

/** Validate the current drawing and produce a polygon. */
export function drawResult(s: DrawState): DrawResult {
  if (s.mode === "polygon") return polygonFromVertices(s.vertices);
  if (!s.center) return { ok: false, reason: t("draw.placeCentre") };
  if (!s.radiusKm) return { ok: false, reason: t("draw.setRadius") };
  if (s.radiusKm > 200) return { ok: false, reason: t("draw.maxRadius") };
  const polygon = circlePolygon(s.center, s.radiusKm);
  return { ok: true, polygon, areaHa: Math.PI * (s.radiusKm * 1000) ** 2 / 10_000, center: s.center, radiusKm: s.radiusKm };
}

/** GeoJSON for rendering the in-progress drawing. */
export function drawFeatures(s: DrawState): FeatureCollection {
  const feats: Feature[] = [];
  if (s.mode === "polygon") {
    const v = s.vertices;
    const pts = s.cursor && v.length ? [...v, s.cursor] : v;
    if (pts.length >= 3) feats.push({ type: "Feature", properties: { role: "fill" }, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]!]] } });
    if (pts.length >= 2) feats.push({ type: "Feature", properties: { role: "line" }, geometry: { type: "LineString", coordinates: pts.length >= 3 ? [...pts, pts[0]!] : pts } });
    v.forEach((p, i) => feats.push({ type: "Feature", properties: { role: "vertex", first: i === 0 }, geometry: { type: "Point", coordinates: p } }));
  } else if (s.center) {
    const r = s.radiusKm ?? (s.cursor ? haversineKm(s.center, s.cursor) : 0);
    if (r > 0) {
      const poly = circlePolygon(s.center, r);
      feats.push({ type: "Feature", properties: { role: "fill" }, geometry: poly });
      feats.push({ type: "Feature", properties: { role: "line" }, geometry: { type: "LineString", coordinates: poly.coordinates[0]! } });
    }
    feats.push({ type: "Feature", properties: { role: "vertex", first: true }, geometry: { type: "Point", coordinates: s.center } });
  }
  return { type: "FeatureCollection", features: feats };
}

const SRC = "fa-draw";

/** Binds the draw state to a MapLibre map: click adds points, double-click / Enter finishes, Backspace undoes, Escape cancels. */
export class DrawController {
  private map: MlMap;
  private state: DrawState;
  private active = false;
  private onChange: (s: DrawState) => void;
  private onFinish?: (r: DrawResult) => void;

  constructor(map: MlMap, onChange: (s: DrawState) => void, onFinish?: (r: DrawResult) => void) {
    this.map = map;
    this.onChange = onChange;
    this.onFinish = onFinish;
    this.state = emptyDraw();
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: `${SRC}-fill`, type: "fill", source: SRC, filter: ["==", ["get", "role"], "fill"], paint: { "fill-color": "#ffb02b", "fill-opacity": 0.14 } });
      map.addLayer({ id: `${SRC}-line`, type: "line", source: SRC, filter: ["==", ["get", "role"], "line"], paint: { "line-color": "#ffb02b", "line-width": 2, "line-dasharray": [2, 1.5] } });
      map.addLayer({
        id: `${SRC}-vertex`, type: "circle", source: SRC, filter: ["==", ["get", "role"], "vertex"],
        paint: { "circle-radius": ["case", ["get", "first"], 6, 4.5], "circle-color": "#0b0d12", "circle-stroke-color": "#ffb02b", "circle-stroke-width": 2 },
      });
    }
  }

  get current(): DrawState {
    return this.state;
  }

  private set(s: DrawState) {
    this.state = s;
    (this.map.getSource(SRC) as GeoJSONSource | undefined)?.setData(drawFeatures(s));
    this.onChange(s);
  }

  private onClick = (e: MapMouseEvent) => {
    const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
    // Clicking the first vertex closes the polygon.
    if (this.state.mode === "polygon" && this.state.vertices.length >= 3) {
      const first = this.map.project(this.state.vertices[0]!);
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 10) {
        this.finish();
        return;
      }
    }
    this.set(addPoint(this.state, p));
    if (this.state.mode === "circle" && this.state.radiusKm) this.finish();
  };

  private onMove = (e: MapMouseEvent) => {
    if (this.state.mode === "polygon" ? this.state.vertices.length : this.state.center && !this.state.radiusKm) {
      this.set({ ...this.state, cursor: [e.lngLat.lng, e.lngLat.lat] });
    }
  };

  private onDbl = (e: MapMouseEvent) => {
    e.preventDefault();
    // The double-click also fired two clicks: drop the duplicate vertex.
    if (this.state.mode === "polygon" && this.state.vertices.length > 3) {
      const v = this.state.vertices;
      const a = v[v.length - 1]!, b = v[v.length - 2]!;
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) this.state = { ...this.state, vertices: v.slice(0, -1) };
    }
    this.finish();
  };

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Backspace" || (e.key === "z" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      this.undo();
    } else if (e.key === "Enter") this.finish();
  };

  start(mode: DrawMode) {
    this.stopListening();
    this.active = true;
    this.map.doubleClickZoom.disable();
    this.map.getCanvasContainer().classList.add("picking");
    this.map.on("click", this.onClick);
    this.map.on("mousemove", this.onMove);
    this.map.on("dblclick", this.onDbl);
    window.addEventListener("keydown", this.onKey);
    this.set(emptyDraw(mode));
  }

  undo() {
    this.set({ ...undoPoint(this.state), cursor: null });
  }

  setRadius(km: number) {
    this.set(setRadius(this.state, km));
  }

  /** Validate; on success stop listening and keep the shape displayed. */
  finish(): DrawResult {
    const r = drawResult(this.state);
    if (r.ok) {
      this.stopListening();
      this.set({ ...this.state, cursor: null });
    }
    this.onFinish?.(r);
    return r;
  }

  cancel() {
    this.stopListening();
    this.set(emptyDraw(this.state.mode));
  }

  /** Show an existing polygon (e.g. after finishing) without editing. */
  clear() {
    this.set(emptyDraw(this.state.mode));
  }

  private stopListening() {
    if (!this.active) return;
    this.active = false;
    this.map.off("click", this.onClick);
    this.map.off("mousemove", this.onMove);
    this.map.off("dblclick", this.onDbl);
    window.removeEventListener("keydown", this.onKey);
    this.map.getCanvasContainer().classList.remove("picking");
    setTimeout(() => this.map.doubleClickZoom?.enable(), 300);
  }

  get isActive() {
    return this.active;
  }

  destroy() {
    this.stopListening();
    try {
      for (const id of [`${SRC}-vertex`, `${SRC}-line`, `${SRC}-fill`]) if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(SRC)) this.map.removeSource(SRC);
    } catch {
      /* map already removed */
    }
  }
}
