/* Public live fire map (/live): no sign-in needed, data from /api/public/*. Read-only — no forecasts. */
import type { Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, storage } from "../api/client";
import { publicApi } from "../api/endpoints";
import type { DetectionCollection, Incident, PublicStatus } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { FlameLogo, IconArrowRight, IconMap, IconRefresh } from "../components/Icons";
import { LanguageSelect } from "../components/LanguageSwitcher";
import { Checkbox, EmptyState, Spinner } from "../components/ui";
import { useT } from "../i18n";
import { AGE_COLORS, SENSOR_GROUPS } from "../lib/constants";
import { fmtNum, timeAgo } from "../lib/format";
import { bboxString } from "../lib/geo";
import { HIDE_STATIC_KEY, countStatic, filterDetections, filterIncidents } from "../lib/staticSources";
import { useDocumentTitle } from "../lib/useAsync";
import { MapView } from "../map/MapView";
import { detectionPopup } from "../map/popups";
import { WindPanel, useWindLayer, useWindToggle, viewBBox } from "../map/WindLayer";
import { windBBox } from "../map/wind";
import { addDetectionLayers, addLayer, annotateDetections, ensureSource, popup, setData } from "../map/utils";
import { IncidentRow } from "../components/IncidentRow";

/** The public endpoints require a bbox of at most 60°×40°: same clamping as the wind layer, but no minimum. */
function publicBBox(map: MlMap): string {
  return bboxString(windBBox(viewBBox(map), [0.5, 0.5]), 3);
}

