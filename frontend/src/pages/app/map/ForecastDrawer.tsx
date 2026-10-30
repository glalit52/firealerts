/* Incident / what-if spread forecast drawer: fetches the forecast and draws it on the map. */
import maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { fire } from "../../../api/endpoints";
import type { ForecastParams } from "../../../api/endpoints";
import type { Forecast, Fuel, Incident } from "../../../api/types";
import { DangerStrip, HourlyChart } from "../../../components/charts";
import { Button, Checkbox, Drawer, Notice, Select, Tile } from "../../../components/ui";
import { FUEL_COLORS, HORIZON_COLORS, dangerInfo, isGeoSource } from "../../../lib/constants";
import { compass, fmtDateTime, fmtNum, timeAgo } from "../../../lib/format";
import { flatCoords } from "../../../lib/geo";
import { EMPTY_FC, removeImage, setData, setImage, setVisible } from "../../../map/utils";

export type ForecastTarget = { kind: "incident"; inc: Incident } | { kind: "whatif"; lat: number; lon: number };

const IMAGES = { arrival: 0.85, burn: 0.9, fuel: 0.75 } as const;
type ImgName = keyof typeof IMAGES;

export function clearForecast(map: MlMap | null) {
  if (!map) return;
  for (const s of ["fc-perims", "fc-seed", "fc-burn"]) setData(map, s, EMPTY_FC);
  for (const n of Object.keys(IMAGES)) removeImage(map, `fc-img-${n}`);
}

function FuelBar({ mix, fuels }: { mix: Record<string, number>; fuels: Fuel[] }) {
  const entries = Object.entries(mix).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const name = (c: string) => fuels.find((f) => f.code === c)?.name ?? (c === "non-fuel" ? "Water, built-up, bare" : c);
  return (
    <>
      <div className="fuelbar">
        {entries.map(([c, v]) => (
          <i key={c} style={{ width: `${v}%`, background: FUEL_COLORS[c] ?? "#888" }} title={`${c} ${v}%`} />
        ))}
      </div>
      <div className="legend">
        {entries.map(([c, v]) => (
          <span key={c}>
            <i style={{ background: FUEL_COLORS[c] ?? "#888" }} />
            {c} {name(c)} {fmtNum(v)}%
          </span>
        ))}
      </div>
    </>
  );
}

