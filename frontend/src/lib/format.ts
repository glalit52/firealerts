/* Formatting helpers. All functions are null-safe and return "–" for missing values. */

export const DASH = "–";

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return DASH;
  return Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** Compact numbers: 1,234 → 1.2k, 2,500,000 → 2.5M. */
export function fmtCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return fmtNum(v, 0);
}

export function fmtHa(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${fmtNum(v, v < 10 ? 1 : 0)} ha`;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtKm(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (v === 0) return "inside";
  return `${fmtNum(v, v < 10 ? 1 : 0)} km`;
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(v: string | number | Date | null | undefined, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return DASH;
  const m = Math.round((now - d.getTime()) / 60000);
  if (m < 0) return "in the future";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 60) return `${days} d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return DASH;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(v: string | number | Date | null | undefined): string {
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : toDate(v);
  if (!d) return DASH;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDay(v: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-GB", { weekday: "short" });
}

export function fmtCoord(lat: number | null | undefined, lon: number | null | undefined, digits = 4): string {
  if (lat == null || lon == null) return DASH;
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return DASH;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** snake_case → "Snake case". */
export function humanize(v: string | null | undefined): string {
  if (!v) return DASH;
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function initials(nameOrEmail: string): string {
  return (
    nameOrEmail
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

/** Hours → "45 min" / "6 h" / "2.5 d". */
export function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return DASH;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${fmtNum(h, h < 10 ? 1 : 0)} h`;
  return `${fmtNum(h / 24, 1)} d`;
}
