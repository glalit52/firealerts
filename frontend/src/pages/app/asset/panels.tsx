/* Asset-detail analysis panels. Each panel loads its own data. */
import { useEffect, useMemo, useState } from "react";
import { assets as assetsApi } from "../../../api/endpoints";
import type { Asset, BurnSeverityResult, ImageryResult, RiskDay, Scene, Vegetation } from "../../../api/types";
import { useAuth } from "../../../auth/AuthContext";
import { BarChart, HBars, LineChart, RiskChart } from "../../../components/charts";
import { IconImage, IconRefresh } from "../../../components/Icons";
import { useToast } from "../../../components/Toast";
import { Button, ButtonLink, DangerPill, EmptyState, ErrorState, Input, Loading, Notice, Segmented, Select, Tile } from "../../../components/ui";
import { dangerInfo } from "../../../lib/constants";
import { fmtDate, fmtDayMonth, fmtHa, fmtNum, fmtPct, timeAgo } from "../../../lib/format";
import { useAsync } from "../../../lib/useAsync";
import { FireStatsPanel } from "../../../components/FireStats";
import { bboxString, padBBox } from "../../../lib/geo";
import { tEnum, useT } from "../../../i18n";
import type { MsgKey } from "../../../i18n";

export type Overlay = { key: string; label: string; image: ImageryResult; ramp: keyof typeof RAMPS } | null;

export const RAMPS = {
  ndvi: { stops: [[-0.2, "rgb(120,80,50)"], [0.1, "rgb(190,160,110)"], [0.3, "rgb(230,220,120)"], [0.5, "rgb(120,190,80)"], [0.8, "rgb(20,110,40)"]], name: "ramp.ndvi" },
  nbr: { stops: [[-0.5, "rgb(90,30,20)"], [0, "rgb(200,120,60)"], [0.3, "rgb(220,220,140)"], [0.6, "rgb(60,150,70)"]], name: "ramp.nbr" },
  ndmi: { stops: [[-0.4, "rgb(160,100,40)"], [0, "rgb(230,220,160)"], [0.3, "rgb(90,170,210)"], [0.6, "rgb(20,70,160)"]], name: "ramp.ndmi" },
  dnbr: { stops: [[-0.25, "rgb(30,120,60)"], [0.1, "rgb(200,200,200)"], [0.27, "rgb(255,230,90)"], [0.44, "rgb(255,150,50)"], [0.66, "rgb(230,50,40)"], [1, "rgb(120,20,90)"]], name: "ramp.dnbr" },
} as const satisfies Record<string, { stops: readonly (readonly [number, string])[]; name: MsgKey }>;

export function RampLegend({ ramp }: { ramp: keyof typeof RAMPS }) {
  const { t } = useT();
  const r = RAMPS[ramp];
  const lo = r.stops[0]![0], hi = r.stops[r.stops.length - 1]![0];
  const grad = r.stops.map(([v, c]) => `${c} ${(((v - lo) / (hi - lo)) * 100).toFixed(0)}%`).join(", ");
  return (
    <div>
      <div className="tiny muted mb-8">{t(r.name)}</div>
      <div className="ramp" style={{ background: `linear-gradient(90deg, ${grad})` }} />
      <div className="row between tiny muted mt-4">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
    </div>
  );
}

const SEVERITY_CLASS_COLORS: Record<string, string> = {
  "enhanced regrowth (high)": "rgb(30,120,60)",
  "enhanced regrowth (low)": "rgb(110,160,100)",
  unburned: "rgb(200,200,200)",
  "low severity": "rgb(255,230,90)",
  "moderate-low severity": "rgb(255,150,50)",
  "moderate-high severity": "rgb(230,50,40)",
  "high severity": "rgb(120,20,90)",
};