export function ForecastDrawer({ map, target, fuels, onClose }: { map: MlMap; target: ForecastTarget; fuels: Fuel[]; onClose: () => void }) {
  const [opts, setOpts] = useState<Required<Pick<ForecastParams, "fuel" | "model" | "hours" | "curing">>>({ fuel: "auto", model: "auto", hours: 24, curing: 85 });
  const [draft, setDraft] = useState(opts);
  const [fc, setFc] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState({ p90: true, burn: false, arrival: true, fuel: false });
  const abort = useRef<AbortController | null>(null);

  const lat = target.kind === "incident" ? target.inc.lat : target.lat;
  const lon = target.kind === "incident" ? target.inc.lon : target.lon;
  const key = target.kind === "incident" ? target.inc.id : `${lat},${lon}`;

  useEffect(() => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    setError(null);
    const p = target.kind === "incident" ? fire.incidentForecast(target.inc.id, opts, ac.signal) : fire.spread(lat, lon, opts, ac.signal);
    p.then((r) => {
      if (ac.signal.aborted) return;
      setFc(r);
      draw(r);
    })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, opts]);

  useEffect(() => () => clearForecast(map), [map]);

  function draw(r: Forecast) {
    const feats = r.perimeters.features
      .map((f) => ({ ...f, properties: { ...f.properties, color: HORIZON_COLORS[f.properties.horizon_h] ?? "#ff6a2b" } }))
      .sort((a, b) => b.properties.horizon_h - a.properties.horizon_h);
    setData(map, "fc-perims", { type: "FeatureCollection", features: feats });
    setData(map, "fc-seed", { type: "FeatureCollection", features: [r.seed] });
    setData(map, "fc-burn", r.burn_probability);
    if (r.images) {
      for (const [name, opacity] of Object.entries(IMAGES) as [ImgName, number][]) {
        setImage(map, `fc-img-${name}`, r.images[name], r.images.coordinates, { opacity, before: "fc-perims-p90", visible: name === "arrival" ? show.arrival : name === "fuel" ? show.fuel : show.burn });
      }
    } else for (const n of Object.keys(IMAGES)) removeImage(map, `fc-img-${n}`);
    const outer = feats.find((f) => f.properties.kind === "p90");
    const pts = outer ? flatCoords(outer.geometry) : [];
    if (pts.length) {
      const b = new maplibregl.LngLatBounds();
      pts.forEach((c) => b.extend(c));
      const wide = map.getContainer().clientWidth > 900;
      map.fitBounds(b, { padding: wide ? { top: 70, bottom: 60, left: 60, right: 480 } : 30, maxZoom: 13, duration: 800 });
    }
  }

  useEffect(() => {
    setVisible(map, "fc-perims-p90", show.p90);
    const raster = fc?.model === "raster" && !!fc.images;
    setVisible(map, "fc-burn-fill", show.burn && !raster);
    setVisible(map, "fc-img-burn", show.burn && raster);
    setVisible(map, "fc-img-arrival", show.arrival);
    setVisible(map, "fc-img-fuel", show.fuel);
  }, [show, fc, map]);

  const inc = target.kind === "incident" ? (fc?.incident ?? target.inc) : null;
  const title = target.kind === "incident" ? "Fire incident" : "What-if ignition";
  const raster = fc?.model === "raster";
  const last = fc?.stats[fc.stats.length - 1];
  const maxHfi = fc ? Math.max(...fc.hourly.map((h) => h.intensity_kw_m)) : 0;
  const today = fc ? (fc.danger.find((d) => d.forecast) ?? fc.danger[fc.danger.length - 1]) : null;
  const hasGrass = fc ? (raster ? Object.keys(fc.fuel_mix ?? {}).some((c) => c.startsWith("O1")) : fc.fuel.code.startsWith("O1")) : false;

  return (
    <Drawer
      title={title}
      onClose={onClose}
      subtitle={
        <span className="mono">
          {lat.toFixed(4)}, {lon.toFixed(4)}
        </span>
      }
    >
      {inc && (
        <div className="small muted mb-8">
          First seen {fmtDateTime(inc.first_seen)} · last {timeAgo(inc.last_seen)}
          <div className="row wrap mt-4" style={{ gap: 4 }}>
            {inc.sources.map((s) => (
              <span key={s} className={`chip ${isGeoSource(s) ? "geo" : ""}`}>
                {s.replace("VIIRS_", "")}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="forecast-controls">
        <Select label="Fuel" inputSize="sm" value={draft.fuel} onChange={(e) => setDraft({ ...draft, fuel: e.target.value })}>
          <option value="auto">{raster ? "Land cover (auto)" : `Auto${fc && !raster ? ` (${fc.fuel.code})` : ""}`}</option>
          {fuels.map((f) => (
            <option key={f.code} value={f.code}>
              {f.code} · {f.name}
            </option>
          ))}
        </Select>
        <Select label="Model" inputSize="sm" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value as "auto" | "raster" | "uniform" })}>
          <option value="auto">Auto</option>
          <option value="raster">Terrain</option>
          <option value="uniform">Uniform</option>
        </Select>
        <Select label="Horizon" inputSize="sm" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: +e.target.value })}>
          {[12, 24, 48, 72].map((h) => (
            <option key={h} value={h}>
              {h} h
            </option>
          ))}
        </Select>
      </div>
      {hasGrass && (
        <label className="row small muted mt-8" style={{ gap: 10 }}>
          Grass curing
          <input type="range" min={0} max={100} value={draft.curing} onChange={(e) => setDraft({ ...draft, curing: +e.target.value })} aria-label="Grass curing percent" />
          <span className="mono">{draft.curing}%</span>
        </label>
      )}
      <Button className="mt-8" size="sm" variant="primary" block loading={loading} disabled={loading} onClick={() => setOpts({ ...draft })}>
        {loading ? `Running ${opts.hours} h ${opts.model === "uniform" ? "" : "terrain-aware "}ensemble…` : "Re-run forecast"}
      </Button>
      {loading && !fc && <div className="progress-indeterminate mt-12" />}
      {error && (
        <div className="mt-12">
          <Notice kind="bad" title="Forecast failed">
            {error}
          </Notice>
        </div>
      )}

      {fc && last && today && (
        <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity .15s" }}>
          <div className="tiles mt-12">
            {inc && <Tile compact label="Priority" value={inc.priority} />}
            {inc && <Tile compact label="Fire pixels" value={fmtNum(inc.count)} />}
            {inc && <Tile compact label="FRP MW" value={fmtNum(inc.frp_sum)} />}
            <Tile compact label="Area now ha" value={fmtNum(fc.seed.properties.area_ha)} />
            <Tile compact label={`P50 +${last.horizon_h} h ha`} value={fmtNum(last.area_ha_p50)} />
            <Tile compact label="Peak HFI MW/m" value={fmtNum(maxHfi / 1000, 1)} />
          </div>

          <div className="section-title">Weather now</div>
          <div className="tiles">
            <Tile compact label="Temp" value={`${fmtNum(fc.current.temp, 1)}°`} />
            <Tile compact label="Rel. humidity" value={`${fmtNum(fc.current.rh)}%`} />
            <Tile compact label="Wind km/h" value={<>{fmtNum(fc.current.wind)} <small>{compass(fc.current.wind_dir)}</small></>} />
            <Tile compact label="FFMC" value={fmtNum(fc.current.ffmc, 1)} />
            <Tile compact label="ISI" value={fmtNum(fc.current.isi, 1)} />
            <Tile compact label={`FWI · ${dangerInfo(today.danger).label}`} value={<span style={{ color: dangerInfo(today.danger).color }}>{fmtNum(today.fwi)}</span>} />
          </div>

          <div className="section-title">
            Spread · {fc.members}-member ensemble <span className={`chip ${raster ? "geo" : ""}`}>{raster ? `terrain-aware · ${fc.terrain?.cell_m} m` : "uniform fuel"}</span>
          </div>
          {fc.model_note && <div className="note mb-8">{fc.model_note}</div>}
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Horizon</th>
                  <th>Local time</th>
                  <th className="right">P10 ha</th>
                  <th className="right">P50 ha</th>
                  <th className="right">P90 ha</th>
                  <th className="right">Run km</th>
                </tr>
              </thead>
              <tbody>
                {fc.stats.map((s) => (
                  <tr key={s.horizon_h}>
                    <td className="nowrap">
                      <span className="swatch" style={{ background: HORIZON_COLORS[s.horizon_h] }} />+{s.horizon_h} h
                    </td>
                    <td className="nowrap">{new Date(s.time).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="right">{fmtNum(s.area_ha_p10)}</td>
                    <td className="right">
                      <b>{fmtNum(s.area_ha_p50)}</b>
                    </td>
                    <td className="right">{fmtNum(s.area_ha_p90)}</td>
                    <td className="right">{fmtNum(s.max_run_km, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="stack tight mt-12">
            <Checkbox checked={show.p90} onChange={(v) => setShow({ ...show, p90: v })} label="P90 envelope (dashed)" />
            <Checkbox checked={show.burn} onChange={(v) => setShow({ ...show, burn: v })} label={`Burn probability at +${last.horizon_h} h`} />
            {raster && fc.images && (
              <>
                <Checkbox checked={show.arrival} onChange={(v) => setShow({ ...show, arrival: v })} label="Arrival time (P50)" />
                <Checkbox checked={show.fuel} onChange={(v) => setShow({ ...show, fuel: v })} label="Fuel map" />
              </>
            )}
          </div>

          {raster && fc.terrain && (
            <>
              <div className="section-title">Terrain &amp; fuels</div>
              <div className="tiles">
                <Tile compact label="Elevation m" value={`${fmtNum(fc.terrain.elevation_m[0])}–${fmtNum(fc.terrain.elevation_m[1])}`} />
                <Tile compact label="Slope P90" value={`${fmtNum(fc.terrain.slope_pct_p90)}%`} />
                <Tile compact label="Domain" value={`${fmtNum(fc.terrain.size_km)} km`} />
              </div>
              {fc.fuel_mix && <FuelBar mix={fc.fuel_mix} fuels={fuels} />}
              <div className="tiny muted mt-4">
                {fc.terrain.source}
                {fc.domain_limited && <b> · fire reaches the domain edge: areas are a lower bound</b>}
              </div>
            </>
          )}

          <div className="section-title">Hourly behaviour</div>
          <HourlyChart hourly={fc.hourly} />
          <div className="section-title">Fire danger outlook</div>
          <DangerStrip days={fc.danger} />
          <div className="note mt-16">
            Fuel <b>{fc.fuel.code}</b> ({fc.fuel.name}). Moisture codes FFMC {fc.fwi_state.ffmc} · DMC {fc.fwi_state.dmc} · DC {fc.fwi_state.dc} · BUI {fc.fwi_state.bui}. Weather:{" "}
            {fc.weather_source === "demo" ? "synthetic (offline demo)" : "Open-Meteo"}.{" "}
            {raster
              ? "Canadian FBP rate of spread per cell with slope-equivalent wind, fuels from ESA WorldCover, non-fuel cells as barriers, arrival time by ordered-upwind minimum travel time."
              : "Canadian FBP rate of spread with exact Huygens elliptical growth over a single fuel; terrain and barriers are ignored."}{" "}
            The ensemble perturbs wind speed, direction and ROS. Suppression is not modelled — decision support, not ground truth.
          </div>
        </div>
      )}
    </Drawer>
  );
}