export default function PublicMap() {
  const { t } = useT();
  useDocumentTitle(t("public.title"));
  const { meta, me } = useAuth();
  const [map, setMap] = useState<MlMap | null>(null);
  const [hours, setHours] = useState(24);
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [dets, setDets] = useState<DetectionCollection | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(meta?.public_map === false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hideStatic, setHideStaticState] = useState(() => storage.get(HIDE_STATIC_KEY) !== "0");
  const [windOn, setWindOn] = useWindToggle("fa_public_wind");
  const wind = useWindLayer(map, windOn && !disabled, (bbox, n, signal) => publicApi.wind(bbox, n, signal));
  const ac = useRef<AbortController | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    if (meta?.public_map === false) setDisabled(true);
  }, [meta]);

  const setHideStatic = (v: boolean) => {
    setHideStaticState(v);
    storage.set(HIDE_STATIC_KEY, v ? null : "0");
  };

  const load = useCallback(async () => {
    if (!map || disabled) return;
    ac.current?.abort();
    const ctl = new AbortController();
    ac.current = ctl;
    const box = publicBBox(map);
    setLoading(true);
    try {
      const [st, fc, inc] = await Promise.all([publicApi.status(), publicApi.detections(box, hours, ctl.signal), publicApi.incidents(box, 1, ctl.signal)]);
      if (ctl.signal.aborted) return;
      setStatus(st);
      setDets(annotateDetections(fc));
      setIncidents([...inc.incidents].sort((a, b) => b.priority - a.priority));
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (err instanceof ApiError && err.status === 404) setDisabled(true);
      else setError((err as Error).message);
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, [map, hours, disabled]);

  // Reload on view changes (debounced) and every 5 minutes.
  useEffect(() => {
    if (!map) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 700);
    };
    map.on("moveend", onMove);
    const poll = setInterval(() => void load(), 300_000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      map.off("moveend", onMove);
    };
  }, [map, load]);

  const visibleIncidents = useMemo(() => filterIncidents(incidents, hideStatic), [incidents, hideStatic]);
  const staticCount = useMemo(() => countStatic(incidents), [incidents]);
  const shownDets = useMemo(() => (dets ? filterDetections(dets, hideStatic) : null), [dets, hideStatic]);

  useEffect(() => {
    if (map) setData(map, "pdets", shownDets ?? { type: "FeatureCollection", features: [] });
  }, [map, shownDets]);
  useEffect(() => {
    if (!map) return;
    setData(map, "phulls", { type: "FeatureCollection", features: visibleIncidents.filter((i) => i.hull).map((i) => ({ type: "Feature" as const, geometry: i.hull!, properties: { id: i.id, sel: i.id === selected } })) });
  }, [map, visibleIncidents, selected]);

  const onReady = useCallback((m: MlMap) => {
    ensureSource(m, "phulls");
    addLayer(m, { id: "phulls", type: "line", source: "phulls", minzoom: 6, paint: { "line-color": "#ff8a4c", "line-width": ["case", ["boolean", ["get", "sel"], false], 2.5, 1], "line-opacity": 0.75 } });
    addDetectionLayers(m, "pdets");
    m.on("click", "pdets-pts", (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const [x, y] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      popup([e.lngLat.lng, e.lngLat.lat], detectionPopup(f.properties as Record<string, unknown>, x, y), m);
    });
    m.on("mouseenter", "pdets-pts", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "pdets-pts", () => (m.getCanvas().style.cursor = ""));
    setMap(m);
  }, []);

  const select = (i: Incident) => {
    setSelected(i.id);
    map?.flyTo({ center: [i.lon, i.lat], zoom: Math.max(map.getZoom(), 9), speed: 1.6 });
  };

  const signedIn = !!me?.authenticated;
  const ctaTo = signedIn ? "/app" : "/register";
  const geo = status ? Object.entries(status.by_source_24h ?? {}).filter(([k]) => SENSOR_GROUPS[2]!.match(k)).reduce((a, [, v]) => a + v, 0) : null;

  const header = (
    <header className="public-head">
      <Link to="/" className="brand">
        <span className="logo">
          <FlameLogo size={20} />
        </span>
        Firealerts
      </Link>
      <span className="badge ok live hide-xs">
        <span className="dot" />
        {t("public.badge")}
      </span>
      <div className="grow" />
      <LanguageSelect compact />
      {signedIn ? (
        <Link className="btn sm primary" to="/app">
          {t("common.openApp")}
        </Link>
      ) : (
        <>
          <Link className="btn sm ghost" to="/login">
            {t("common.signIn")}
          </Link>
          <Link className="btn sm primary hide-xs" to="/register">
            {t("public.ctaShort")}
          </Link>
        </>
      )}
    </header>
  );

  if (disabled)
    return (
      <div className="public-page">
        {header}
        <div style={{ display: "grid", placeItems: "center", flex: 1, padding: 24 }}>
          <EmptyState
            icon={<IconMap size={20} />}
            title={t("public.disabledTitle")}
            action={
              <Link className="btn primary" to={signedIn ? "/app/map" : "/login"}>
                {signedIn ? t("nav.map") : t("common.signIn")}
              </Link>
            }
          >
            {t("public.disabledBody")}
          </EmptyState>
        </div>
      </div>
    );

  return (
    <div className="public-page">
      {header}
      <div className="livemap public-map">
        <aside className="livemap-panel" aria-label={t("live.panel")}>
          <div className="panel-body">
            <div className="public-cta">
              <div className="strong">{t("public.ctaTitle")}</div>
              <div className="small muted mt-4">{t("public.ctaBody")}</div>
              <Link className="btn primary mt-8 block" to={ctaTo}>
                {signedIn ? t("common.openApp") : t("public.cta")} <IconArrowRight />
              </Link>
            </div>
            <div className="public-status small">
              <span className={`status-dot ${status?.latest_detection ? "ok" : "idle"}`} />
              <span className="grow">
                {status?.latest_detection ? t("public.latest", { ago: timeAgo(status.latest_detection) }) : t("public.noData")}
                <span className="tiny muted" style={{ display: "block" }}>
                  {updatedAt ? t("public.updated", { ago: timeAgo(updatedAt) }) : t("common.loading")}
                  {status ? ` · ${t("public.global24", { n: fmtNum(status.detections_24h) })}` : ""}
                </span>
              </span>
              <button className="btn sm ghost icon" onClick={() => void load()} aria-label={t("public.refresh")} title={t("public.refresh")} disabled={loading}>
                {loading ? <Spinner /> : <IconRefresh />}
              </button>
            </div>
            {error && <div className="notice bad small mb-8">{error}</div>}
            <div className="row between wrap mb-8" style={{ gap: 6 }}>
              <Checkbox checked={hideStatic} onChange={setHideStatic} label={t("staticSource.hide")} />
              {hideStatic && staticCount > 0 && <span className="tiny muted">{t("staticSource.hiddenCount", { count: staticCount })}</span>}
            </div>
            <div className="section-title" style={{ marginTop: 4 }}>
              {t("public.incidents", { count: visibleIncidents.length })}
            </div>
            <div className="tiny muted mb-8">{t("public.incidentsHint")}</div>
            <div role="list">
              {visibleIncidents.slice(0, 200).map((i) => (
                <IncidentRow key={i.id} inc={i} selected={i.id === selected} onClick={() => select(i)} />
              ))}
              {!loading && visibleIncidents.length === 0 && <div className="muted small" style={{ padding: 16 }}>{t("public.noIncidents")}</div>}
            </div>
            <p className="tiny faint mt-12">{t("public.disclaimer")}</p>
          </div>
        </aside>
        <div className="livemap-map">
          <MapView hash center={[-60, -15]} zoom={3} onReady={onReady} ariaLabel={t("public.title")} extraLayers={[{ id: "wind", label: t("wind.layer"), description: t("wind.layerDesc"), checked: windOn, onChange: setWindOn }]}>
            <div className="map-toolbar">
              <div className="map-overlay">
                <select className="select sm" value={hours} onChange={(e) => setHours(+e.target.value)} aria-label={t("live.window")}>
                  {[6, 12, 24, 48].map((h) => (
                    <option key={h} value={h}>
                      {t("common.lastHours", { n: h })}
                    </option>
                  ))}
                </select>
                {loading && <Spinner />}
              </div>
            </div>
            {windOn && <WindPanel state={wind} onClose={() => setWindOn(false)} />}
            <div className="map-overlay map-stats">
              <div className="stat">
                <b>{fmtNum(shownDets?.features.length)}</b>
                <span>{t("public.inView", { n: hours })}</span>
              </div>
              <div className="stat">
                <b>{fmtNum(status?.detections_24h)}</b>
                <span>{t("public.global")}</span>
              </div>
              <div className="stat">
                <b>{geo != null ? fmtNum(geo) : "–"}</b>
                <span>{t("sensor.geo")} · 24 h</span>
              </div>
            </div>
            <div className="map-overlay map-legend">
              <b>{t("live.legend.age")}</b>
              {["<1 h", "1–6 h", "6–12 h", ">12 h"].map((l, i) => (
                <span key={l}>
                  <i style={{ background: AGE_COLORS[i] }} />
                  {l}
                </span>
              ))}
              <span>
                <i style={{ background: "transparent", border: "1.5px solid #fff" }} />
                {t("sensor.geo")}
              </span>
            </div>
            <Link className="map-overlay public-map-cta" to={ctaTo}>
              <IconArrowRight /> {signedIn ? t("common.openApp") : t("public.cta")}
            </Link>
          </MapView>
        </div>
      </div>
    </div>
  );
}
