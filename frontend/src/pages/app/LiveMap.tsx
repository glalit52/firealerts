/* Live operations map: detections, incidents, forecasts, danger & ignition grids, assets. */
import type { Map as MlMap, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { assets as assetsApi, fire, system } from "../../api/endpoints";
import type { AssetListItem, DangerGrid, DangerPoint, DetectionCollection, IgnitionGrid, Incident, Status } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { DangerStrip } from "../../components/charts";
import { IconCrosshair, IconRefresh, IconSearch } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Button, DangerPill, Input, Notice, Segmented, Spinner, Switch, Tabs, Tile } from "../../components/ui";
import { AGE_COLORS, CONFIDENCE_LABELS, DANGER, PROB_BANDS, SENSOR_GROUPS, isGeoSource, prioColor, probColor } from "../../lib/constants";
import { compass, fmtHa, fmtNum, humanize, timeAgo } from "../../lib/format";
import { bboxString, clampBBox, expandBBox } from "../../lib/geo";
import type { BBox } from "../../lib/geo";
import { useDocumentTitle } from "../../lib/useAsync";
import { MapView } from "../../map/MapView";
import { addAssetLayers, addDetectionLayers, addLayer, annotateDetections, assetsToFC, ensureSource, esc, fitGeometry, popup, setData, setVisible } from "../../map/utils";
import { ForecastDrawer, clearForecast } from "./map/ForecastDrawer";
import type { ForecastTarget } from "./map/ForecastDrawer";

type Tab = "incidents" | "danger" | "assets";
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

