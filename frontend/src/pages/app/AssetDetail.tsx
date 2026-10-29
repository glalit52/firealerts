import type { Map as MlMap, MapLayerMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { assets as assetsApi } from "../../api/endpoints";
import type { Asset, AssetSummary } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { AssetFields, valuesFromAsset, valuesToPayload } from "../../components/AssetFields";
import type { AssetFormValues } from "../../components/AssetFields";
import { IconChevronRight, IconDownload, IconEdit, IconFile, IconTrash, IconX } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, ErrorState, Loading, Notice, SeverityChip, Switch, Tabs, Tile, useConfirm } from "../../components/ui";
import { CONFIDENCE_LABELS, dangerInfo, prioColor } from "../../lib/constants";
import { compass, fmtHa, fmtKm, fmtNum, humanize, timeAgo } from "../../lib/format";
import { circlePolygon } from "../../lib/geo";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { MapView } from "../../map/MapView";
import { addDetectionLayers, addLayer, annotateDetections, ensureSource, esc, fitGeometry, popup, removeImage, setData, setImage } from "../../map/utils";
import { BurnSeverityPanel, ExposurePanel, ForestLossPanel, HistoryPanel, ImageryPanel, RampLegend, RiskPanel, VegetationPanel } from "./asset/panels";
import type { Overlay } from "./asset/panels";

type Tab = "risk" | "vegetation" | "imagery" | "burn" | "history" | "loss" | "exposure" | "settings";

