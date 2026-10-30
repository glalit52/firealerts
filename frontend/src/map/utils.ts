import maplibregl from "maplibre-gl";
import type { GeoJSONSource, ImageSource, LayerSpecification, Map as MlMap } from "maplibre-gl";
import type { FeatureCollection, Geometry } from "geojson";
import type { AssetListItem, ImageCoordinates } from "../api/types";
import { bboxOf, flatCoords } from "../lib/geo";

export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

export function ensureSource(map: MlMap, id: string, data: FeatureCollection = EMPTY_FC) {
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data });
}

export function setData(map: MlMap | null | undefined, id: string, data: FeatureCollection) {
  const s = map?.getSource(id) as GeoJSONSource | undefined;
  s?.setData(data);
}

export function addLayer(map: MlMap, layer: LayerSpecification, before?: string) {
  if (map.getLayer(layer.id)) return;
  map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
}

export function setVisible(map: MlMap | null | undefined, id: string, on: boolean) {
  if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

export function fitGeometry(map: MlMap, geoms: Geometry[], opts: { padding?: number | { top: number; bottom: number; left: number; right: number }; maxZoom?: number; duration?: number } = {}) {
  const pts = geoms.flatMap((g) => flatCoords(g));
  const b = bboxOf(pts);
  if (!b) return;
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding: opts.padding ?? 40, maxZoom: opts.maxZoom ?? 13, duration: opts.duration ?? 0 },
  );
}

/** Add or update a georeferenced image overlay (forecast rasters, Sentinel-2 indices). */
export function setImage(map: MlMap, id: string, url: string, coordinates: ImageCoordinates, opts: { opacity?: number; before?: string; visible?: boolean } = {}) {
  const src = map.getSource(id) as ImageSource | undefined;
  if (src) src.updateImage({ url, coordinates });
  else {
    map.addSource(id, { type: "image", url, coordinates });
    map.addLayer(
      { id, type: "raster", source: id, paint: { "raster-opacity": opts.opacity ?? 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 }, layout: { visibility: opts.visible === false ? "none" : "visible" } },
      opts.before && map.getLayer(opts.before) ? opts.before : undefined,
    );
  }
  if (opts.visible !== undefined) setVisible(map, id, opts.visible);
}

export function removeImage(map: MlMap | null | undefined, id: string) {
  if (!map) return;
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

/** Asset polygons as a FeatureCollection (requires geometry). */
export function assetsToFC(items: AssetListItem[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items
      .filter((a) => a.geometry)
      .map((a) => ({ type: "Feature", geometry: a.geometry!, properties: { id: a.id, name: a.name, kind: a.kind, open_alerts: a.open_alerts, danger: a.risk_today?.danger ?? "" } })),
  };
}

/** Standard asset layers (fill, outline, label-less). */
export function addAssetLayers(map: MlMap, source = "assets") {
  ensureSource(map, source);
  addLayer(map, { id: `${source}-fill`, type: "fill", source, paint: { "fill-color": "#5aa9ff", "fill-opacity": 0.08 } });
  addLayer(map, {
    id: `${source}-line`,
    type: "line",
    source,
    paint: { "line-color": ["case", [">", ["coalesce", ["get", "open_alerts"], 0], 0], "#ff9a3c", "#5aa9ff"], "line-width": 1.8 },
  });
}

export function popup(lngLat: [number, number], html: string, map: MlMap) {
  return new maplibregl.Popup({ offset: 8, maxWidth: "300px" }).setLngLat(lngLat).setHTML(html).addTo(map);
}

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Detections: heatmap at low zoom, age-coloured circles when zoomed in. */
export function addDetectionLayers(map: MlMap, source = "dets", opts: { heat?: boolean; minzoom?: number } = {}) {
  ensureSource(map, source);
  if (opts.heat !== false) {
    addLayer(map, {
      id: `${source}-heat`,
      type: "heatmap",
      source,
      maxzoom: 7,
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 0.2, 100, 1],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 7, 2],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 7, 18],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "#7a1f2b", 0.45, "#e0442a", 0.7, "#ff9f43", 1, "#fff3b0"],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.9, 7, 0],
      },
    });
  }
  const minzoom = opts.minzoom ?? (opts.heat === false ? 0 : 4.5);
  addLayer(map, {
    id: `${source}-pts`,
    type: "circle",
    source,
    minzoom,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 2, 200, 5], 12, ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 4, 200, 11]],
      "circle-color": ["step", ["coalesce", ["get", "age_h"], 0], "#fff3b0", 1, "#ffb02b", 6, "#ff6a2b", 12, "#b3263b"],
      "circle-stroke-color": ["match", ["get", "kind"], "geo", "#ffffff", "rgba(0,0,0,0.6)"],
      "circle-stroke-width": ["match", ["get", "kind"], "geo", 1, 0.5],
      ...(opts.heat === false
        ? { "circle-opacity": 0.95 }
        : { "circle-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 0, 5.5, 0.95], "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 0, 5.5, 1] }),
    },
  });
}

export function annotateDetections<T extends FeatureCollection>(fc: T, now = Date.now()): T {
  for (const f of fc.features) {
    const p = f.properties as Record<string, unknown>;
    p.age_h = (now - new Date(String(p.acq_time)).getTime()) / 3.6e6;
    p.kind = /^(GOES|HIMAWARI|METEOSAT)/.test(String(p.source)) ? "geo" : "polar";
  }
  return fc;
}
