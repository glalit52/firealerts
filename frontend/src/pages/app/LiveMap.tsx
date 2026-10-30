/* Live operations map: detections, incidents, forecasts, danger & ignition grids, wind, fire history, assets. */
import type { Map as MlMap, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { storage } from "../../api/client";
import { assets as assetsApi, fire, system } from "../../api/endpoints";
import type { AssetListItem, DangerGrid, DangerPoint, DetectionCollection, IgnitionGrid, Incident, Status } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { DangerStrip } from "../../components/charts";
import { FireStatsPanel } from "../../components/FireStats";
import { IconClock, IconCrosshair, IconRefresh, IconSearch } from "../../components/Icons";
import { IncidentRow } from "../../components/IncidentRow";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, DangerPill, Input, Notice, Segmented, Spinner, Switch, Tabs, Tile } from "../../components/ui";
import { formatDate, t as tr, tEnum, useT } from "../../i18n";
import { AGE_COLORS, DANGER, PROB_BANDS, SENSOR_GROUPS, probColor } from "../../lib/constants";
import { compass, fmtDayMonth, fmtHa, fmtNum, timeAgo } from "../../lib/format";
import { bboxString, clampBBox, expandBBox } from "../../lib/geo";
import { HIDE_STATIC_KEY, countStatic, filterDetections, filterIncidents } from "../../lib/staticSources";
import { syncMessage } from "../../lib/sync";
import { useDocumentTitle } from "../../lib/useAsync";
import { MapView } from "../../map/MapView";
import { detectionPopup } from "../../map/popups";
import { WindPanel, useWindLayer, useWindToggle, viewBBox } from "../../map/WindLayer";
import { addAssetLayers, addDetectionLayers, addLayer, annotateDetections, assetsToFC, ensureSource, esc, fitGeometry, popup, setData, setVisible } from "../../map/utils";
import { ForecastDrawer, clearForecast } from "./map/ForecastDrawer";
import type { ForecastTarget } from "./map/ForecastDrawer";

type Tab = "history" | "incidents" | "danger" | "assets";
type RiskKind = "fwi" | "ignition";