// ------------------------------------------------------------------ Fire danger & ignition forecast
export function RiskPanel({ asset, initial }: { asset: Asset; initial: RiskDay[] }) {
  const toast = useToast();
  const { t } = useT();
  const [days, setDays] = useState<RiskDay[]>(initial);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    assetsApi
      .risk(asset.id)
      .then((r) => setDays(r.days))
      .catch((e) => toast.error(e))
      .finally(() => setLoaded(true));
  }, [asset.id, toast]);
  const refresh = async () => {
    setBusy(true);
    try {
      setDays((await assetsApi.risk(asset.id, true)).days);
      toast.success(t("risk.refreshed"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const today = sorted.find((d) => d.date === new Date().toISOString().slice(0, 10)) ?? sorted.find((d) => d.forecast) ?? sorted[0];
  const worst = sorted.filter((d) => d.forecast).reduce<RiskDay | null>((w, d) => (!w || d.fwi > w.fwi ? d : w), null);
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="small muted">
          {t("risk.lead", { model: String(today?.data?.model ?? "risk") })}
          {today?.computed_at && ` ${t("risk.updated", { ago: timeAgo(today.computed_at) })}`}
        </div>
        <Button size="sm" icon={<IconRefresh />} loading={busy} onClick={refresh}>
          {t("risk.recompute")}
        </Button>
      </div>
      {!loaded && !days.length ? (
        <Loading label={t("risk.computing")} />
      ) : !days.length ? (
        <EmptyState title={t("risk.none")}>{t("risk.noneBody")}</EmptyState>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label={t("risk.dangerToday")} value={today ? <span style={{ color: dangerInfo(today.danger).color }}>{dangerInfo(today.danger).label}</span> : "–"} />
            <Tile compact label={t("assets.fwiToday")} value={fmtNum(today?.fwi, 1)} />
            <Tile compact label={t("chart.ignition")} value={fmtPct(today?.ignition_p, 1)} />
            <Tile compact label={t("risk.worst")} value={worst ? `${fmtDayMonth(worst.date)} · ${fmtNum(worst.fwi)}` : "–"} />
          </div>
          <RiskChart days={sorted} />
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{t("col.date")}</th>
                  <th>{t("overview.col.danger")}</th>
                  <th className="right">FWI</th>
                  <th className="right">{t("overview.col.ignition")}</th>
                  <th className="right">{t("fc.temp")}</th>
                  <th className="right">RH</th>
                  <th className="right">{t("wind.layer")}</th>
                  <th className="right">{t("risk.rain")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.date} style={{ opacity: d.forecast ? 1 : 0.7 }}>
                    <td className="nowrap">
                      {fmtDate(d.date)} <span className="tiny muted">{d.forecast ? t("chart.forecast") : t("chart.observed")}</span>
                    </td>
                    <td>
                      <DangerPill danger={d.danger} />
                    </td>
                    <td className="right">{fmtNum(d.fwi, 1)}</td>
                    <td className="right">{fmtPct(d.ignition_p, 1)}</td>
                    <td className="right">{d.data?.temp != null ? `${fmtNum(Number(d.data.temp))}°` : "–"}</td>
                    <td className="right">{d.data?.rh != null ? `${fmtNum(Number(d.data.rh))}%` : "–"}</td>
                    <td className="right">{d.data?.wind != null ? `${fmtNum(Number(d.data.wind))} km/h` : "–"}</td>
                    <td className="right">{d.data?.rain != null ? `${fmtNum(Number(d.data.rain), 1)} mm` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {asset.risk_alerts ? (
            <div className="tiny muted">{t("risk.alertsOn", { danger: dangerInfo(asset.risk_min_danger).label })}</div>
          ) : (
            <div className="tiny muted">{t("risk.alertsOff")}</div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Vegetation
export function VegetationPanel({ asset }: { asset: Asset }) {
  const { can } = useAuth();
  const toast = useToast();
  const { t } = useT();
  const veg = useAsync(() => assetsApi.vegetation(asset.id, 365), [asset.id]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [days, setDays] = useState(120);
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);
  const refresh = async () => {
    setBusy(true);
    setElapsed(0);
    try {
      const r = await assetsApi.refreshVegetation(asset.id, days);
      toast.success(t("veg.found", { found: r.scenes_found ?? 0, analysed: r.analysed ?? 0 }));
      await veg.reload();
    } catch (e) {
      toast.error(e, t("veg.failed"));
    } finally {
      setBusy(false);
    }
  };
  // One point per date: same-day acquisitions (e.g. S2A + S2B tiles) are averaged.
  const obs = useMemo(() => {
    const by = new Map<string, { date: string; n: Record<string, number>; s: Record<string, number> }>();
    for (const o of veg.data?.observations ?? []) {
      if (o.ndvi == null && o.nbr == null) continue;
      const e = by.get(o.date) ?? { date: o.date, n: {}, s: {} };
      for (const k of ["ndvi", "nbr", "ndmi"] as const) {
        const v = o[k];
        if (v != null) {
          e.s[k] = (e.s[k] ?? 0) + v;
          e.n[k] = (e.n[k] ?? 0) + 1;
        }
      }
      by.set(o.date, e);
    }
    const avg = (e: { n: Record<string, number>; s: Record<string, number> }, k: string) => (e.n[k] ? e.s[k]! / e.n[k]! : null);
    return [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({ date: e.date, ndvi: avg(e, "ndvi"), nbr: avg(e, "nbr"), ndmi: avg(e, "ndmi") }));
  }, [veg.data]);
  const v: Vegetation | undefined = veg.data;
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="small muted">{t("veg.lead")}</div>
        {can("member") && (
          <div className="row">
            <Select inputSize="sm" value={days} onChange={(e) => setDays(+e.target.value)} aria-label={t("veg.period")} style={{ width: 140 }}>
              <option value={60}>{t("common.lastDays", { n: 60 })}</option>
              <option value={120}>{t("common.lastDays", { n: 120 })}</option>
              <option value={365}>{t("veg.lastYear")}</option>
              <option value={730}>{t("veg.last2Years")}</option>
            </Select>
            <Button size="sm" variant="primary" icon={<IconRefresh />} loading={busy} onClick={refresh}>
              {t("veg.fetch")}
            </Button>
          </div>
        )}
      </div>
      {busy && (
        <div className="card inset" style={{ padding: 12 }}>
          <div className="small">{t("veg.searching", { s: elapsed })}</div>
          <div className="tiny muted mt-4">{t("veg.searchingNote")}</div>
          <div className="progress-indeterminate mt-8" />
        </div>
      )}
      {veg.error ? (
        <ErrorState error={veg.error} onRetry={veg.reload} />
      ) : !v ? (
        <Loading />
      ) : obs.length === 0 ? (
        <EmptyState icon={<IconImage size={20} />} title={t("veg.none")}>
          {can("member") ? t("veg.noneMember") : t("veg.noneViewer")}
        </EmptyState>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label={t("asset.tile.ndvi")} value={fmtNum(v.latest?.ndvi, 2)} foot={v.latest ? fmtDate(v.latest.date) : undefined} />
            <Tile compact label={t("veg.latestNbr")} value={fmtNum(v.latest?.nbr, 2)} />
            <Tile compact label={t("veg.latestNdmi")} value={fmtNum(v.latest?.ndmi, 2)} />
            <Tile
              compact
              label={t("veg.ndviChange")}
              value={
                v.trend?.ndvi_change != null ? (
                  <span style={{ color: v.trend.ndvi_change < -0.05 ? "var(--bad)" : v.trend.ndvi_change > 0.05 ? "var(--ok)" : undefined }}>
                    {v.trend.ndvi_change > 0 ? "+" : ""}
                    {fmtNum(v.trend.ndvi_change, 3)}
                  </span>
                ) : (
                  "–"
                )
              }
              foot={v.trend ? `${fmtDayMonth(v.trend.from)} → ${fmtDayMonth(v.trend.to)}` : undefined}
            />
          </div>
          {v.trend?.possible_burn && (
            <Notice kind="warn" title={t("veg.possibleBurn")}>
              {t("veg.possibleBurnBody", { from: fmtDate(v.trend.from), to: fmtDate(v.trend.to) })}
            </Notice>
          )}
          <LineChart
            ariaLabel={t("veg.chartAria")}
            zeroLine
            series={[
              { name: "NDVI", color: "#3ecf8e", points: obs.map((o) => ({ x: o.date, y: o.ndvi })) },
              { name: "NBR", color: "#ff9a3c", points: obs.map((o) => ({ x: o.date, y: o.nbr })) },
              { name: "NDMI", color: "#5aa9ff", points: obs.map((o) => ({ x: o.date, y: o.ndmi })), dashed: true },
            ]}
          />
          <details>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              {t("veg.analysed", { count: v.observations.length })}
            </summary>
            <div className="table-wrap mt-8">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>{t("col.date")}</th>
                    <th>{t("veg.scene")}</th>
                    <th className="right">{t("veg.cloud")}</th>
                    <th className="right">{t("veg.clear")}</th>
                    <th className="right">NDVI</th>
                    <th className="right">NBR</th>
                    <th className="right">NDMI</th>
                  </tr>
                </thead>
                <tbody>
                  {[...v.observations].reverse().map((o) => (
                    <tr key={o.scene_id}>
                      <td>{fmtDate(o.date)}</td>
                      <td className="mono tiny">{o.scene_id}</td>
                      <td className="right">{o.cloud_pct != null ? `${fmtNum(o.cloud_pct)}%` : "–"}</td>
                      <td className="right">{fmtPct(o.valid_frac)}</td>
                      <td className="right">{fmtNum(o.ndvi, 3)}</td>
                      <td className="right">{fmtNum(o.nbr, 3)}</td>
                      <td className="right">{fmtNum(o.ndmi, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Scenes hook
export function useScenes(assetId: number, enabled: boolean) {
  return useAsync(() => assetsApi.scenes(assetId, 180, 60), [assetId], { enabled });
}

function SceneList({ scenes, selected, onSelect }: { scenes: Scene[]; selected?: string; onSelect: (s: Scene) => void }) {
  const { t } = useT();
  return (
    <div className="scene-list" role="listbox" aria-label={t("img.scenesAria")}>
      {scenes.map((s) => (
        <button key={s.id} role="option" aria-selected={selected === s.id} className={`scene-row ${selected === s.id ? "sel" : ""}`} onClick={() => onSelect(s)}>
          <span className="grow">
            <span className="strong">{fmtDate(s.date)}</span>
            <span className="tiny muted mono" style={{ display: "block" }}>
              {s.id}
            </span>
          </span>
          <span className="cloud-bar" title={t("img.cloudPct", { n: fmtNum(s.cloud_pct) })}>
            <i style={{ width: `${Math.min(100, s.cloud_pct ?? 0)}%` }} />
          </span>
          <span className="tiny muted num" style={{ width: 36, textAlign: "right" }}>
            {fmtNum(s.cloud_pct)}%
          </span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Imagery
export function ImageryPanel({ asset, overlay, setOverlay }: { asset: Asset; overlay: Overlay; setOverlay: (o: Overlay) => void }) {
  const toast = useToast();
  const { t } = useT();
  const scenes = useScenes(asset.id, true);
  const [index, setIndex] = useState<"ndvi" | "nbr" | "ndmi">("ndvi");
  const [busy, setBusy] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | undefined>(undefined);
  const show = async (sid?: string, idx = index) => {
    setBusy(sid ?? "latest");
    try {
      const img = await assetsApi.imagery(asset.id, idx, sid);
      setSceneId(img.scene.id);
      setOverlay({ key: `${idx}:${img.scene.id}`, label: `${idx.toUpperCase()} · ${fmtDate(img.scene.date)} · ${t("img.cloudPct", { n: fmtNum(img.scene.cloud_pct) })}`, image: img, ramp: idx });
    } catch (e) {
      toast.error(e, t("img.failed"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <div className="row between wrap">
        <Segmented
          value={index}
          onChange={(v) => {
            setIndex(v);
            if (overlay && overlay.ramp !== "dnbr") void show(sceneId, v);
          }}
          options={[
            { value: "ndvi", label: "NDVI" },
            { value: "nbr", label: "NBR" },
            { value: "ndmi", label: "NDMI" },
          ]}
          label={t("img.index")}
        />
        <div className="row">
          <Button size="sm" variant="primary" loading={busy === "latest"} onClick={() => show(undefined)}>
            {t("img.latest")}
          </Button>
          {overlay && (
            <Button size="sm" variant="ghost" onClick={() => setOverlay(null)}>
              {t("asset.removeOverlay")}
            </Button>
          )}
        </div>
      </div>
      <RampLegend ramp={index} />
      <div className="section-title" style={{ margin: "4px 0 0" }}>
        {t("img.scenes")}
      </div>
      {scenes.error ? (
        <ErrorState error={scenes.error} onRetry={scenes.reload} />
      ) : !scenes.data ? (
        <Loading label={t("img.searching")} />
      ) : scenes.data.length === 0 ? (
        <div className="small muted">{t("img.none")}</div>
      ) : (
        <>
          <SceneList scenes={scenes.data} selected={sceneId} onSelect={(s) => show(s.id)} />
          {busy && busy !== "latest" && <div className="row small muted"><span className="spinner" /> {t("img.rendering", { index: index.toUpperCase() })}</div>}
        </>
      )}
      <div className="tiny muted">{t("img.note")}</div>
    </div>
  );
}

// ------------------------------------------------------------------ Burn severity
export function BurnSeverityPanel({ asset, setOverlay }: { asset: Asset; setOverlay: (o: Overlay) => void }) {
  const toast = useToast();
  const { t } = useT();
  const [mode, setMode] = useState<"auto" | "dates" | "scenes">("auto");
  const scenes = useScenes(asset.id, mode === "scenes");
  const [pre, setPre] = useState("");
  const [post, setPost] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<BurnSeverityResult | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const body = mode === "dates" ? { pre_date: pre || undefined, post_date: post || undefined } : mode === "scenes" ? { pre_scene_id: pre || undefined, post_scene_id: post || undefined } : {};
      const r = await assetsApi.burnSeverity(asset.id, body);
      setRes(r);
      setOverlay({ key: `dnbr:${r.pre.id}:${r.post.id}`, label: `dNBR · ${fmtDate(r.pre.date)} → ${fmtDate(r.post.date)}`, image: r.image, ramp: "dnbr" });
    } catch (e) {
      toast.error(e, t("burn.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="small muted">{t("burn.lead")}</div>
      <Segmented
        value={mode}
        onChange={(v) => {
          setMode(v);
          setPre("");
          setPost("");
        }}
        options={[
          { value: "auto", label: t("burn.auto") },
          { value: "dates", label: t("burn.dates") },
          { value: "scenes", label: t("burn.scenes") },
        ]}
        label={t("burn.selection")}
      />
      {mode === "dates" && (
        <div className="form-grid">
          <Input label={t("burn.pre")} type="date" value={pre} onChange={(e) => setPre(e.target.value)} max={post || undefined} />
          <Input label={t("burn.post")} type="date" value={post} onChange={(e) => setPost(e.target.value)} min={pre || undefined} />
        </div>
      )}
      {mode === "scenes" &&
        (scenes.data ? (
          <div className="form-grid">
            <Select label={t("burn.preScene")} value={pre} onChange={(e) => setPre(e.target.value)}>
              <option value="">{t("burn.preAuto")}</option>
              {scenes.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.date} · {t("img.cloudPct", { n: fmtNum(s.cloud_pct) })} · {s.id.split("_")[0]}
                </option>
              ))}
            </Select>
            <Select label={t("burn.postScene")} value={post} onChange={(e) => setPost(e.target.value)}>
              <option value="">{t("burn.postAuto")}</option>
              {scenes.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.date} · {t("img.cloudPct", { n: fmtNum(s.cloud_pct) })} · {s.id.split("_")[0]}
                </option>
              ))}
            </Select>
          </div>
        ) : scenes.error ? (
          <ErrorState error={scenes.error} onRetry={scenes.reload} />
        ) : (
          <Loading label={t("img.searching")} />
        ))}
      <div>
        <Button variant="primary" loading={busy} onClick={run}>
          {busy ? t("burn.running") : t("burn.run")}
        </Button>
      </div>
      {busy && <div className="progress-indeterminate" />}
      {res && (
        <>
          <div className="grid-4">
            <Tile compact label={t("burn.burned")} value={fmtHa(res.burned_ha)} foot={fmtPct(res.burned_fraction, 1)} />
            <Tile compact label={t("burn.mean")} value={fmtNum(res.dnbr.mean, 3)} />
            <Tile compact label="P90 dNBR" value={fmtNum(res.dnbr.p90, 3)} />
            <Tile compact label={t("burn.clear")} value={fmtPct(res.valid_frac)} />
          </div>
          <div className="small muted">
            {t("burn.prePost", { pre: fmtDate(res.pre.date), preCloud: fmtNum(res.pre.cloud_pct), post: fmtDate(res.post.date), postCloud: fmtNum(res.post.cloud_pct) })}
          </div>
          <HBars rows={res.classes.map((c) => ({ label: tEnum("burnClass", c.class), value: c.fraction, color: SEVERITY_CLASS_COLORS[c.class], right: `${fmtHa(c.area_ha)}` }))} />
          <RampLegend ramp="dnbr" />
          {res.valid_frac < 0.5 && <Notice kind="warn">{t("burn.cloudy")}</Notice>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Fire history
export function HistoryPanel({ asset }: { asset: Asset }) {
  const { t } = useT();
  const [years, setYears] = useState(5);
  const h = useAsync(() => assetsApi.history(asset.id, years), [asset.id, years]);
  const r = h.data?.result;
  // Last 30 days of detections around the asset: its bbox padded by the threat radius (at least 10 km).
  const statsBox = useMemo(() => (asset.bbox?.length === 4 ? bboxString(padBBox(asset.bbox, Math.max(10, asset.threat_radius_km || 0)), 3) : null), [asset.bbox, asset.threat_radius_km]);
  return (
    <div className="stack">
      {statsBox && (
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            {t("hist.stats30")}
          </div>
          <div className="small muted mb-8">{t("hist.stats30Lead", { km: Math.max(10, asset.threat_radius_km || 0) })}</div>
          <FireStatsPanel bbox={statsBox} days={30} />
        </div>
      )}
      <hr className="divider" style={{ margin: "4px 0" }} />
      <div className="row between wrap">
        <div className="small muted">{t("hist.lead", { source: h.data?.source ?? "…" })}</div>
        <Select inputSize="sm" style={{ width: 120 }} value={years} onChange={(e) => setYears(+e.target.value)} aria-label={t("hist.years")}>
          {[1, 3, 5, 10, 20].map((y) => (
            <option key={y} value={y}>
              {t("hist.yearN", { count: y })}
            </option>
          ))}
        </Select>
      </div>
      {h.error ? (
        <ErrorState error={h.error} onRetry={h.reload} />
      ) : !r ? (
        <Loading label={t("hist.loading")} />
      ) : (
        <>
          {r.errors?.length ? <Notice kind="warn" title={t("hist.someUnavailable")}>{r.errors.join(" · ")}</Notice> : null}
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>
              {t("hist.burnedByMonth")}
            </div>
            {r.months.length ? (
              <BarChart ariaLabel={t("hist.burnedAria")} data={r.months.map((m) => ({ label: m.month, value: m.burned_ha }))} formatValue={(v) => fmtNum(v)} color="#ff6a2b" />
            ) : (
              <div className="small muted">{r.errors?.length ? t("hist.noBurnedAvailable") : t("hist.noBurnedMapped")}</div>
            )}
          </div>
          <div>
            <div className="section-title">{t("hist.detByMonth")}</div>
            {r.archive.length ? (
              <BarChart ariaLabel={t("hist.detAria")} data={r.archive.map((m) => ({ label: m.month, value: m.detections }))} color="#ffb02b" />
            ) : (
              <div className="small muted">{t("hist.noDet")}</div>
            )}
          </div>
          <div className="tiny muted">{t("hist.computed", { ago: timeAgo(h.data?.created_at) })}</div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Forest loss
export function ForestLossPanel({ asset }: { asset: Asset }) {
  const { t } = useT();
  const fl = useAsync(() => assetsApi.forestLoss(asset.id), [asset.id]);
  const r = fl.data?.result;
  const total = (r?.loss_by_year ?? []).reduce((a, x) => a + x.loss_ha, 0);
  return (
    <div className="stack">
      <div className="small muted">{t("loss.lead", { source: fl.data?.source ?? t("loss.notConnected") })}</div>
      {fl.error ? (
        <ErrorState error={fl.error} onRetry={fl.reload} />
      ) : !r ? (
        <Loading />
      ) : r.loss_by_year.length === 0 ? (
        <Notice kind={r.errors?.some((e) => /connect/i.test(e)) ? "info" : "warn"} title={t("loss.unavailable")} action={<ButtonLink size="sm" to="/app/integrations">{t("nav.integrations")}</ButtonLink>}>
          {(r.errors ?? [t("loss.noLoss")]).join(" · ")}
        </Notice>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label={t("loss.total")} value={fmtHa(total)} foot={`${r.loss_by_year[0]?.year}–${r.loss_by_year[r.loss_by_year.length - 1]?.year}`} />
            <Tile compact label={t("loss.share")} value={fmtPct(total / Math.max(1, asset.area_ha), 1)} />
            {r.recent_alerts && <Tile compact label={t("loss.recent")} value={fmtNum(r.recent_alerts.alerts)} foot={t("loss.since", { date: fmtDate(r.recent_alerts.since) })} />}
            {r.recent_alerts && <Tile compact label={t("loss.alertArea")} value={fmtHa(r.recent_alerts.area_ha)} />}
          </div>
          <BarChart ariaLabel={t("loss.chartAria")} data={r.loss_by_year.map((x) => ({ label: String(x.year), value: x.loss_ha }))} color="#a1124a" />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Exposure
export function ExposurePanel({ asset }: { asset: Asset }) {
  const { t } = useT();
  const [radius, setRadius] = useState(10);
  const ex = useAsync(() => assetsApi.exposure(asset.id, radius), [asset.id, radius]);
  const r = ex.data?.result;
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="small muted">{t("exp.lead")}</div>
        <Select inputSize="sm" style={{ width: 120 }} value={radius} onChange={(e) => setRadius(+e.target.value)} aria-label={t("exp.radius")}>
          {[5, 10, 25, 50].map((v) => (
            <option key={v} value={v}>
              {v} km
            </option>
          ))}
        </Select>
      </div>
      {ex.error ? (
        <ErrorState error={ex.error} onRetry={ex.reload} />
      ) : !r ? (
        <Loading label={t("exp.querying")} />
      ) : r.error ? (
        <Notice kind="warn" title={t("exp.unavailable")}>
          {r.error}
        </Notice>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label={t("exp.settlements")} value={fmtNum(r.settlements)} />
            <Tile compact label={t("exp.buildings")} value={fmtNum(r.buildings)} />
            <Tile compact label={t("exp.roads")} value={fmtNum(r.road_segments)} />
            <Tile compact label={t("exp.searchRadius")} value={`${fmtNum((r.radius_m ?? 0) / 1000, 1)} km`} />
          </div>
          {r.places?.length ? (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>{t("exp.place")}</th>
                    <th>{t("exp.type")}</th>
                    <th className="right">{t("exp.population")}</th>
                    <th className="right">{t("exp.coords")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.places.map((p, i) => (
                    <tr key={`${p.name}-${i}`}>
                      <td>{p.name || <span className="muted">{t("exp.unnamed")}</span>}</td>
                      <td>{tEnum("place", p.place)}</td>
                      <td className="right">{p.population ? fmtNum(Number(p.population)) : "–"}</td>
                      <td className="right mono tiny">
                        {p.lat?.toFixed(4)}, {p.lon?.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="small muted">{t("exp.noPlaces")}</div>
          )}
        </>
      )}
    </div>
  );
}
