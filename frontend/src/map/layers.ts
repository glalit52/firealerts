/* Basemaps and imagery overlays — all tile endpoints live here so they are easy to change. */
import type { StyleSpecification } from "maplibre-gl";

export interface RasterLayerDef {
  id: string;
  label: string;
  description: string;
  tiles: string[];
  tileSize: number;
  maxzoom?: number;
  attribution: string;
  /** Show the CARTO label overlay on top (useful for imagery basemaps). */
  labels?: boolean;
  opacity?: number;
}

export const BASEMAPS: RasterLayerDef[] = [
  {
    id: "dark",
    label: "Dark",
    description: "CARTO dark streets",
    tiles: ["a", "b", "c"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`),
    tileSize: 256,
    maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  },
  {
    id: "imagery",
    label: "Satellite",
    description: "Esri World Imagery",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    tileSize: 256,
    maxzoom: 18,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    labels: true,
  },
  {
    id: "s2cloudless",
    label: "Sentinel-2",
    description: "EOX Sentinel-2 cloudless 2023",
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg"],
    tileSize: 256,
    maxzoom: 15,
    attribution: 'Sentinel-2 cloudless 2023 by <a href="https://s2maps.eu">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2023)',
    labels: true,
  },
];

export const LABELS: RasterLayerDef = {
  id: "labels",
  label: "Labels",
  description: "Place names",
  tiles: ["a", "b", "c"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png`),
  tileSize: 256,
  maxzoom: 19,
  attribution: "© CARTO",
};

/** Yesterday (UTC) as YYYY-MM-DD: GIBS daily mosaics are complete for the previous day. */
export function gibsDate(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

function gibs(layer: string, date: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

/** Daily true-colour overlays from NASA GIBS (max zoom 9). */
export function imageryOverlays(date: string = gibsDate()): RasterLayerDef[] {
  return [
    {
      id: "gibs-modis",
      label: "MODIS Terra true colour",
      description: `NASA GIBS daily · ${date}`,
      tiles: [gibs("MODIS_Terra_CorrectedReflectance_TrueColor", date)],
      tileSize: 256,
      maxzoom: 9,
      attribution: "NASA EOSDIS GIBS",
      opacity: 0.85,
    },
    {
      id: "gibs-viirs",
      label: "VIIRS S-NPP true colour",
      description: `NASA GIBS daily · ${date}`,
      tiles: [gibs("VIIRS_SNPP_CorrectedReflectance_TrueColor", date)],
      tileSize: 256,
      maxzoom: 9,
      attribution: "NASA EOSDIS GIBS",
      opacity: 0.85,
    },
  ];
}

export const DEFAULT_BASEMAP = "dark";

/** A style with every basemap and overlay as hidden raster layers; the active basemap is visible. */
export function buildStyle(basemap: string = DEFAULT_BASEMAP, overlays: string[] = []): StyleSpecification {
  const ov = imageryOverlays();
  const all = [...BASEMAPS, ...ov, LABELS];
  const active = BASEMAPS.find((b) => b.id === basemap) ?? BASEMAPS[0]!;
  const sources: StyleSpecification["sources"] = {};
  for (const l of all) {
    sources[l.id] = { type: "raster", tiles: l.tiles, tileSize: l.tileSize, maxzoom: l.maxzoom, attribution: l.attribution };
  }
  return {
    version: 8,
    sources,
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0d1016" } },
      ...BASEMAPS.map((b) => ({ id: `base-${b.id}`, type: "raster" as const, source: b.id, layout: { visibility: (b.id === active.id ? "visible" : "none") as "visible" | "none" } })),
      ...ov.map((o) => ({
        id: `overlay-${o.id}`,
        type: "raster" as const,
        source: o.id,
        paint: { "raster-opacity": o.opacity ?? 1 },
        layout: { visibility: (overlays.includes(o.id) ? "visible" : "none") as "visible" | "none" },
      })),
      { id: "base-labels", type: "raster", source: LABELS.id, layout: { visibility: active.labels ? "visible" : "none" } },
    ],
  };
}

/** Id of the topmost raster (basemap) layer: data layers inserted below it would be hidden, so add above this. */
export const BASE_TOP_LAYER = "base-labels";