function setupLayers(map: MlMap) {
  for (const s of ["danger", "fc-burn", "fc-perims", "fc-seed", "hulls", "whatif-pt"]) ensureSource(map, s);
  addLayer(map, { id: "danger-fill", type: "fill", source: "danger", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.4, "fill-antialias": false } });
  addLayer(map, {
    id: "fc-burn-fill", type: "fill", source: "fc-burn", layout: { visibility: "none" },
    paint: { "fill-color": ["interpolate", ["linear"], ["get", "p"], 0, "#ffd166", 0.5, "#ff6a2b", 1, "#b3003c"], "fill-opacity": ["interpolate", ["linear"], ["get", "p"], 0, 0.08, 1, 0.55], "fill-antialias": false },
  });
  addLayer(map, { id: "fc-perims-p90", type: "line", source: "fc-perims", filter: ["==", ["get", "kind"], "p90"], paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.9 } });
  addLayer(map, { id: "fc-perims-fill", type: "fill", source: "fc-perims", filter: ["==", ["get", "kind"], "likely"], paint: { "fill-color": ["get", "color"], "fill-opacity": 0.12 } });
  addLayer(map, { id: "fc-perims-line", type: "line", source: "fc-perims", filter: ["==", ["get", "kind"], "likely"], paint: { "line-color": ["get", "color"], "line-width": 2 }, layout: { "line-cap": "round", "line-join": "round" } });
  addLayer(map, { id: "fc-seed", type: "line", source: "fc-seed", paint: { "line-color": "#ff3b3b", "line-width": 2.5 }, layout: { "line-cap": "round" } });
  addAssetLayers(map, "assets");
  addLayer(map, { id: "hulls", type: "line", source: "hulls", minzoom: 6, paint: { "line-color": "#ff8a4c", "line-width": ["case", ["boolean", ["get", "sel"], false], 2.5, 1], "line-opacity": 0.75 } });
  addLayer(map, { id: "hulls-hit", type: "fill", source: "hulls", minzoom: 6, paint: { "fill-color": "#ff8a4c", "fill-opacity": 0.02 } });
  addDetectionLayers(map, "dets");
  addLayer(map, { id: "whatif-pt", type: "circle", source: "whatif-pt", paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": "#ff3b3b", "circle-stroke-width": 3 } });
}

const MAX_HISTORY_DAYS = 31;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** Validate a history date range (YYYY-MM-DD, inclusive). Returns an error message key or null. */
export function historyRangeError(from: string, to: string, today = isoDay(new Date())): "history.errOrder" | "history.errMax" | "history.errFuture" | "history.errMissing" | null {
  if (!from || !to) return "history.errMissing";
  if (from > to) return "history.errOrder";
  if (to > today) return "history.errFuture";
  if (dayDiff(from, to) + 1 > MAX_HISTORY_DAYS) return "history.errMax";
  return null;
}

export default function LiveMap() {
  const { t } = useT();
  useDocumentTitle(t("nav.map"));
  const { meta, can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [map, setMap] = useState<MlMap | null>(null);
  const [tab, setTab] = useState<Tab>("incidents");
  const [hours, setHours] = useState(24);
  const [groups, setGroups] = useState<string[]>(SENSOR_GROUPS.map((g) => g.id));
  const [status, setStatus] = useState<Status | null>(null);
  const [dets, setDets] = useState<DetectionCollection | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(false);
  const [minCount, setMinCount] = useState(1);
  const [filter, setFilter] = useState("");
  const [hideStatic, setHideStaticState] = useState(() => storage.get(HIDE_STATIC_KEY) !== "0");
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState<ForecastTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [showAssets, setShowAssets] = useState(true);
  const [riskKind, setRiskKind] = useState<RiskKind>("fwi");
  const [grid, setGrid] = useState<(DangerGrid | IgnitionGrid) & { kind: RiskKind } | null>(null);
  const [gridDay, setGridDay] = useState(1);
  const [gridBusy, setGridBusy] = useState(false);
  const [gridVisible, setGridVisible] = useState(true);
  const [point, setPoint] = useState<{ lat: number; lon: number; data?: DangerPoint; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Fire-history mode: a past date range instead of the live window.
  const [history, setHistory] = useState(false);
  const [range, setRange] = useState(() => {
    const to = new Date();
    return { from: isoDay(new Date(to.getTime() - 6 * 864e5)), to: isoDay(to) };
  });
  const [histDets, setHistDets] = useState<DetectionCollection | null>(null);
  const [histQuery, setHistQuery] = useState<{ from: string; to: string; bbox: string } | null>(null);
  const [histBusy, setHistBusy] = useState(false);
  const [windOn, setWindOn] = useWindToggle();
  const wind = useWindLayer(map, windOn, (bbox, n, signal) => fire.wind(bbox, n, signal));
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents;

  const setHideStatic = (v: boolean) => {
    setHideStaticState(v);
    storage.set(HIDE_STATIC_KEY, v ? null : "0");
  };

  const sourceNames = useMemo(() => Object.keys(status?.by_source_24h ?? {}), [status]);
  const allGroups = groups.length === SENSOR_GROUPS.length;
  const sourcesParam = useMemo(() => {
    if (allGroups) return undefined;
    const names = sourceNames.filter((s) => SENSOR_GROUPS.some((g) => groups.includes(g.id) && g.match(s)));
    return names.length ? names.join(",") : "NONE";
  }, [allGroups, groups, sourceNames]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [st, fc, inc] = await Promise.all([system.status(), fire.detections({ hours, sources: sourcesParam }), fire.incidents({ hours, min_count: minCount, limit: 1000 })]);
      setStatus(st);
      setDets(annotateDetections(fc));
      setIncidents(inc.incidents);
    } catch (err) {
      toast.error(err);
    } finally {
      setLoading(false);
    }
  }, [hours, sourcesParam, minCount, toast]);

  useEffect(() => {
    if (history) return; // no live polling while browsing the archive
    void loadData();
    const timer = setInterval(loadData, 120_000);
    return () => clearInterval(timer);
  }, [loadData, history]);

  useEffect(() => {
    assetsApi.list(true).then(setAssets).catch(() => undefined);
  }, []);

  // Filter incidents client-side by sensor group, static heat sources and text.
  const visibleIncidents = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return filterIncidents(incidents, hideStatic).filter((i) => {
      if (!allGroups && !i.sources.some((s) => SENSOR_GROUPS.some((g) => groups.includes(g.id) && g.match(s)))) return false;
      return !q || i.sources.join(" ").toLowerCase().includes(q) || `${i.lat.toFixed(3)}, ${i.lon.toFixed(3)}`.includes(q) || i.id.includes(q) || (i.static_source?.name ?? "").toLowerCase().includes(q);
    });
  }, [incidents, filter, allGroups, groups, hideStatic]);
  const staticCount = useMemo(() => countStatic(incidents), [incidents]);

  const shownDets = useMemo(() => {
    const src = history ? histDets : dets;
    if (!src) return null;
    let fc = filterDetections(src, hideStatic);
    if (history && !allGroups) fc = { ...fc, features: fc.features.filter((f) => SENSOR_GROUPS.some((g) => groups.includes(g.id) && g.match(String(f.properties.source)))) };
    return fc;
  }, [history, histDets, dets, hideStatic, allGroups, groups]);

  // Push data to the map.
  useEffect(() => {
    if (map) setData(map, "dets", shownDets ?? { type: "FeatureCollection", features: [] });
  }, [map, shownDets]);
  useEffect(() => {
    if (!map) return;
    const feats = history ? [] : visibleIncidents.filter((i) => i.hull).map((i) => ({ type: "Feature" as const, geometry: i.hull!, properties: { id: i.id, sel: i.id === selected } }));
    setData(map, "hulls", { type: "FeatureCollection", features: feats });
  }, [map, visibleIncidents, selected, history]);
  useEffect(() => {
    if (!map) return;
    setData(map, "assets", assetsToFC(assets));
    setVisible(map, "assets-fill", showAssets);
    setVisible(map, "assets-line", showAssets);
  }, [map, assets, showAssets]);

  // Deep links: ?incident=ID, ?lat=&lon=
  useEffect(() => {
    if (!map) return;
    const id = params.get("incident");
    if (id && incidents.length) {
      const inc = incidents.find((i) => i.id === id);
      if (inc) selectIncident(inc);
      else toast.show(t("live.incidentGone"), "warning");
      params.delete("incident");
      setParams(params, { replace: true });
    }
    const lat = Number(params.get("lat")), lon = Number(params.get("lon"));
    if (params.get("lat") && Number.isFinite(lat) && Number.isFinite(lon)) {
      map.flyTo({ center: [lon, lat], zoom: Number(params.get("zoom")) || 10 });
      setData(map, "whatif-pt", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] } }] });
      params.delete("lat");
      params.delete("lon");
      params.delete("zoom");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, incidents]);

  function selectIncident(inc: Incident) {
    setSelected(inc.id);
    setTarget({ kind: "incident", inc });
    map?.flyTo({ center: [inc.lon, inc.lat], zoom: Math.max(map.getZoom(), 10), speed: 1.6 });
  }

  const onReady = useCallback(
    (m: MlMap) => {
      setupLayers(m);
      m.on("click", "dets-pts", (e: MapLayerMouseEvent) => {
        if (pickingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const [x, y] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        popup([e.lngLat.lng, e.lngLat.lat], detectionPopup(f.properties as Record<string, unknown>, x, y), m);
        e.preventDefault();
      });
      m.on("click", "hulls-hit", (e: MapLayerMouseEvent) => {
        if (pickingRef.current || e.defaultPrevented) return;
        const id = e.features?.[0]?.properties?.id;
        const inc = incidentsRef.current.find((i) => i.id === id);
        if (inc) {
          setSelected(inc.id);
          setTarget({ kind: "incident", inc });
        }
        e.preventDefault();
      });
      m.on("click", "assets-fill", (e: MapLayerMouseEvent) => {
        if (pickingRef.current || e.defaultPrevented || tabRef.current === "danger") return;
        const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
        if (!p) return;
        const alerts = Number(p.open_alerts) ? ` · <span style="color:#ff9a3c">${esc(tr("live.openAlerts", { count: Number(p.open_alerts) }))}</span>` : "";
        popup([e.lngLat.lng, e.lngLat.lat], `<b>${esc(p.name)}</b><br>${esc(tEnum("kind", String(p.kind)))}${alerts}<br><a href="/app/assets/${esc(p.id)}">${esc(tr("live.openAsset"))}</a>`, m);
        e.preventDefault();
      });
      for (const l of ["dets-pts", "hulls-hit", "assets-fill"]) {
        m.on("mouseenter", l, () => !pickingRef.current && (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", l, () => (m.getCanvas().style.cursor = ""));
      }
      m.on("click", (e: MapMouseEvent) => {
        if (e.defaultPrevented) return;
        const { lat, lng } = e.lngLat;
        if (pickingRef.current) {
          setPicking(false);
          setSelected(null);
          setData(m, "whatif-pt", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } }] });
          setTarget({ kind: "whatif", lat, lon: lng });
          return;
        }
        if (tabRef.current === "danger") void pointDanger(lat, lng);
      });
      setMap(m);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!map) return;
    map.getCanvasContainer().classList.toggle("picking", picking);
    if (picking) toast.show(t("live.pickHint"), "info");
    const k = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, map]);

  async function pointDanger(lat: number, lon: number) {
    setPoint({ lat, lon });
    try {
      const d = await fire.danger(lat, lon);
      setPoint({ lat, lon, data: d });
    } catch (err) {
      setPoint({ lat, lon, error: (err as Error).message });
    }
  }

  async function loadGrid(kind: RiskKind = riskKind) {
    if (!map) return;
    const box = clampBBox(expandBBox(viewBBox(map)));
    setGridBusy(true);
    try {
      const g = kind === "fwi" ? await fire.dangerGrid(bboxString(box, 3), 10) : await fire.ignition(bboxString(box, 3), 10);
      setGrid({ ...g, kind } as (DangerGrid | IgnitionGrid) & { kind: RiskKind });
      setGridDay(Math.min(1, g.dates.length - 1));
      setGridVisible(true);
    } catch (err) {
      toast.error(err);
    } finally {
      setGridBusy(false);
    }
  }

  useEffect(() => {
    if (!map) return;
    if (!grid) {
      setData(map, "danger", { type: "FeatureCollection", features: [] });
      return;
    }
    const feats = grid.features.map((f) => {
      const p = f.properties as unknown as { p?: number[]; fwi: number[]; danger?: string[] };
      return {
        ...f,
        properties:
          grid.kind === "ignition"
            ? { color: probColor(p.p![gridDay] ?? 0), p: p.p![gridDay] }
            : { color: DANGER[(p.danger![gridDay] ?? "low") as keyof typeof DANGER]?.color ?? "#888", fwi: p.fwi[gridDay] },
      };
    });
    setData(map, "danger", { type: "FeatureCollection", features: feats });
  }, [map, grid, gridDay]);
  useEffect(() => setVisible(map, "danger-fill", gridVisible), [map, gridVisible]);

  const closeDrawer = () => {
    setTarget(null);
    setSelected(null);
    clearForecast(map);
    setData(map, "whatif-pt", { type: "FeatureCollection", features: [] });
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await system.ingest();
      toast.success(syncMessage(r));
      await loadData();
      window.dispatchEvent(new Event("fa:alerts-changed"));
    } catch (err) {
      toast.error(err);
    } finally {
      setSyncing(false);
    }
  };

  // ---------------------------------------------------------------- history mode
  const rangeError = historyRangeError(range.from, range.to);
  const loadHistory = async () => {
    if (!map || rangeError) return;
    const box = bboxString(clampBBox(viewBBox(map)), 3);
    setHistBusy(true);
    try {
      const fc = await fire.detections({ from: `${range.from}T00:00:00Z`, to: `${range.to}T23:59:59Z`, bbox: box });
      setHistDets(annotateDetections(fc, Date.parse(`${range.to}T23:59:59Z`)));
      setHistQuery({ ...range, bbox: box });
    } catch (err) {
      toast.error(err);
    } finally {
      setHistBusy(false);
    }
  };
  const toggleHistory = (on: boolean) => {
    setHistory(on);
    setTab(on ? "history" : "incidents");
    if (on) {
      closeDrawer();
      setPicking(false);
    } else {
      setHistDets(null);
      setHistQuery(null);
    }
  };
  useEffect(() => {
    if (history && map && !histQuery && !histBusy) void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, map]);
  const statsDays = histQuery ? Math.min(366, Math.max(1, dayDiff(histQuery.from, isoDay(new Date())) + 1)) : 30;

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of SENSOR_GROUPS) out[g.id] = Object.entries(status?.by_source_24h ?? {}).filter(([k]) => g.match(k)).reduce((a, [, v]) => a + v, 0);
    return out;
  }, [status]);

  const fuels = meta?.fuels ?? [];
  const today = point?.data ? (point.data.days.find((d) => d.forecast) ?? point.data.days[point.data.days.length - 1]) : null;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...(history ? [{ id: "history" as Tab, label: t("history.tab") }] : [{ id: "incidents" as Tab, label: t("live.tab.incidents"), count: visibleIncidents.length }]),
    { id: "danger", label: t("live.tab.danger") },
    { id: "assets", label: t("live.tab.assets"), count: assets.length },
  ];

  return (
    <div className="livemap">
      <aside className="livemap-panel" aria-label={t("live.panel")}>
        <Tabs value={tab} onChange={setTab} label={t("live.panel")} tabs={tabs} />
        <div className="panel-body">
          {tab === "history" && (
            <div className="stack">
              <p className="small muted">{t("history.lead", { n: MAX_HISTORY_DAYS })}</p>
              <div className="form-grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
                <Input inputSize="sm" label={t("history.from")} type="date" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
                <Input inputSize="sm" label={t("history.to")} type="date" value={range.to} min={range.from} max={isoDay(new Date())} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {[1, 7, 14, 31].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip-toggle"
                    aria-pressed={dayDiff(range.from, range.to) + 1 === n && range.to === isoDay(new Date())}
                    onClick={() => setRange({ from: isoDay(new Date(Date.now() - (n - 1) * 864e5)), to: isoDay(new Date()) })}
                  >
                    {n === 1 ? t("history.today") : t("history.lastN", { n })}
                  </button>
                ))}
              </div>
              {rangeError && <div className="form-error">{t(rangeError, { n: MAX_HISTORY_DAYS })}</div>}
              <Button variant="primary" loading={histBusy} disabled={!!rangeError} onClick={loadHistory}>
                {t("history.load")}
              </Button>
              {histQuery && (
                <div className="tiny muted">
                  {t("history.loaded", { count: shownDets?.features.length ?? 0, from: fmtDayMonth(histQuery.from), to: fmtDayMonth(histQuery.to) })}
                </div>
              )}
              <Checkbox checked={hideStatic} onChange={setHideStatic} label={t("staticSource.hide")} />
              {histQuery && (
                <div>
                  <div className="section-title">{t("history.statsTitle")}</div>
                  <FireStatsPanel bbox={histQuery.bbox} days={statsDays} from={histQuery.from} to={histQuery.to} compact />
                  <div className="tiny muted mt-8">{t("history.statsNote")}</div>
                </div>
              )}
            </div>
          )}

          {tab === "incidents" && (
            <>
              <div className="row mb-8">
                <div className="search-box grow">
                  <IconSearch size={14} />
                  <Input inputSize="sm" type="search" placeholder={t("live.filterPh")} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("live.filterAria")} />
                </div>
                <label className="row small muted nowrap" style={{ gap: 6 }}>
                  {t("live.minPx")}
                  <input className="input sm" style={{ width: 56 }} type="number" min={1} value={minCount} onChange={(e) => setMinCount(Math.max(1, +e.target.value || 1))} aria-label={t("live.minPxAria")} />
                </label>
              </div>
              <div className="row between wrap mb-8" style={{ gap: 6 }}>
                <Checkbox checked={hideStatic} onChange={setHideStatic} label={t("staticSource.hide")} />
                {hideStatic && staticCount > 0 && <span className="tiny muted">{t("staticSource.hiddenCount", { count: staticCount })}</span>}
              </div>
              <div className="tiny muted mb-8">
                {t("live.summary", { count: visibleIncidents.length, active: visibleIncidents.filter((i) => i.status === "active").length })} {loading && <Spinner />}
              </div>
              <div role="list">
                {visibleIncidents.slice(0, 300).map((i) => (
                  <IncidentRow key={i.id} inc={i} selected={i.id === selected} onClick={() => selectIncident(i)} />
                ))}
                {!loading && visibleIncidents.length === 0 && <div className="muted small" style={{ padding: 16 }}>{t("live.noIncidents")}</div>}
              </div>
            </>
          )}

          {tab === "danger" && (
            <div className="stack">
              <Segmented
                value={riskKind}
                onChange={(v) => {
                  setRiskKind(v);
                  if (grid) void loadGrid(v);
                }}
                options={[
                  { value: "fwi", label: t("live.risk.fwi") },
                  { value: "ignition", label: t("live.risk.ignition") },
                ]}
                label={t("live.risk.layer")}
              />
              <p className="small muted">{riskKind === "fwi" ? t("live.risk.fwiHelp") : t("live.risk.ignitionHelp")}</p>
              <Button variant="primary" loading={gridBusy} onClick={() => loadGrid()}>
                {grid ? t("live.risk.refresh") : t("live.risk.show")}
              </Button>
              {grid && (
                <div className="card inset" style={{ padding: 12 }}>
                  <label className="field">
                    <span className="field-label">
                      {formatDate(new Date(`${grid.dates[gridDay]}T12:00:00`), { weekday: "long", day: "numeric", month: "short" })}
                      {gridDay === 0 ? ` (${t("live.risk.observed")})` : ""}
                    </span>
                    <input type="range" min={0} max={grid.dates.length - 1} value={gridDay} onChange={(e) => setGridDay(+e.target.value)} aria-label={t("live.risk.day")} />
                  </label>
                  <div className="legend mt-8">
                    {grid.kind === "fwi"
                      ? Object.values(DANGER).map((d) => (
                          <span key={d.color}>
                            <i style={{ background: d.color }} />
                            {d.label}
                          </span>
                        ))
                      : PROB_BANDS.map(([, c, l]) => (
                          <span key={l}>
                            <i style={{ background: c }} />
                            {l}
                          </span>
                        ))}
                  </div>
                  {grid.kind === "ignition" && "model" in grid && (
                    <div className="note mt-8">
                      {grid.model.kind === "trained"
                        ? t("live.risk.trained", { region: grid.model.region ?? "", auc: grid.model.test?.roc_auc ?? "–", base: grid.model.test_baseline?.roc_auc ?? "–", brier: grid.model.test?.brier ?? "–" })
                        : t("live.risk.baseline", { desc: grid.model.description ?? "" })}
                    </div>
                  )}
                  <div className="mt-8">
                    <Switch checked={gridVisible} onChange={setGridVisible} label={t("live.risk.showLayer")} />
                  </div>
                </div>
              )}
              {point && (
                <div>
                  <div className="section-title">
                    {t("live.point.title")} · <span className="mono">{point.lat.toFixed(3)}, {point.lon.toFixed(3)}</span>
                  </div>
                  {!point.data && !point.error && (
                    <div className="row small muted">
                      <Spinner /> {t("live.point.computing")}
                    </div>
                  )}
                  {point.error && <Notice kind="bad">{point.error}</Notice>}
                  {point.data && today && (
                    <>
                      <div className="tiles" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8 }}>
                        <Tile compact label={`FWI · ${DANGER[today.danger]?.label}`} value={<span style={{ color: DANGER[today.danger]?.color }}>{fmtNum(today.fwi)}</span>} />
                        <Tile compact label="DMC" value={fmtNum(point.data.state.dmc)} />
                        <Tile compact label="DC" value={fmtNum(point.data.state.dc)} />
                        <Tile compact label={t("live.point.temp")} value={`${fmtNum(point.data.current.temp, 1)}°`} />
                        <Tile compact label={t("live.point.rh")} value={`${fmtNum(point.data.current.rh)}%`} />
                        <Tile compact label={t("live.point.wind")} value={`${fmtNum(point.data.current.wind)} ${compass(point.data.current.wind_dir)}`} />
                      </div>
                      <div className="mt-8">
                        <DangerStrip days={point.data.days} />
                      </div>
                      <Button
                        className="mt-8"
                        size="sm"
                        icon={<IconCrosshair />}
                        onClick={() => {
                          setData(map, "whatif-pt", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [point.lon, point.lat] } }] });
                          setTarget({ kind: "whatif", lat: point.lat, lon: point.lon });
                        }}
                      >
                        {t("live.point.simulate")}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {!point && <p className="tiny muted">{t("live.point.tip")}</p>}
            </div>
          )}

          {tab === "assets" && (
            <div className="stack tight">
              <Switch checked={showAssets} onChange={setShowAssets} label={t("live.assets.show")} />
              {assets.length === 0 && <p className="small muted mt-8">{t("live.assets.none")}</p>}
              {assets.map((a) => (
                <button
                  key={a.id}
                  className="inc"
                  style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
                  onClick={() => {
                    if (map && a.geometry) fitGeometry(map, [a.geometry], { padding: 80, duration: 800 });
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span className="inc-title truncate" style={{ display: "block" }}>
                      {a.name}
                    </span>
                    <span className="inc-meta">
                      {tEnum("kind", a.kind)} · {fmtHa(a.area_ha)}
                      {a.open_alerts ? ` · ${t("live.openAlerts", { count: a.open_alerts })}` : ""}
                    </span>
                  </span>
                  {a.risk_today ? <DangerPill danger={a.risk_today.danger} /> : <span className="tiny muted">–</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div className="livemap-map">
        <MapView hash onReady={onReady} ariaLabel={t("live.mapAria")} extraLayers={[{ id: "wind", label: t("wind.layer"), description: t("wind.layerDesc"), checked: windOn, onChange: setWindOn }]}>
          <div className="map-toolbar">
            <div className="map-overlay">
              {history ? (
                <span className="small strong nowrap" style={{ padding: "0 6px" }}>
                  {fmtDayMonth(range.from)} – {fmtDayMonth(range.to)}
                </span>
              ) : (
                <select className="select sm" value={hours} onChange={(e) => setHours(+e.target.value)} aria-label={t("live.window")}>
                  {[6, 12, 24, 48, 72, 168].map((h) => (
                    <option key={h} value={h}>
                      {h < 48 ? t("common.lastHours", { n: h }) : t("common.lastDays", { n: h / 24 })}
                    </option>
                  ))}
                </select>
              )}
              {SENSOR_GROUPS.map((g) => (
                <button
                  key={g.id}
                  className="chip-toggle"
                  aria-pressed={groups.includes(g.id)}
                  onClick={() => setGroups((xs) => (xs.includes(g.id) ? (xs.length > 1 ? xs.filter((x) => x !== g.id) : xs) : [...xs, g.id]))}
                  title={t("live.groupTitle", { n: fmtNum(counts[g.id]) })}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <div className="map-overlay">
              <Button size="sm" active={history} aria-pressed={history} icon={<IconClock />} onClick={() => toggleHistory(!history)} title={t("history.toggleTitle")}>
                {t("history.toggle")}
              </Button>
              {!history && (
                <Button size="sm" active={picking} icon={<IconCrosshair />} onClick={() => setPicking((v) => !v)} title={t("live.whatifTitle")}>
                  {t("live.whatif")}
                </Button>
              )}
              {can("admin") && !history && (
                <Button size="sm" iconOnly loading={syncing} onClick={sync} title={t("sync.title")} aria-label={t("sync.now")}>
                  {!syncing && <IconRefresh />}
                </Button>
              )}
            </div>
          </div>
          {windOn && <WindPanel state={wind} onClose={() => setWindOn(false)} />}
          <div className="map-overlay map-stats">
            <div className="stat">
              <b>{fmtNum(shownDets?.features.length)}</b>
              <span>{history ? t("history.detections") : t("live.stat.detections", { n: hours })}</span>
            </div>
            {!history &&
              SENSOR_GROUPS.map((g) => (
                <div key={g.id} className="stat">
                  <b>{fmtNum(counts[g.id])}</b>
                  <span>{g.label} · 24 h</span>
                </div>
              ))}
            <div className="stat">
              <b>{status?.latest_detection ? timeAgo(status.latest_detection) : "–"}</b>
              <span>{t("landing.stat.latest")}</span>
            </div>
          </div>
          <div className="map-overlay map-legend">
            <b>{history ? t("history.ageLegend") : t("live.legend.age")}</b>
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
            {showAssets && assets.length > 0 && (
              <span>
                <i style={{ background: "transparent", border: "1.5px dashed #5aa9ff", borderRadius: 2 }} />
                {t("live.legend.assets")}
              </span>
            )}
          </div>
          {map && target && <ForecastDrawer key={target.kind === "incident" ? target.inc.id : `${target.lat},${target.lon}`} map={map} target={target} fuels={fuels} onClose={closeDrawer} />}
          {status && status.runs.length === 0 && !history && (
            <div className="map-overlay" style={{ position: "absolute", top: 64, left: 12, padding: 12, maxWidth: 320, zIndex: 3 }}>
              <div className="strong small">{t("live.noData")}</div>
              <div className="tiny muted mt-4">{t("live.noDataBody")}</div>
              {can("admin") && (
                <Button className="mt-8" size="sm" variant="primary" loading={syncing} onClick={sync}>
                  {t("sync.first")}
                </Button>
              )}
            </div>
          )}
        </MapView>
      </div>
    </div>
  );
}
