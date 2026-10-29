import type { Danger, Severity } from "../api/types";

export const SEVERITY_COLORS: Record<Severity, string> = {
  info: "#5aa9ff",
  low: "#3ecf8e",
  moderate: "#ffd84d",
  high: "#ff9a3c",
  critical: "#ff4d5e",
};

export const SEVERITY_ORDER: Severity[] = ["info", "low", "moderate", "high", "critical"];

export const DANGER: Record<Danger, { label: string; color: string }> = {
  very_low: { label: "Very low", color: "#3ecf8e" },
  low: { label: "Low", color: "#9be15d" },
  moderate: { label: "Moderate", color: "#ffd84d" },
  high: { label: "High", color: "#ff9a3c" },
  very_high: { label: "Very high", color: "#ff4d4d" },
  extreme: { label: "Extreme", color: "#a1124a" },
};

export function dangerInfo(d: string | null | undefined) {
  return (d && DANGER[d as Danger]) || { label: d ? d.replace(/_/g, " ") : "–", color: "#8b93a7" };
}

export const HORIZON_COLORS: Record<number, string> = { 1: "#fff3b0", 3: "#ffd166", 6: "#ff9f43", 12: "#ff6a2b", 24: "#e0244a", 48: "#a1124a", 72: "#6a0d47" };

export const FUEL_COLORS: Record<string, string> = {
  C1: "#5e8c5a", C2: "#225a32", C3: "#2e6e3c", C4: "#3c7846", C5: "#508250", C6: "#467d4b", C7: "#6e8c46",
  D1: "#82aa5a", S1: "#be9646", O1a: "#e1d26e", O1b: "#f0be5a", "non-fuel": "#283c78",
};

export const PROB_BANDS: [number, string, string][] = [
  [0.01, "#3ecf8e", "<1%"],
  [0.05, "#ffd84d", "1–5%"],
  [0.15, "#ff9a3c", "5–15%"],
  [0.3, "#ff4d4d", "15–30%"],
  [Infinity, "#a1124a", ">30%"],
];
export const probColor = (p: number) => (PROB_BANDS.find(([u]) => p < u) ?? PROB_BANDS[PROB_BANDS.length - 1])[1];

export const AGE_COLORS = ["#fff3b0", "#ffb02b", "#ff6a2b", "#b3263b"];

export const CONFIDENCE_LABELS: Record<string, string> = { l: "Low", n: "Nominal", h: "High" };

export const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

export function prioColor(p: number): [string, string] {
  if (p >= 80) return ["#ff4d5e", "rgba(255,77,94,.15)"];
  if (p >= 60) return ["#ff9a3c", "rgba(255,154,60,.15)"];
  if (p >= 40) return ["#ffd84d", "rgba(255,216,77,.12)"];
  return ["#8b93a7", "rgba(139,147,167,.12)"];
}

export const isGeoSource = (src: string) => /^(GOES|HIMAWARI|METEOSAT)/.test(src);

export const SENSOR_GROUPS: { id: string; label: string; match: (s: string) => boolean }[] = [
  { id: "viirs", label: "VIIRS 375 m", match: (s) => s.startsWith("VIIRS") },
  { id: "modis", label: "MODIS 1 km", match: (s) => s.startsWith("MODIS") },
  { id: "geo", label: "Geostationary", match: isGeoSource },
];

export const TIMEZONES = [
  "UTC", "America/Argentina/Cordoba", "America/Sao_Paulo", "America/Asuncion", "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "America/Vancouver", "America/Edmonton", "America/Mexico_City", "America/Santiago", "America/Bogota", "Europe/Lisbon", "Europe/Madrid",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Athens", "Africa/Johannesburg", "Africa/Gaborone", "Africa/Nairobi", "Asia/Kolkata",
  "Asia/Jakarta", "Asia/Singapore", "Asia/Tokyo", "Australia/Perth", "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland",
];