function viewBBox(map: MlMap): BBox {
  const b = map.getBounds();
  return [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
}

export default function LiveMap() {
  useDocumentTitle("Live map");
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
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents;

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
    void loadData();
    const t = setInterval(loadData, 120_000);
    return () => clearInterval(t);
  }, [loadData]);

  useEffect(() => {
    assetsApi.list(true).then(setAssets).catch(() => undefined);
  }, []);

  // Filter incidents client-side by sensor group and text.
  const visibleIncidents = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return incidents.filter((i) => {
      if (!allGroups && !i.sources.some((s) => SENSOR_GROUPS.some((g) => groups.includes(g.id) && g.match(s)))) return false;
      return !q || i.sources.join(" ").toLowerCase().includes(q) || `${i.lat.toFixed(3)}, ${i.lon.toFixed(3)}`.includes(q) || i.id.includes(q);
    });
  }, [incidents, filter, allGroups, groups]);

  // Push data to the map.
  useEffect(() => {
    if (map && dets) setData(map, "dets", dets);
  }, [map, dets]);
  useEffect(() => {
    if (!map) return;
    setData(map, "hulls", { type: "FeatureCollection", features: visibleIncidents.filter((i) => i.hull).map((i) => ({ type: "Feature", geometry: i.hull!, properties: { id: i.id, sel: i.id === selected } })) });
  }, [map, visibleIncidents, selected]);
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
      else toast.show("That incident is no longer active (it may have merged with another).", "warning");
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
        const p = f.properties as Record<string, string | number>;
        const [x, y] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        popup(
          [e.lngLat.lng, e.lngLat.lat],
          `<b>${esc(p.source)}</b> ${esc(p.satellite)}<br>${esc(new Date(String(p.acq_time)).toLocaleString())}<br>FRP <b>${esc(fmtNum(Number(p.frp), 1))}</b> MW · conf. ${esc(CONFIDENCE_LABELS[String(p.confidence)] ?? p.confidence)}<br><span style="font-family:var(--mono)">${y.toFixed(4)}, ${x.toFixed(4)}</span>`,
          m,
        );
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
        popup([e.lngLat.lng, e.lngLat.lat], `<b>${esc(p.name)}</b><br>${esc(humanize(String(p.kind)))}${Number(p.open_alerts) ? ` · <span style="color:#ff9a3c">${esc(p.open_alerts)} open alerts</span>` : ""}<br><a href="/app/assets/${esc(p.id)}">Open asset →</a>`, m);
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
    if (picking) toast.show("Click the map where a fire could start.", "info");
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
      toast.success(`Sync complete: ${fmtNum(r.inserted)} new detections${r.alerts ? `, ${r.alerts} alerts` : ""}.`);
      await loadData();
      window.dispatchEvent(new Event("fa:alerts-changed"));
    } catch (err) {
      toast.error(err);
    } finally {
      setSyncing(false);
    }
  };

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of SENSOR_GROUPS) out[g.id] = Object.entries(status?.by_source_24h ?? {}).filter(([k]) => g.match(k)).reduce((a, [, v]) => a + v, 0);
    return out;
  }, [status]);

  const fuels = meta?.fuels ?? [];
  const today = point?.data ? (point.data.days.find((d) => d.forecast) ?? point.data.days[point.data.days.length - 1]) : null;

  return (
    <div className="livemap">
      <aside className="livemap-panel" aria-label="Map panel">
        <Tabs
          value={tab}
          onChange={setTab}
          label="Map panel"
          tabs={[
            { id: "incidents", label: "Incidents", count: visibleIncidents.length },
            { id: "danger", label: "Danger & risk" },
            { id: "assets", label: "Assets", count: assets.length },
          ]}
        />
        <div className="panel-body">
          {tab === "incidents" && (
            <>
              <div className="row mb-8">
                <div className="search-box grow">
                  <IconSearch size={14} />
                  <Input inputSize="sm" type="search" placeholder="Sensor, coordinates or id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter incidents" />
                </div>
                <label className="row small muted nowrap" style={{ gap: 6 }}>
                  Min px
                  <input className="input sm" style={{ width: 56 }} type="number" min={1} value={minCount} onChange={(e) => setMinCount(Math.max(1, +e.target.value || 1))} aria-label="Minimum fire pixels" />
                </label>
              </div>
              <div className="tiny muted mb-8">
                {visibleIncidents.length} incident{visibleIncidents.length === 1 ? "" : "s"} · {visibleIncidents.filter((i) => i.status === "active").length} active · sorted by priority {loading && <Spinner />}
              </div>
              <div role="list">
                {visibleIncidents.slice(0, 300).map((i) => {
                  const [c, bg] = prioColor(i.priority);
                  return (
                    <button key={i.id} role="listitem" className={`inc ${i.id === selected ? "sel" : ""}`} onClick={() => selectIncident(i)}>
                      <span className="prio" style={{ color: c, background: bg }}>
                        {i.priority}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="inc-title" style={{ display: "block" }}>
                          {i.lat.toFixed(3)}, {i.lon.toFixed(3)}
                        </span>
                        <span className="inc-meta" style={{ display: "block" }}>
                          {i.count} px · {fmtHa(i.area_ha)} · {i.status === "active" ? `seen ${timeAgo(i.last_seen)}` : "cooling"}
                        </span>
                        <span className="row wrap" style={{ gap: 3, marginTop: 3 }}>
                          {i.sources.slice(0, 3).map((s) => (
                            <span key={s} className={`chip ${isGeoSource(s) ? "geo" : ""}`}>
                              {s.replace("VIIRS_", "")}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="inc-right">
                        <b>{fmtNum(i.frp_sum)}</b>MW FRP
                      </span>
                    </button>
                  );
                })}
                {!loading && visibleIncidents.length === 0 && <div className="muted small" style={{ padding: 16 }}>No incidents in this window.</div>}
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
                  { value: "fwi", label: "Fire danger (FWI)" },
                  { value: "ignition", label: "Ignition probability" },
                ]}
                label="Risk layer"
              />
              <p className="small muted">
                {riskKind === "fwi"
                  ? "Canadian Fire Weather Index from 45 days of observed weather plus a 7-day forecast. Click anywhere on the map for a point outlook."
                  : "Probability of at least one satellite fire detection per cell per day, from a gradient-boosted model on fire weather, land cover, terrain, season and recent fire activity."}
              </p>
              <Button variant="primary" loading={gridBusy} onClick={() => loadGrid()}>
                {grid ? "Refresh for current view" : "Show for current view"}
              </Button>
              {grid && (
                <div className="card inset" style={{ padding: 12 }}>
                  <label className="field">
                    <span className="field-label">
                      {new Date(`${grid.dates[gridDay]}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
                      {gridDay === 0 ? " (observed)" : ""}
                    </span>
                    <input type="range" min={0} max={grid.dates.length - 1} value={gridDay} onChange={(e) => setGridDay(+e.target.value)} aria-label="Forecast day" />
                  </label>
                  <div className="legend mt-8">
                    {grid.kind === "fwi"
                      ? Object.values(DANGER).map((d) => (
                          <span key={d.label}>
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
                        ? `Trained model · ${grid.model.region ?? ""} · test ROC AUC ${grid.model.test?.roc_auc ?? "–"} (FWI baseline ${grid.model.test_baseline?.roc_auc ?? "–"}) · Brier ${grid.model.test?.brier ?? "–"}`
                        : `Heuristic baseline (no trained model yet). ${grid.model.description ?? ""}`}
                    </div>
                  )}
                  <div className="mt-8">
                    <Switch checked={gridVisible} onChange={setGridVisible} label="Show layer" />
                  </div>
                </div>
              )}
              {point && (
                <div>
                  <div className="section-title">
                    Point outlook · <span className="mono">{point.lat.toFixed(3)}, {point.lon.toFixed(3)}</span>
                  </div>
                  {!point.data && !point.error && (
                    <div className="row small muted">
                      <Spinner /> Computing fire weather…
                    </div>
                  )}
                  {point.error && <Notice kind="bad">{point.error}</Notice>}
                  {point.data && today && (
                    <>
                      <div className="tiles" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8 }}>
                        <Tile compact label={`FWI · ${DANGER[today.danger]?.label}`} value={<span style={{ color: DANGER[today.danger]?.color }}>{fmtNum(today.fwi)}</span>} />
                        <Tile compact label="DMC" value={fmtNum(point.data.state.dmc)} />
                        <Tile compact label="DC" value={fmtNum(point.data.state.dc)} />
                        <Tile compact label="Temp now" value={`${fmtNum(point.data.current.temp, 1)}°`} />
                        <Tile compact label="RH now" value={`${fmtNum(point.data.current.rh)}%`} />
                        <Tile compact label="Wind km/h" value={`${fmtNum(point.data.current.wind)} ${compass(point.data.current.wind_dir)}`} />
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
                        Simulate ignition here
                      </Button>
                    </>
                  )}
                </div>
              )}
              {!point && <p className="tiny muted">Tip: click the map for a point fire-weather outlook.</p>}
            </div>
          )}

          {tab === "assets" && (
            <div className="stack tight">
              <Switch checked={showAssets} onChange={setShowAssets} label="Show assets on map" />
              {assets.length === 0 && <p className="small muted mt-8">No assets yet. Add forests in “Forests & assets”.</p>}
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
                      {humanize(a.kind)} · {fmtHa(a.area_ha)}
                      {a.open_alerts ? ` · ${a.open_alerts} open alerts` : ""}
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
        <MapView hash onReady={onReady} ariaLabel="Live fire map">
          <div className="map-toolbar">
            <div className="map-overlay">
              <select className="select sm" value={hours} onChange={(e) => setHours(+e.target.value)} aria-label="Time window">
                {[6, 12, 24, 48, 72, 168].map((h) => (
                  <option key={h} value={h}>
                    Last {h < 48 ? `${h} h` : `${h / 24} days`}
                  </option>
                ))}
              </select>
              {SENSOR_GROUPS.map((g) => (
                <button
                  key={g.id}
                  className="chip-toggle"
                  aria-pressed={groups.includes(g.id)}
                  onClick={() => setGroups((xs) => (xs.includes(g.id) ? (xs.length > 1 ? xs.filter((x) => x !== g.id) : xs) : [...xs, g.id]))}
                  title={`${fmtNum(counts[g.id])} detections in 24 h`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <div className="map-overlay">
              <Button size="sm" active={picking} icon={<IconCrosshair />} onClick={() => setPicking((v) => !v)} title="Click the map to simulate an ignition">
                What-if ignition
              </Button>
              {can("admin") && (
                <Button size="sm" iconOnly loading={syncing} onClick={sync} title="Fetch new satellite data now" aria-label="Sync satellites now">
                  {!syncing && <IconRefresh />}
                </Button>
              )}
            </div>
          </div>
          <div className="map-overlay map-stats">
            <div className="stat">
              <b>{fmtNum(dets?.features.length)}</b>
              <span>Detections · {hours} h</span>
            </div>
            {SENSOR_GROUPS.map((g) => (
              <div key={g.id} className="stat">
                <b>{fmtNum(counts[g.id])}</b>
                <span>{g.label} · 24 h</span>
              </div>
            ))}
            <div className="stat">
              <b>{status?.latest_detection ? timeAgo(status.latest_detection) : "–"}</b>
              <span>Latest pixel</span>
            </div>
          </div>
          <div className="map-overlay map-legend">
            <b>Detection age</b>
            {["<1 h", "1–6 h", "6–12 h", ">12 h"].map((l, i) => (
              <span key={l}>
                <i style={{ background: AGE_COLORS[i] }} />
                {l}
              </span>
            ))}
            <span>
              <i style={{ background: "transparent", border: "1.5px solid #fff" }} />
              Geostationary
            </span>
            {showAssets && assets.length > 0 && (
              <span>
                <i style={{ background: "transparent", border: "1.5px dashed #5aa9ff", borderRadius: 2 }} />
                Your assets
              </span>
            )}
          </div>
          {map && target && <ForecastDrawer key={target.kind === "incident" ? target.inc.id : `${target.lat},${target.lon}`} map={map} target={target} fuels={fuels} onClose={closeDrawer} />}
          {status && status.runs.length === 0 && (
            <div className="map-overlay" style={{ position: "absolute", top: 64, left: 12, padding: 12, maxWidth: 320, zIndex: 3 }}>
              <div className="strong small">No satellite data yet</div>
              <div className="tiny muted mt-4">The platform hasn't ingested any detections.</div>
              {can("admin") && (
                <Button className="mt-8" size="sm" variant="primary" loading={syncing} onClick={sync}>
                  Run first sync
                </Button>
              )}
            </div>
          )}
        </MapView>
      </div>
    </div>
  );
}
