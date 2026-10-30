/* Wind arrows on a MapLibre map: fetches the wind grid for the current view (debounced on moveend),
 * draws rotated, speed-coloured arrows and offers a forecast-hour slider with a km/h legend. */
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { storage } from "../api/client";
import type { WindField } from "../api/types";
import { formatDate, useT } from "../i18n";
import type { BBox } from "../lib/geo";
import { bboxString } from "../lib/geo";
import { WIND_BANDS, WIND_IMAGE, WIND_LAYER, WIND_SOURCE, arrowSDF, bboxContains, nearestHour, windBBox, windFeatures, windLegend } from "./wind";

export type WindFetcher = (bbox: string, n: number, signal: AbortSignal) => Promise<WindField>;

export function viewBBox(map: MlMap): BBox {
  const b = map.getBounds();
  return [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
}

function ensureWindLayer(map: MlMap) {
  if (!map.hasImage(WIND_IMAGE)) map.addImage(WIND_IMAGE, arrowSDF(48, 6), { sdf: true, pixelRatio: 2 });
  if (!map.getSource(WIND_SOURCE)) map.addSource(WIND_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  if (!map.getLayer(WIND_LAYER)) {
    const step: unknown[] = ["step", ["get", "speed"], WIND_BANDS[0]!.color];
    WIND_BANDS.slice(1).forEach((b) => step.push(b.min, b.color));
    map.addLayer({
      id: WIND_LAYER,
      type: "symbol",
      source: WIND_SOURCE,
      layout: {
        "icon-image": WIND_IMAGE,
        "icon-rotate": ["get", "rot"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["get", "speed"], 0, 0.55, 20, 0.8, 60, 1.25],
      },
      paint: {
        "icon-color": step as never,
        "icon-halo-color": "rgba(8,10,14,0.75)",
        "icon-halo-width": 1.2,
        "icon-opacity": 0.92,
      },
    });
  }
}

/** Persisted on/off toggle for the wind layer. */
export function useWindToggle(key = "fa_wind"): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => storage.get(key) === "1");
  const set = useCallback(
    (v: boolean) => {
      setOn(v);
      storage.set(key, v ? "1" : null);
    },
    [key],
  );
  return [on, set];
}

export interface WindState {
  field: WindField | null;
  hour: number;
  setHour: (h: number) => void;
  loading: boolean;
  error: string | null;
}

export function useWindLayer(map: MlMap | null, enabled: boolean, fetcher: WindFetcher, n = 12): WindState {
  const [field, setField] = useState<WindField | null>(null);
  const [hour, setHour] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastBox = useRef<BBox | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  // Load for the current view; skip when the view is still inside the last fetched box at a similar scale.
  useEffect(() => {
    if (!map || !enabled) return;
    ensureWindLayer(map);
    map.setLayoutProperty(WIND_LAYER, "visibility", "visible");
    let ac: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (force = false) => {
      const view = viewBBox(map);
      const box = windBBox(view);
      const prev = lastBox.current;
      const span = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
      if (!force && prev && bboxContains(prev, view) && span(box) > span(prev) * 0.25) return;
      ac?.abort();
      ac = new AbortController();
      const signal = ac.signal;
      setLoading(true);
      fetchRef
        .current(bboxString(box, 2), n, signal)
        .then((f) => {
          if (signal.aborted) return;
          lastBox.current = box;
          setField(f);
          setError(null);
          setHour((h) => (f.hours.length ? (h > 0 && h < f.hours.length ? h : nearestHour(f.hours)) : 0));
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") setError(err.message);
        })
        .finally(() => !signal.aborted && setLoading(false));
    };
    const onMove = () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(), 600);
    };
    load(true);
    map.on("moveend", onMove);
    return () => {
      clearTimeout(timer);
      ac?.abort();
      map.off("moveend", onMove);
      if (map.getLayer(WIND_LAYER)) map.setLayoutProperty(WIND_LAYER, "visibility", "none");
      lastBox.current = null;
    };
  }, [map, enabled, n]);

  useEffect(() => {
    if (!map || !enabled) return;
    (map.getSource(WIND_SOURCE) as GeoJSONSource | undefined)?.setData(windFeatures(field, hour));
  }, [map, enabled, field, hour]);

  return { field, hour, setHour, loading, error };
}

/** Floating panel with the forecast-hour slider and the km/h legend. */
export function WindPanel({ state, onClose, style }: { state: WindState; onClose?: () => void; style?: React.CSSProperties }) {
  const { t } = useT();
  const { field, hour, setHour, loading, error } = state;
  const hours = field?.hours ?? [];
  const label = hours[hour] ? formatDate(new Date(hours[hour]!), { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  return (
    <div className="map-overlay wind-panel" style={style} role="group" aria-label={t("wind.title")}>
      <div className="row between">
        <b className="small">{t("wind.title")}</b>
        <span className="row" style={{ gap: 6 }}>
          {loading && <span className="spinner" role="status" aria-label={t("common.loading")} />}
          {onClose && (
            <button className="close-btn" style={{ width: 20, height: 20 }} onClick={onClose} aria-label={t("wind.hide")} title={t("wind.hide")}>
              ×
            </button>
          )}
        </span>
      </div>
      {error ? (
        <div className="tiny bad-text mt-4">{t("wind.error")}</div>
      ) : (
        <>
          <label className="tiny muted mt-4" style={{ display: "block" }}>
            <span className="row between">
              <span>{label}</span>
              <span>{hour > 0 && hours[0] ? t("wind.plusHours", { n: Math.round((new Date(hours[hour]!).getTime() - new Date(hours[0]).getTime()) / 3.6e6) }) : t("wind.now")}</span>
            </span>
            <input type="range" min={0} max={Math.max(0, hours.length - 1)} value={hour} disabled={hours.length < 2} onChange={(e) => setHour(+e.target.value)} aria-label={t("wind.hour")} style={{ width: "100%" }} />
          </label>
          <div className="wind-legend" aria-label={t("wind.legend")}>
            {windLegend().map((b) => (
              <span key={b.label}>
                <i style={{ background: b.color }} />
                {b.label}
              </span>
            ))}
            <span className="muted">km/h</span>
          </div>
          {field?.source === "demo" && <div className="tiny faint mt-4">{t("wind.demo")}</div>}
        </>
      )}
    </div>
  );
}