function SettingsPanel({ asset, onSaved }: { asset: Asset; onSaved: (a: Asset) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [values, setValues] = useState<AssetFormValues>(() => valuesFromAsset(asset));
  const [busy, setBusy] = useState(false);
  const editable = can("member");
  const save = async () => {
    if (!values.name.trim()) return toast.show("Name can't be empty.", "warning");
    setBusy(true);
    try {
      const a = await assetsApi.update(asset.id, valuesToPayload(values));
      onSaved(a);
      toast.success("Asset settings saved.");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const toggleActive = async (v: boolean) => {
    try {
      onSaved(await assetsApi.update(asset.id, { active: v }));
      toast.success(v ? "Monitoring resumed." : "Monitoring paused: no alerts will be sent for this asset.");
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async () => {
    const ok = await confirm({ title: `Delete ${asset.name}?`, body: "This removes the asset, its vegetation and risk history. Alerts are kept but unlinked. This can't be undone.", confirmLabel: "Delete asset", danger: true });
    if (!ok) return;
    try {
      await assetsApi.remove(asset.id);
      toast.success(`${asset.name} deleted.`);
      navigate("/app/assets");
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="stack loose">
      {!editable && <Notice kind="info">You have view-only access to this organisation.</Notice>}
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <AssetFields value={values} onChange={setValues} />
      </fieldset>
      {editable && (
        <div className="row between wrap">
          <Switch checked={asset.active} onChange={toggleActive} label={asset.active ? "Monitoring active" : "Monitoring paused"} />
          <div className="row">
            <Button variant="danger" icon={<IconTrash />} onClick={remove}>
              Delete asset
            </Button>
            <Button variant="primary" loading={busy} onClick={save}>
              Save changes
            </Button>
          </div>
        </div>
      )}
      {Object.keys(asset.properties ?? {}).length > 0 && (
        <div>
          <div className="section-title">Imported attributes</div>
          <dl className="kv">
            {Object.entries(asset.properties).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{String(v ?? "–")}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {dialog}
    </div>
  );
}

export default function AssetDetail() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const toast = useToast();
  const asset = useAsync(() => assetsApi.get(id), [id]);
  const summary = useAsync(() => assetsApi.summary(id), [id]);
  const [days, setDays] = useState(7);
  const dets = useAsync(() => assetsApi.detections(id, days, 25), [id, days]);
  const [map, setMap] = useState<MlMap | null>(null);
  const [tab, setTab] = useState<Tab>("risk");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [opacity, setOpacity] = useState(0.9);
  const [reporting, setReporting] = useState(false);
  const a = asset.data;
  useDocumentTitle(a?.name ?? "Asset");

  const onReady = useCallback((m: MlMap) => {
    for (const s of ["asset", "asset-buffer", "asset-threat", "near-inc"]) ensureSource(m, s);
    addLayer(m, { id: "asset-threat-line", type: "line", source: "asset-threat", paint: { "line-color": "#8b93a7", "line-width": 1, "line-dasharray": [1, 3], "line-opacity": 0.6 } });
    addLayer(m, { id: "asset-buffer-line", type: "line", source: "asset-buffer", paint: { "line-color": "#5aa9ff", "line-width": 1, "line-dasharray": [3, 3], "line-opacity": 0.7 } });
    addLayer(m, { id: "asset-fill", type: "fill", source: "asset", paint: { "fill-color": "#5aa9ff", "fill-opacity": 0.07 } });
    addLayer(m, { id: "asset-line", type: "line", source: "asset", paint: { "line-color": "#5aa9ff", "line-width": 2.2 } });
    addDetectionLayers(m, "dets", { heat: false });
    addLayer(m, { id: "near-inc", type: "circle", source: "near-inc", paint: { "circle-radius": 9, "circle-color": "rgba(255,77,94,.15)", "circle-stroke-color": "#ff4d5e", "circle-stroke-width": 2 } });
    m.on("click", "dets-pts", (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
      if (!p) return;
      popup([e.lngLat.lng, e.lngLat.lat], `<b>${esc(p.source)}</b><br>${esc(new Date(String(p.acq_time)).toLocaleString())}<br>FRP ${esc(fmtNum(Number(p.frp), 1))} MW · ${esc(CONFIDENCE_LABELS[String(p.confidence)] ?? "")} confidence<br>${Number(p.distance_km) === 0 ? "Inside the asset" : `${esc(p.distance_km)} km from the boundary`}`, m);
    });
    m.on("click", "near-inc", (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
      if (!p) return;
      popup([e.lngLat.lng, e.lngLat.lat], `<b>Incident · priority ${esc(p.priority)}</b><br>${esc(p.count)} pixels · ${esc(fmtNum(Number(p.frp_sum)))} MW FRP<br>${esc(fmtKm(Number(p.distance_km)))} ${esc(compass(Number(p.bearing_deg)))}<br><a href="/app/map?incident=${esc(p.id)}">Spread forecast →</a>`, m);
    });
    for (const l of ["dets-pts", "near-inc"]) {
      m.on("mouseenter", l, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", l, () => (m.getCanvas().style.cursor = ""));
    }
    setMap(m);
  }, []);

  useEffect(() => {
    if (!map || !a?.geometry) return;
    setData(map, "asset", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: a.geometry }] });
    const c: [number, number] = a.centroid;
    const rad = Math.sqrt((a.area_ha * 1e4) / Math.PI) / 1000;
    setData(map, "asset-buffer", a.buffer_km > 0 ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: circlePolygon(c, rad + a.buffer_km) }] } : { type: "FeatureCollection", features: [] });
    setData(map, "asset-threat", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: circlePolygon(c, rad + a.threat_radius_km) }] });
    fitGeometry(map, [a.geometry], { padding: 50, maxZoom: 13 });
  }, [map, a]);

  useEffect(() => {
    if (map && dets.data) setData(map, "dets", annotateDetections(dets.data));
  }, [map, dets.data]);

  useEffect(() => {
    if (!map || !summary.data) return;
    setData(map, "near-inc", {
      type: "FeatureCollection",
      features: summary.data.incidents_nearby.map((i) => ({ type: "Feature", properties: { ...i }, geometry: { type: "Point", coordinates: [i.lon, i.lat] } })),
    });
  }, [map, summary.data]);

  useEffect(() => {
    if (!map) return;
    if (!overlay) removeImage(map, "s2-overlay");
    else setImage(map, "s2-overlay", overlay.image.url, overlay.image.coordinates, { opacity, before: "asset-fill" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, overlay]);
  useEffect(() => {
    if (map?.getLayer("s2-overlay")) map.setPaintProperty("s2-overlay", "raster-opacity", opacity);
  }, [map, opacity]);

  if (asset.error) {
    return (
      <div className="page">
        <ErrorState error={asset.error} onRetry={asset.reload} />
        <Link to="/app/assets" className="small mt-12" style={{ display: "inline-block" }}>
          ← Back to assets
        </Link>
      </div>
    );
  }
  if (!a) return <Loading label="Loading asset" />;

  const s: AssetSummary | undefined = summary.data;
  const today = s?.risk.find((r) => r.date === new Date().toISOString().slice(0, 10)) ?? s?.risk.find((r) => r.forecast);

  const openReport = async () => {
    setReporting(true);
    const win = window.open("", "_blank");
    try {
      await assetsApi.openReport(a.id, win);
    } catch (e) {
      toast.error(e, "Report failed");
    } finally {
      setReporting(false);
    }
  };

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/app/assets">Forests &amp; assets</Link>
        <IconChevronRight size={12} />
        <span>{a.name}</span>
      </div>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="row wrap">
            <h1>{a.name}</h1>
            {!a.active && <Badge kind="warn">Paused</Badge>}
            {today && (
              <span className="danger-pill" style={{ background: dangerInfo(today.danger).color, color: today.danger === "extreme" ? "#fff" : "#14161c" }}>
                {dangerInfo(today.danger).label} danger today
              </span>
            )}
          </div>
          <div className="small muted mt-4">
            {humanize(a.kind)} · {fmtHa(a.area_ha)} · {a.centroid[1].toFixed(4)}, {a.centroid[0].toFixed(4)} · buffer {a.buffer_km} km · threat radius {a.threat_radius_km} km
          </div>
          {a.tags.length > 0 && (
            <div className="row wrap mt-8" style={{ gap: 4 }}>
              {a.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
          )}
          {a.description && <p className="small mt-8" style={{ maxWidth: 720, color: "var(--text-2)" }}>{a.description}</p>}
        </div>
        <div className="row wrap">
          <Button icon={<IconFile />} loading={reporting} onClick={openReport}>
            Situation report
          </Button>
          <Button icon={<IconDownload />} onClick={() => assetsApi.downloadTimeseries(a.id).catch((e) => toast.error(e))}>
            Time series CSV
          </Button>
          <Button icon={<IconEdit />} onClick={() => setTab("settings")}>
            Edit
          </Button>
        </div>
      </div>

      <div className="grid-4 mb-16" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Tile label="Inside · 24 h" value={s ? fmtNum(s.fires.inside_24h) : "…"} accent={s?.fires.inside_24h ? "#ff4d5e" : undefined} foot="detections in the asset" />
        <Tile label="Buffer · 24 h" value={s ? fmtNum(s.fires.buffer_24h) : "…"} accent={s?.fires.buffer_24h ? "#ff9a3c" : undefined} foot={`within ${a.buffer_km} km`} />
        <Tile label="Within 25 km · 7 d" value={s ? fmtNum(s.fires.within_25km_7d) : "…"} foot="detections" />
        <Tile label="Nearest fire" value={s ? (s.fires.nearest ? fmtKm(s.fires.nearest.km) : "None") : "…"} foot={s?.fires.nearest ? `${timeAgo(s.fires.nearest.acq_time)} · ${s.fires.nearest.source}` : "in the last 7 days"} />
        <Tile label="Latest NDVI" value={s ? fmtNum(s.vegetation.latest?.ndvi, 2) : "…"} foot={s?.vegetation.latest ? s.vegetation.latest.date : "no scenes yet"} accent="#3ecf8e" />
        <Tile label="Open alerts" value={s ? fmtNum(s.open_alerts.length) : "…"} to={`/app/alerts?asset_id=${a.id}&status=active`} />
      </div>

      <div className="detail-layout">
        <div className="detail-map">
          <MapView onReady={onReady} ariaLabel={`Map of ${a.name}`}>
            <div className="map-overlay" style={{ position: "absolute", top: 12, left: 12, zIndex: 3, padding: 4 }}>
              <select className="select sm" value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Detection window" style={{ width: "auto" }}>
                {[1, 3, 7, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    Fires · last {d} day{d > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </div>
            {overlay && (
              <div className="map-overlay" style={{ position: "absolute", left: 12, bottom: 30, zIndex: 3, padding: 10, width: 250 }}>
                <div className="row between">
                  <span className="small strong truncate">{overlay.label}</span>
                  <button className="close-btn" style={{ width: 22, height: 22 }} onClick={() => setOverlay(null)} aria-label="Remove overlay">
                    <IconX size={12} />
                  </button>
                </div>
                <div className="mt-8">
                  <RampLegend ramp={overlay.ramp} />
                </div>
                <label className="row tiny muted mt-8" style={{ gap: 8 }}>
                  Opacity
                  <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
                </label>
              </div>
            )}
          </MapView>
        </div>
        <div className="stack">
          <Card title="Fires nearby" sub="Active incidents in the last 24 h within the threat radius (or 50 km)" flush>
            {!s ? (
              <Loading />
            ) : s.incidents_nearby.length === 0 ? (
              <div className="card-body small muted">No active incidents nearby.</div>
            ) : (
              <div className="list-rows">
                {s.incidents_nearby.map((i) => {
                  const [c, bg] = prioColor(i.priority);
                  return (
                    <div key={i.id} className="row">
                      <span className="prio" style={{ color: c, background: bg, width: 34, height: 34, fontSize: 13 }}>
                        {i.priority}
                      </span>
                      <div className="grow">
                        <div className="strong small">
                          {fmtKm(i.distance_km)} {i.distance_km > 0 ? compass(i.bearing_deg) : ""} · {i.count} px · {fmtNum(i.frp_sum)} MW
                        </div>
                        <div className="tiny muted">
                          {i.status} · seen {timeAgo(i.last_seen)} · {fmtHa(i.area_ha)}
                        </div>
                      </div>
                      <Link className="btn sm" to={`/app/map?incident=${i.id}`}>
                        Forecast
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          <Card title="Open alerts" flush actions={<Link className="small" to={`/app/alerts?asset_id=${a.id}`}>All →</Link>}>
            {!s ? (
              <Loading />
            ) : s.open_alerts.length === 0 ? (
              <div className="card-body small muted">No open alerts for this asset.</div>
            ) : (
              <div className="list-rows">
                {s.open_alerts.slice(0, 5).map((x) => (
                  <Link key={x.id} to={`/app/alerts/${x.id}`} className="row" style={{ color: "var(--text)" }}>
                    <SeverityChip severity={x.severity} />
                    <span className="grow small truncate">{x.title}</span>
                    <span className="tiny muted nowrap">{timeAgo(x.created_at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card className="mt-16">
        <Tabs
          value={tab}
          onChange={setTab}
          label="Asset analysis"
          tabs={[
            { id: "risk", label: "Fire danger" },
            { id: "vegetation", label: "Vegetation" },
            { id: "imagery", label: "Imagery" },
            { id: "burn", label: "Burn severity" },
            { id: "history", label: "Fire history" },
            { id: "loss", label: "Forest loss" },
            { id: "exposure", label: "Exposure" },
            { id: "settings", label: "Settings" },
          ]}
        />
        <div className="mt-16" role="tabpanel">
          {tab === "risk" && <RiskPanel asset={a} initial={s?.risk ?? []} />}
          {tab === "vegetation" && <VegetationPanel asset={a} />}
          {tab === "imagery" && <ImageryPanel asset={a} overlay={overlay} setOverlay={setOverlay} />}
          {tab === "burn" && <BurnSeverityPanel asset={a} setOverlay={setOverlay} />}
          {tab === "history" && <HistoryPanel asset={a} />}
          {tab === "loss" && <ForestLossPanel asset={a} />}
          {tab === "exposure" && <ExposurePanel asset={a} />}
          {tab === "settings" && (
            <SettingsPanel
              asset={a}
              onSaved={(x) => {
                asset.setData(x);
                void summary.reload();
              }}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
