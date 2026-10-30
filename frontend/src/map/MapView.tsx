/* MapLibre wrapper with a basemap / imagery-overlay switcher. */
import maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { storage } from "../api/client";
import { IconLayers } from "../components/Icons";
import { BASEMAPS, DEFAULT_BASEMAP, buildStyle, imageryOverlays } from "./layers";
import { hasKey, t as tr, useT } from "../i18n";

/** An extra on/off layer offered in the switcher (e.g. wind). */
export interface ExtraLayerToggle {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

const tl = (key: string, fallback: string) => (hasKey(key) ? tr(key) : fallback);

export interface MapViewProps {
  center?: [number, number];
  zoom?: number;
  /** Sync position with the URL hash (#lat,lon,zoom). */
  hash?: boolean;
  onReady?: (map: MlMap) => void;
  children?: ReactNode;
  className?: string;
  /** Position of the layer switcher. */
  switcher?: "top-right" | "top-left" | false;
  ariaLabel?: string;
  interactive?: boolean;
  /** Extra toggles shown in the layer switcher under "Weather & overlays". */
  extraLayers?: ExtraLayerToggle[];
}

function parseHash(): { center: [number, number]; zoom: number } | null {
  const parts = window.location.hash.slice(1).split(",").map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite) && Math.abs(parts[0]!) <= 90 && Math.abs(parts[1]!) <= 180) {
    return { center: [parts[1]!, parts[0]!], zoom: parts[2]! };
  }
  return null;
}

export function MapView({ center = [-30, 5], zoom = 1.6, hash, onReady, children, className, switcher = "top-right", ariaLabel, interactive = true, extraLayers }: MapViewProps) {
  const { t } = useT();
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [basemap, setBasemap] = useState<string>(() => storage.get("fa_basemap") || DEFAULT_BASEMAP);
  const [overlays, setOverlays] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const fromHash = hash ? parseHash() : null;
    let map: MlMap;
    try {
      map = new maplibregl.Map({
        container: el.current,
        style: buildStyle(basemap, overlays),
        center: fromHash?.center ?? center,
        zoom: fromHash?.zoom ?? zoom,
        attributionControl: { compact: true },
        interactive,
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: 0,
      });
    } catch (err) {
      setFailed((err as Error).message || tr("map.noWebgl"));
      return;
    }
    mapRef.current = map;
    if (interactive) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    }
    map.touchZoomRotate.disableRotation();
    if (hash) {
      map.on("moveend", () => {
        const c = map.getCenter();
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom().toFixed(1)}`);
      });
    }
    // Ready as soon as the style is parsed (sources/layers/images can be added); "load" also waits for
    // basemap tiles, which can take long or never finish when a tile server is slow or blocked.
    let ready = false;
    const fireReady = () => {
      if (ready) return;
      ready = true;
      onReadyRef.current?.(map);
    };
    map.once("style.load", fireReady);
    map.once("load", fireReady);
    // Tiles that fail offline are not fatal; keep the console quiet.
    map.on("error", () => undefined);
    // MapLibre only listens to window resizes; containers also change size with layout,
    // tabs and drawers, which would otherwise leave a clipped canvas.
    // Only react to real size changes, once per frame: resize() interrupts camera animations.
    let last = { w: el.current.clientWidth, h: el.current.clientHeight };
    let frame = 0;
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const r = entries[0]?.contentRect;
            if (!r || (Math.round(r.width) === last.w && Math.round(r.height) === last.h)) return;
            last = { w: Math.round(r.width), h: Math.round(r.height) };
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => map.resize());
          })
        : null;
    observer?.observe(el.current);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap & overlay visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const b of BASEMAPS) if (map.getLayer(`base-${b.id}`)) map.setLayoutProperty(`base-${b.id}`, "visibility", b.id === basemap ? "visible" : "none");
      const active = BASEMAPS.find((b) => b.id === basemap);
      if (map.getLayer("base-labels")) map.setLayoutProperty("base-labels", "visibility", active?.labels ? "visible" : "none");
      for (const o of imageryOverlays()) if (map.getLayer(`overlay-${o.id}`)) map.setLayoutProperty(`overlay-${o.id}`, "visibility", overlays.includes(o.id) ? "visible" : "none");
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
    storage.set("fa_basemap", basemap);
  }, [basemap, overlays]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".layer-switcher")) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const overlayDefs = imageryOverlays();

  return (
    <div className={`map-box ${className ?? ""}`}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} role="region" aria-label={ariaLabel ?? t("map.aria")} />
      {failed && (
        <div className="loading-block" style={{ position: "absolute", inset: 0, flexDirection: "column" }}>
          <b>{t("map.unavailable")}</b>
          <span className="small">{failed}</span>
        </div>
      )}
      {switcher && (
        <div className="layer-switcher" style={switcher === "top-right" ? { top: 12, right: 12 } : { top: 12, left: 12 }}>
          <button className="btn icon map-overlay" style={{ background: "rgba(18,21,28,.92)" }} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("map.layers")} title={t("map.layers")}>
            <IconLayers />
          </button>
          {open && (
            <div className="panel map-overlay" style={switcher === "top-left" ? { left: 0, right: "auto" } : undefined} role="dialog" aria-label={t("map.layers")}>
              {extraLayers && extraLayers.length > 0 && (
                <>
                  <div className="section-title" style={{ margin: 0 }}>
                    {t("map.weather")}
                  </div>
                  {extraLayers.map((x) => (
                    <label key={x.id} className="opt">
                      <input type="checkbox" checked={x.checked} onChange={(e) => x.onChange(e.target.checked)} />
                      <span>
                        {x.label}
                        {x.description && <small>{x.description}</small>}
                      </span>
                    </label>
                  ))}
                </>
              )}
              <div className="section-title" style={{ margin: extraLayers?.length ? "6px 0 0" : 0 }}>
                {t("map.basemap")}
              </div>
              {BASEMAPS.map((b) => (
                <label key={b.id} className="opt">
                  <input type="radio" name="basemap" checked={basemap === b.id} onChange={() => setBasemap(b.id)} />
                  <span>
                    {tl(`basemap.${b.id}`, b.label)}
                    <small>{tl(`basemap.${b.id}.desc`, b.description)}</small>
                  </span>
                </label>
              ))}
              <div className="section-title" style={{ margin: "6px 0 0" }}>
                {t("map.dailyImagery")}
              </div>
              {overlayDefs.map((o) => (
                <label key={o.id} className="opt">
                  <input type="checkbox" checked={overlays.includes(o.id)} onChange={(e) => setOverlays((xs) => (e.target.checked ? [...xs, o.id] : xs.filter((x) => x !== o.id)))} />
                  <span>
                    {tl(`overlay.${o.id}`, o.label)}
                    <small>{o.description} · zoom ≤ 9</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
