import type { IngestRun } from "../api/types";
import { t } from "../i18n";

/** Toast text after a manual satellite sync. */
export function syncMessage(r: IngestRun, withFetched = false): string {
  const base = withFetched ? t("sync.doneFetched", { fetched: r.fetched, count: r.inserted }) : t("sync.done", { count: r.inserted });
  return r.alerts ? `${base} ${t("sync.alerts", { count: r.alerts })}` : base;
}
