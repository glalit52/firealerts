/* Small hand-written SVG charts. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DangerDay, HourlyBehaviour, RiskDay } from "../api/types";
import { dangerInfo } from "../lib/constants";
import { compass, fmtDate, fmtDay, fmtNum, fmtPct } from "../lib/format";

/** Measure an element's width (ResizeObserver). */
export function useWidth<T extends HTMLElement>(initial = 600): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(120, el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ------------------------------------------------------------------ Sparkline
export function Sparkline({ values, height = 40, color = "var(--accent)", label }: { values: number[]; height?: number; color?: string; label?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>(200);
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1);
  const y = (v: number) => height - 2 - (v / max) * (height - 6);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${height}L${x(0).toFixed(1)},${height}Z` : "";
  const gid = useMemo(() => `sg${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg className="chart" width={w} height={height} role="img" aria-label={label ?? "Trend"}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.35" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {n > 0 && <path d={area} fill={`url(#${gid})`} />}
        {n > 0 && <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ Bar chart
export interface BarDatum {
  label: string;
  value: number;
  color?: string;
  tooltip?: ReactNode;
}

export function BarChart({ data, height = 160, color = "var(--accent)", formatLabel, formatValue = (v) => fmtNum(v), ariaLabel, everyNthLabel }: { data: BarDatum[]; height?: number; color?: string; formatLabel?: (l: string, i: number) => string; formatValue?: (v: number) => string; ariaLabel: string; everyNthLabel?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const P = { l: 34, r: 8, t: 10, b: 22 };
  const max = Math.max(2, niceMax(Math.max(0, ...data.map((d) => d.value))));
  const n = data.length;
  const iw = w - P.l - P.r;
  const bw = n ? Math.max(2, iw / n - Math.min(6, iw / n / 4)) : 0;
  const x = (i: number) => P.l + (i + 0.5) * (iw / Math.max(1, n));
  const y = (v: number) => height - P.b - (v / max) * (height - P.t - P.b);
  const nth = everyNthLabel ?? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 56))));
  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }} onMouseLeave={() => setHover(null)}>
      <svg className="chart" width={w} height={height} role="img" aria-label={ariaLabel}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid-line" x1={P.l} x2={w - P.r} y1={y(max * f)} y2={y(max * f)} strokeDasharray={f ? "2 3" : undefined} />
            <text x={P.l - 6} y={y(max * f) + 3} textAnchor="end">
              {formatValue(max * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - iw / Math.max(1, n) / 2} y={P.t} width={iw / Math.max(1, n)} height={height - P.t - P.b} fill="transparent" />
            <rect x={x(i) - bw / 2} y={y(d.value)} width={bw} height={Math.max(0, height - P.b - y(d.value))} rx={Math.min(3, bw / 3)} fill={d.color ?? color} opacity={hover == null || hover === i ? 1 : 0.55} />
            {i % nth === 0 && (
              <text x={x(i)} y={height - 6} textAnchor="middle">
                {formatLabel ? formatLabel(d.label, i) : d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {hover != null && data[hover] && (
        <div className="chart-tooltip" style={{ left: x(hover), top: y(data[hover]!.value) }}>
          {data[hover]!.tooltip ?? (
            <>
              <b>{formatValue(data[hover]!.value)}</b> · {data[hover]!.label}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Line chart (dates on x)
export interface Series {
  name: string;
  color: string;
  points: { x: string; y: number | null }[];
  dashed?: boolean;
}

export function LineChart({ series, height = 200, yMin, yMax, formatY = (v) => fmtNum(v, 2), ariaLabel, zeroLine }: { series: Series[]; height?: number; yMin?: number; yMax?: number; formatY?: (v: number) => string; ariaLabel: string; zeroLine?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const P = { l: 40, r: 12, t: 12, b: 24 };
  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort(), [series]);
  const t = (s: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s).getTime();
  const tMin = xs.length ? t(xs[0]!) : 0;
  const tMax = xs.length ? t(xs[xs.length - 1]!) : 1;
  const vals = series.flatMap((s) => s.points.map((p) => p.y).filter((v): v is number => v != null));
  let lo = yMin ?? Math.min(...vals, 0);
  let hi = yMax ?? Math.max(...vals, 0.1);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const x = (s: string) => P.l + (tMax === tMin ? 0.5 : (t(s) - tMin) / (tMax - tMin)) * (w - P.l - P.r);
  const y = (v: number) => height - P.b - ((v - lo) / (hi - lo)) * (height - P.t - P.b);
  const ticks = 4;
  const nLabels = Math.min(xs.length, Math.max(2, Math.floor((w - P.l) / 80)));
  const labelIdx = new Set(Array.from({ length: nLabels }, (_, i) => Math.round((i * (xs.length - 1)) / Math.max(1, nLabels - 1))));

  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0, bd = Infinity;
    xs.forEach((s, i) => {
      const d = Math.abs(x(s) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(xs.length ? best : null);
  };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg className="chart" width={w} height={height} role="img" aria-label={ariaLabel}>
        {Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks).map((v) => (
          <g key={v}>
            <line className="grid-line" x1={P.l} x2={w - P.r} y1={y(v)} y2={y(v)} strokeDasharray="2 3" />
            <text x={P.l - 6} y={y(v) + 3} textAnchor="end">
              {formatY(v)}
            </text>
          </g>
        ))}
        {zeroLine && lo < 0 && hi > 0 && <line x1={P.l} x2={w - P.r} y1={y(0)} y2={y(0)} stroke="var(--line-2)" />}
        {xs.map((s, i) =>
          labelIdx.has(i) ? (
            <text key={s} x={x(s)} y={height - 6} textAnchor="middle">
              {new Date(t(s)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          const pts = s.points.filter((p) => p.y != null).sort((a, b) => t(a.x) - t(b.x));
          const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y!).toFixed(1)}`).join("");
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "4 3" : undefined} strokeLinejoin="round" />
              {pts.length < 40 && pts.map((p) => <circle key={p.x} cx={x(p.x)} cy={y(p.y!)} r={2.5} fill={s.color} />)}
            </g>
          );
        })}
        {hover != null && xs[hover] && <line x1={x(xs[hover]!)} x2={x(xs[hover]!)} y1={P.t} y2={height - P.b} stroke="var(--line-2)" />}
      </svg>
      {hover != null && xs[hover] && (
        <div className="chart-tooltip" style={{ left: Math.min(Math.max(x(xs[hover]!), 70), w - 70), top: P.t + 10, transform: "translate(-50%, 0)" }}>
          <div className="small muted">{fmtDate(xs[hover]!)}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === xs[hover]);
            return p && p.y != null ? (
              <div key={s.name} className="small">
                <span style={{ color: s.color }}>●</span> {s.name} <b>{formatY(p.y)}</b>
              </div>
            ) : null;
          })}
        </div>
      )}
      <div className="legend mt-4">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Fire danger & ignition forecast
export function RiskChart({ days, height = 190 }: { days: RiskDay[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const P = { l: 34, r: 40, t: 12, b: 30 };
  const n = days.length;
  const maxFwi = niceMax(Math.max(30, ...days.map((d) => d.fwi)));
  const iw = w - P.l - P.r;
  const step = iw / Math.max(1, n);
  const bw = Math.max(4, step * 0.62);
  const x = (i: number) => P.l + (i + 0.5) * step;
  const yF = (v: number) => height - P.b - (v / maxFwi) * (height - P.t - P.b);
  const yP = (p: number) => height - P.b - p * (height - P.t - P.b);
  const pLine = days
    .map((d, i) => (d.ignition_p == null ? null : `${x(i).toFixed(1)},${yP(d.ignition_p).toFixed(1)}`))
    .filter(Boolean)
    .map((s, i) => `${i ? "L" : "M"}${s}`)
    .join("");
  return (
    <div ref={ref} style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
      <svg className="chart" width={w} height={height} role="img" aria-label="Fire Weather Index and ignition probability by day">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid-line" x1={P.l} x2={w - P.r} y1={yF(maxFwi * f)} y2={yF(maxFwi * f)} strokeDasharray={f ? "2 3" : undefined} />
            <text x={P.l - 6} y={yF(maxFwi * f) + 3} textAnchor="end">
              {fmtNum(maxFwi * f)}
            </text>
            <text x={w - P.r + 6} y={yP(f) + 3} textAnchor="start" fill="#5aa9ff">
              {fmtPct(f)}
            </text>
          </g>
        ))}
        {days.map((d, i) => (
          <g key={d.date} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - step / 2} y={P.t} width={step} height={height - P.t - P.b} fill="transparent" />
            <rect x={x(i) - bw / 2} y={yF(d.fwi)} width={bw} height={Math.max(1, height - P.b - yF(d.fwi))} rx={3} fill={dangerInfo(d.danger).color} opacity={d.forecast ? 0.95 : 0.5} />
            <text x={x(i)} y={height - 16} textAnchor="middle" fill={d.forecast ? "var(--text-2)" : undefined}>
              {fmtDay(d.date)}
            </text>
            <text x={x(i)} y={height - 4} textAnchor="middle">
              {d.date.slice(8)}
            </text>
          </g>
        ))}
        {pLine && <path d={pLine} fill="none" stroke="#5aa9ff" strokeWidth={2} />}
        {days.map((d, i) => (d.ignition_p == null ? null : <circle key={d.date} cx={x(i)} cy={yP(d.ignition_p)} r={3} fill="#0b0d12" stroke="#5aa9ff" strokeWidth={2} />))}
      </svg>
      {hover != null && days[hover] && (
        <div className="chart-tooltip" style={{ left: x(hover), top: yF(days[hover]!.fwi) }}>
          <div className="small muted">
            {fmtDate(days[hover]!.date)} {days[hover]!.forecast ? "· forecast" : "· observed"}
          </div>
          <div className="small">
            FWI <b>{fmtNum(days[hover]!.fwi, 1)}</b> · {dangerInfo(days[hover]!.danger).label}
          </div>
          <div className="small">
            Ignition probability <b>{fmtPct(days[hover]!.ignition_p, 1)}</b>
          </div>
          {days[hover]!.data?.temp != null && (
            <div className="small muted">
              {fmtNum(Number(days[hover]!.data.temp), 0)}° · RH {fmtNum(Number(days[hover]!.data.rh))}% · wind {fmtNum(Number(days[hover]!.data.wind))} km/h
            </div>
          )}
        </div>
      )}
      <div className="legend mt-4">
        <span>
          <i style={{ background: "linear-gradient(90deg,#3ecf8e,#ffd84d,#ff9a3c,#ff4d4d,#a1124a)" }} />
          FWI (bar colour = danger class; faded = observed)
        </span>
        <span>
          <i style={{ background: "#5aa9ff", borderRadius: 99 }} />
          Ignition probability
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Danger strip
export function DangerStrip({ days, max = 10 }: { days: DangerDay[]; max?: number }) {
  const show = days.slice(-max);
  return (
    <>
      <div className="danger-strip">
        {show.map((d) => {
          const info = dangerInfo(d.danger);
          return (
            <div key={d.date} className={d.forecast ? "" : "past"} style={{ background: info.color, color: d.danger === "extreme" ? "#fff" : "#111" }} title={`${fmtDate(d.date)} · ${info.label} · FWI ${d.fwi} · ${d.temp}° ${d.rh}% ${d.wind} km/h · ${d.rain} mm`}>
              {fmtDay(d.date)}
              <small>{fmtNum(d.fwi)}</small>
            </div>
          );
        })}
      </div>
      <div className="tiny muted mt-4">Faded = observed, solid = forecast. Number = FWI.</div>
    </>
  );
}

// ------------------------------------------------------------------ Hourly fire behaviour
export function HourlyChart({ hourly, height = 140 }: { hourly: HourlyBehaviour[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>(380);
  const P = { l: 30, r: 32, t: 10, b: 18 };
  const n = hourly.length;
  const maxRos = Math.max(1, ...hourly.map((h) => h.ros_m_min));
  const maxWind = Math.max(10, ...hourly.map((h) => h.wind));
  const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (w - P.l - P.r);
  const yR = (v: number) => height - P.b - (v / maxRos) * (height - P.t - P.b);
  const yW = (v: number) => height - P.b - (v / maxWind) * (height - P.t - P.b);
  const bw = Math.max(1, (w - P.l - P.r) / Math.max(1, n) - 1);
  const ros = hourly.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yR(h.ros_m_min).toFixed(1)}`).join("");
  const rh = hourly.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(height - P.b - (h.rh / 100) * (height - P.t - P.b)).toFixed(1)}`).join("");
  const every = n > 36 ? 12 : 6;
  return (
    <div ref={ref}>
      <svg className="chart" width={w} height={height} role="img" aria-label="Hourly rate of spread, wind and humidity">
        {hourly.map((h, i) => (
          <rect key={i} x={x(i) - bw / 2} y={yW(h.wind)} width={bw} height={height - P.b - yW(h.wind)} fill="#2b3446">
            <title>
              {new Date(h.time).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })} · wind {h.wind} km/h {compass(h.wind_dir)} · ROS {h.ros_m_min} m/min · RH {h.rh}%
            </title>
          </rect>
        ))}
        <path d={rh} fill="none" stroke="#5aa9ff" strokeWidth={1.2} strokeDasharray="3 2" />
        <path d={ros} fill="none" stroke="#ff6a2b" strokeWidth={2} />
        <text x={2} y={P.t + 8} fill="#ff6a2b">
          {fmtNum(maxRos)}
        </text>
        <text x={2} y={P.t + 18}>m/min</text>
        <text x={w - 2} y={P.t + 8} textAnchor="end">
          {fmtNum(maxWind)}
        </text>
        <text x={w - 2} y={P.t + 18} textAnchor="end">
          km/h
        </text>
        {hourly.map((h, i) =>
          i % every === 0 ? (
            <text key={i} x={x(i)} y={height - 4} textAnchor="middle">
              {new Date(h.time).toLocaleTimeString("en-GB", { hour: "2-digit" })}h
            </text>
          ) : null,
        )}
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: "#ff6a2b" }} />
          Head ROS
        </span>
        <span>
          <i style={{ background: "#2b3446" }} />
          Wind
        </span>
        <span>
          <i style={{ background: "#5aa9ff" }} />
          Rel. humidity
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Horizontal bars
export function HBars({ rows, format = (v) => fmtNum(v) }: { rows: { label: string; value: number; color?: string; right?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div className="hbar" key={r.label}>
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--accent)" }} />
          </div>
          <span className="num" style={{ textAlign: "right" }}>
            {r.right ?? format(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
