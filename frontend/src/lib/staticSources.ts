/* False-positive filtering: incidents and detections near known static heat sources
 * (volcanoes, gas flares / industry, persistent hot spots) carry `static_source`. */
import type { DetectionCollection, Incident, StaticSource } from "../api/types";
import { fmtNum } from "./format";
import { t, tEnum } from "../i18n";

export const HIDE_STATIC_KEY = "fa_hide_static";

export function isStaticIncident(i: Pick<Incident, "static_source">): boolean {
  return !!i.static_source;
}

/** Drop incidents flagged as static heat sources when `hide` is set. */
export function filterIncidents<T extends Pick<Incident, "static_source">>(items: T[], hide: boolean): T[] {
  return hide ? items.filter((i) => !i.static_source) : items;
}

/** Drop detection features whose `properties.static_source` is set when `hide` is set (returns a new collection). */
export function filterDetections<T extends DetectionCollection>(fc: T, hide: boolean): T {
  if (!hide) return fc;
  return { ...fc, features: fc.features.filter((f) => !f.properties?.static_source) };
}

export function countStatic(items: Pick<Incident, "static_source">[]): number {
  return items.reduce((n, i) => n + (i.static_source ? 1 : 0), 0);
}

export function staticLabel(type: string): string {
  return tEnum("staticSource", type);
}

export function staticTooltip(s: StaticSource): string {
  const params = { type: staticLabel(s.type), name: s.name, km: fmtNum(s.distance_km, s.distance_km < 10 ? 1 : 0) };
  return s.name ? t("staticSource.tooltip", params) : t("staticSource.tooltipNoName", params);
}
