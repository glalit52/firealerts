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
import { fmtDate, fmtHa, fmtNum, fmtPct, humanize, timeAgo } from "../../../lib/format";
import { useAsync } from "../../../lib/useAsync";

export type Overlay = { key: string; label: string; image: ImageryResult; ramp: keyof typeof RAMPS } | null;

export const RAMPS = {
  ndvi: { stops: [[-0.2, "rgb(120,80,50)"], [0.1, "rgb(190,160,110)"], [0.3, "rgb(230,220,120)"], [0.5, "rgb(120,190,80)"], [0.8, "rgb(20,110,40)"]], name: "NDVI · vegetation greenness" },
  nbr: { stops: [[-0.5, "rgb(90,30,20)"], [0, "rgb(200,120,60)"], [0.3, "rgb(220,220,140)"], [0.6, "rgb(60,150,70)"]], name: "NBR · normalised burn ratio" },
  ndmi: { stops: [[-0.4, "rgb(160,100,40)"], [0, "rgb(230,220,160)"], [0.3, "rgb(90,170,210)"], [0.6, "rgb(20,70,160)"]], name: "NDMI · vegetation moisture" },
  dnbr: { stops: [[-0.25, "rgb(30,120,60)"], [0.1, "rgb(200,200,200)"], [0.27, "rgb(255,230,90)"], [0.44, "rgb(255,150,50)"], [0.66, "rgb(230,50,40)"], [1, "rgb(120,20,90)"]], name: "dNBR · burn severity" },
} as const;

export function RampLegend({ ramp }: { ramp: keyof typeof RAMPS }) {
  const r = RAMPS[ramp];
  const lo = r.stops[0]![0], hi = r.stops[r.stops.length - 1]![0];
  const grad = r.stops.map(([v, c]) => `${c} ${(((v - lo) / (hi - lo)) * 100).toFixed(0)}%`).join(", ");
  return (
    <div>
      <div className="tiny muted mb-8">{r.name}</div>
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
      toast.success("Fire-danger forecast refreshed.");
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
          Canadian FWI System from observed + forecast weather; ignition probability from the {String(today?.data?.model ?? "risk")} model.
          {today?.computed_at && ` Updated ${timeAgo(today.computed_at)}.`}
        </div>
        <Button size="sm" icon={<IconRefresh />} loading={busy} onClick={refresh}>
          Recompute
        </Button>
      </div>
      {!loaded && !days.length ? (
        <Loading label="Computing fire danger" />
      ) : !days.length ? (
        <EmptyState title="No forecast yet">Fire danger is computed automatically; press Recompute to run it now.</EmptyState>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label="Danger today" value={today ? <span style={{ color: dangerInfo(today.danger).color }}>{dangerInfo(today.danger).label}</span> : "–"} />
            <Tile compact label="FWI today" value={fmtNum(today?.fwi, 1)} />
            <Tile compact label="Ignition probability" value={fmtPct(today?.ignition_p, 1)} />
            <Tile compact label="Worst day ahead" value={worst ? `${fmtDate(worst.date).slice(0, 6)} · ${fmtNum(worst.fwi)}` : "–"} />
          </div>
          <RiskChart days={sorted} />
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Danger</th>
                  <th className="right">FWI</th>
                  <th className="right">Ignition</th>
                  <th className="right">Temp</th>
                  <th className="right">RH</th>
                  <th className="right">Wind</th>
                  <th className="right">Rain</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.date} style={{ opacity: d.forecast ? 1 : 0.7 }}>
                    <td className="nowrap">
                      {fmtDate(d.date)} <span className="tiny muted">{d.forecast ? "forecast" : "observed"}</span>
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
            <div className="tiny muted">Risk alerts are on: you'll be warned ahead of days at “{dangerInfo(asset.risk_min_danger).label}” or worse.</div>
          ) : (
            <div className="tiny muted">Risk alerts are off for this asset (enable them in Settings).</div>
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
      toast.success(`Found ${r.scenes_found ?? 0} Sentinel-2 scenes, analysed ${r.analysed ?? 0} new.`);
      await veg.reload();
    } catch (e) {
      toast.error(e, "Sentinel-2 refresh failed");
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
        <div className="small muted">Copernicus Sentinel-2 L2A, cloud-masked per scene (SCL). Scenes with too little clear area are kept but not plotted.</div>
        {can("member") && (
          <div className="row">
            <Select inputSize="sm" value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Look-back period" style={{ width: 130 }}>
              <option value={60}>Last 60 days</option>
              <option value={120}>Last 120 days</option>
              <option value={365}>Last year</option>
              <option value={730}>Last 2 years</option>
            </Select>
            <Button size="sm" variant="primary" icon={<IconRefresh />} loading={busy} onClick={refresh}>
              Fetch new scenes
            </Button>
          </div>
        )}
      </div>
      {busy && (
        <div className="card inset" style={{ padding: 12 }}>
          <div className="small">Searching and analysing Sentinel-2 scenes… {elapsed}s</div>
          <div className="tiny muted mt-4">This reads cloud-optimised imagery from AWS and usually takes 10–30 seconds.</div>
          <div className="progress-indeterminate mt-8" />
        </div>
      )}
      {veg.error ? (
        <ErrorState error={veg.error} onRetry={veg.reload} />
      ) : !v ? (
        <Loading />
      ) : obs.length === 0 ? (
        <EmptyState icon={<IconImage size={20} />} title="No vegetation data yet">
          {can("member") ? "Press “Fetch new scenes” to analyse recent Sentinel-2 imagery for this asset." : "No Sentinel-2 scenes have been analysed for this asset yet."}
        </EmptyState>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label="Latest NDVI" value={fmtNum(v.latest?.ndvi, 2)} foot={v.latest ? fmtDate(v.latest.date) : undefined} />
            <Tile compact label="Latest NBR" value={fmtNum(v.latest?.nbr, 2)} />
            <Tile compact label="Latest NDMI" value={fmtNum(v.latest?.ndmi, 2)} />
            <Tile
              compact
              label="NDVI change"
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
              foot={v.trend ? `${fmtDate(v.trend.from).slice(0, 6)} → ${fmtDate(v.trend.to).slice(0, 6)}` : undefined}
            />
          </div>
          {v.trend?.possible_burn && (
            <Notice kind="warn" title="Possible burn detected">
              NBR dropped sharply between {fmtDate(v.trend.from)} and {fmtDate(v.trend.to)}. Run a burn-severity analysis to map it.
            </Notice>
          )}
          <LineChart
            ariaLabel="Vegetation indices over time"
            zeroLine
            series={[
              { name: "NDVI", color: "#3ecf8e", points: obs.map((o) => ({ x: o.date, y: o.ndvi })) },
              { name: "NBR", color: "#ff9a3c", points: obs.map((o) => ({ x: o.date, y: o.nbr })) },
              { name: "NDMI", color: "#5aa9ff", points: obs.map((o) => ({ x: o.date, y: o.ndmi })), dashed: true },
            ]}
          />
          <details>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              {fmtNum(v.observations.length)} scenes analysed
            </summary>
            <div className="table-wrap mt-8">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Scene</th>
                    <th className="right">Cloud</th>
                    <th className="right">Clear</th>
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
  return (
    <div className="scene-list" role="listbox" aria-label="Sentinel-2 scenes">
      {scenes.map((s) => (
        <button key={s.id} role="option" aria-selected={selected === s.id} className={`scene-row ${selected === s.id ? "sel" : ""}`} onClick={() => onSelect(s)}>
          <span className="grow">
            <span className="strong">{fmtDate(s.date)}</span>
            <span className="tiny muted mono" style={{ display: "block" }}>
              {s.id}
            </span>
          </span>
          <span className="cloud-bar" title={`${fmtNum(s.cloud_pct)}% cloud`}>
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
  const scenes = useScenes(asset.id, true);
  const [index, setIndex] = useState<"ndvi" | "nbr" | "ndmi">("ndvi");
  const [busy, setBusy] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | undefined>(undefined);
  const show = async (sid?: string, idx = index) => {
    setBusy(sid ?? "latest");
    try {
      const img = await assetsApi.imagery(asset.id, idx, sid);
      setSceneId(img.scene.id);
      setOverlay({ key: `${idx}:${img.scene.id}`, label: `${idx.toUpperCase()} · ${fmtDate(img.scene.date)} · ${fmtNum(img.scene.cloud_pct)}% cloud`, image: img, ramp: idx });
    } catch (e) {
      toast.error(e, "Imagery failed");
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
          label="Index"
        />
        <div className="row">
          <Button size="sm" variant="primary" loading={busy === "latest"} onClick={() => show(undefined)}>
            Latest clear scene
          </Button>
          {overlay && (
            <Button size="sm" variant="ghost" onClick={() => setOverlay(null)}>
              Remove overlay
            </Button>
          )}
        </div>
      </div>
      <RampLegend ramp={index} />
      <div className="section-title" style={{ margin: "4px 0 0" }}>
        Scenes · last 180 days, ≤60% cloud
      </div>
      {scenes.error ? (
        <ErrorState error={scenes.error} onRetry={scenes.reload} />
      ) : !scenes.data ? (
        <Loading label="Searching Sentinel-2" />
      ) : scenes.data.length === 0 ? (
        <div className="small muted">No Sentinel-2 scenes found for this area.</div>
      ) : (
        <>
          <SceneList scenes={scenes.data} selected={sceneId} onSelect={(s) => show(s.id)} />
          {busy && busy !== "latest" && <div className="row small muted"><span className="spinner" /> Rendering {index.toUpperCase()}…</div>}
        </>
      )}
      <div className="tiny muted">The index is rendered on the asset's bounding box; areas outside the polygon are dimmed. Clouds and shadows are transparent.</div>
    </div>
  );
}

// ------------------------------------------------------------------ Burn severity
export function BurnSeverityPanel({ asset, setOverlay }: { asset: Asset; setOverlay: (o: Overlay) => void }) {
  const toast = useToast();
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
      toast.error(e, "Burn severity failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="small muted">Differenced Normalised Burn Ratio (dNBR) between a pre-fire and a post-fire Sentinel-2 scene, classified with USGS severity thresholds.</div>
      <Segmented
        value={mode}
        onChange={(v) => {
          setMode(v);
          setPre("");
          setPost("");
        }}
        options={[
          { value: "auto", label: "Latest vs. 30 days before" },
          { value: "dates", label: "Pick dates" },
          { value: "scenes", label: "Pick scenes" },
        ]}
        label="Scene selection"
      />
      {mode === "dates" && (
        <div className="form-grid">
          <Input label="Pre-fire (on or before)" type="date" value={pre} onChange={(e) => setPre(e.target.value)} max={post || undefined} />
          <Input label="Post-fire (on or after)" type="date" value={post} onChange={(e) => setPost(e.target.value)} min={pre || undefined} />
        </div>
      )}
      {mode === "scenes" &&
        (scenes.data ? (
          <div className="form-grid">
            <Select label="Pre-fire scene" value={pre} onChange={(e) => setPre(e.target.value)}>
              <option value="">Auto (≈30 days before post)</option>
              {scenes.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.date} · {fmtNum(s.cloud_pct)}% cloud · {s.id.split("_")[0]}
                </option>
              ))}
            </Select>
            <Select label="Post-fire scene" value={post} onChange={(e) => setPost(e.target.value)}>
              <option value="">Auto (latest)</option>
              {scenes.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.date} · {fmtNum(s.cloud_pct)}% cloud · {s.id.split("_")[0]}
                </option>
              ))}
            </Select>
          </div>
        ) : scenes.error ? (
          <ErrorState error={scenes.error} onRetry={scenes.reload} />
        ) : (
          <Loading label="Searching Sentinel-2" />
        ))}
      <div>
        <Button variant="primary" loading={busy} onClick={run}>
          {busy ? "Analysing scenes…" : "Run burn-severity analysis"}
        </Button>
      </div>
      {busy && <div className="progress-indeterminate" />}
      {res && (
        <>
          <div className="grid-4">
            <Tile compact label="Burned area" value={fmtHa(res.burned_ha)} foot={fmtPct(res.burned_fraction, 1)} />
            <Tile compact label="Mean dNBR" value={fmtNum(res.dnbr.mean, 3)} />
            <Tile compact label="P90 dNBR" value={fmtNum(res.dnbr.p90, 3)} />
            <Tile compact label="Clear pixels" value={fmtPct(res.valid_frac)} />
          </div>
          <div className="small muted">
            Pre {fmtDate(res.pre.date)} ({fmtNum(res.pre.cloud_pct)}% cloud) → post {fmtDate(res.post.date)} ({fmtNum(res.post.cloud_pct)}% cloud)
          </div>
          <HBars rows={res.classes.map((c) => ({ label: humanize(c.class), value: c.fraction, color: SEVERITY_CLASS_COLORS[c.class], right: `${fmtHa(c.area_ha)}` }))} />
          <RampLegend ramp="dnbr" />
          {res.valid_frac < 0.5 && <Notice kind="warn">Less than half the asset was cloud-free in both scenes; results may be unrepresentative.</Notice>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Fire history
export function HistoryPanel({ asset }: { asset: Asset }) {
  const [years, setYears] = useState(5);
  const h = useAsync(() => assetsApi.history(asset.id, years), [asset.id, years]);
  const r = h.data?.result;
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="small muted">MODIS MCD64A1 monthly burned area plus the platform's own detection archive. Source: {h.data?.source ?? "…"}</div>
        <Select inputSize="sm" style={{ width: 120 }} value={years} onChange={(e) => setYears(+e.target.value)} aria-label="Years">
          {[1, 3, 5, 10, 20].map((y) => (
            <option key={y} value={y}>
              {y} year{y > 1 ? "s" : ""}
            </option>
          ))}
        </Select>
      </div>
      {h.error ? (
        <ErrorState error={h.error} onRetry={h.reload} />
      ) : !r ? (
        <Loading label="Loading fire history" />
      ) : (
        <>
          {r.errors?.length ? <Notice kind="warn" title="Some sources were unavailable">{r.errors.join(" · ")}</Notice> : null}
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>
              Burned area by month (MODIS)
            </div>
            {r.months.length ? (
              <BarChart ariaLabel="Burned area per month" data={r.months.map((m) => ({ label: m.month, value: m.burned_ha }))} formatValue={(v) => fmtNum(v)} color="#ff6a2b" />
            ) : (
              <div className="small muted">No MODIS burned area {r.errors?.length ? "available" : "mapped in this period"}.</div>
            )}
          </div>
          <div>
            <div className="section-title">Satellite detections by month (local archive)</div>
            {r.archive.length ? (
              <BarChart ariaLabel="Detections per month" data={r.archive.map((m) => ({ label: m.month, value: m.detections }))} color="#ffb02b" />
            ) : (
              <div className="small muted">No detections recorded inside the asset.</div>
            )}
          </div>
          <div className="tiny muted">Computed {timeAgo(h.data?.created_at)}.</div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Forest loss
export function ForestLossPanel({ asset }: { asset: Asset }) {
  const fl = useAsync(() => assetsApi.forestLoss(asset.id), [asset.id]);
  const r = fl.data?.result;
  const total = (r?.loss_by_year ?? []).reduce((a, x) => a + x.loss_ha, 0);
  return (
    <div className="stack">
      <div className="small muted">Annual tree-cover loss (Hansen / UMD Global Forest Change) and recent integrated deforestation alerts. Source: {fl.data?.source ?? "not connected"}</div>
      {fl.error ? (
        <ErrorState error={fl.error} onRetry={fl.reload} />
      ) : !r ? (
        <Loading />
      ) : r.loss_by_year.length === 0 ? (
        <Notice kind={r.errors?.some((e) => /connect/i.test(e)) ? "info" : "warn"} title="Forest-loss analytics unavailable" action={<ButtonLink size="sm" to="/app/integrations">Integrations</ButtonLink>}>
          {(r.errors ?? ["No tree-cover loss recorded."]).join(" · ")}
        </Notice>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label="Total loss" value={fmtHa(total)} foot={`${r.loss_by_year[0]?.year}–${r.loss_by_year[r.loss_by_year.length - 1]?.year}`} />
            <Tile compact label="Share of asset" value={fmtPct(total / Math.max(1, asset.area_ha), 1)} />
            {r.recent_alerts && <Tile compact label="Recent alerts" value={fmtNum(r.recent_alerts.alerts)} foot={`since ${fmtDate(r.recent_alerts.since)}`} />}
            {r.recent_alerts && <Tile compact label="Alert area" value={fmtHa(r.recent_alerts.area_ha)} />}
          </div>
          <BarChart ariaLabel="Tree-cover loss per year" data={r.loss_by_year.map((x) => ({ label: String(x.year), value: x.loss_ha }))} color="#a1124a" />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Exposure
export function ExposurePanel({ asset }: { asset: Asset }) {
  const [radius, setRadius] = useState(10);
  const ex = useAsync(() => assetsApi.exposure(asset.id, radius), [asset.id, radius]);
  const r = ex.data?.result;
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="small muted">People and infrastructure around the asset from OpenStreetMap (Overpass).</div>
        <Select inputSize="sm" style={{ width: 120 }} value={radius} onChange={(e) => setRadius(+e.target.value)} aria-label="Radius">
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
        <Loading label="Querying OpenStreetMap" />
      ) : r.error ? (
        <Notice kind="warn" title="OpenStreetMap is unavailable right now">
          {r.error}
        </Notice>
      ) : (
        <>
          <div className="grid-4">
            <Tile compact label="Settlements" value={fmtNum(r.settlements)} />
            <Tile compact label="Buildings" value={fmtNum(r.buildings)} />
            <Tile compact label="Road segments" value={fmtNum(r.road_segments)} />
            <Tile compact label="Search radius" value={`${fmtNum((r.radius_m ?? 0) / 1000, 1)} km`} />
          </div>
          {r.places?.length ? (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Place</th>
                    <th>Type</th>
                    <th className="right">Population</th>
                    <th className="right">Coordinates</th>
                  </tr>
                </thead>
                <tbody>
                  {r.places.map((p, i) => (
                    <tr key={`${p.name}-${i}`}>
                      <td>{p.name || <span className="muted">unnamed</span>}</td>
                      <td>{humanize(p.place)}</td>
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
            <div className="small muted">No named places within the radius.</div>
          )}
        </>
      )}
    </div>
  );
}
