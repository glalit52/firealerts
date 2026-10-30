/* Fire statistics panel: daily detection counts with FRP, totals and sensor breakdown for a bbox. */
import { useMemo } from "react";
import { fire } from "../api/endpoints";
import type { FireStats } from "../api/types";
import { useT } from "../i18n";
import { fmtCompact, fmtDate, fmtDayMonth, fmtNum } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { BarChart, HBars } from "./charts";
import { ErrorState, Loading, Tile } from "./ui";

/** Keep the daily rows inside [from, to] (YYYY-MM-DD, inclusive) and fill missing days with zeros. */
export function dailyInRange(stats: FireStats, from?: string, to?: string): FireStats["daily"] {
  const by = new Map(stats.daily.map((d) => [d.date, d]));
  const dates = stats.daily.map((d) => d.date).sort();
  const start = from ?? dates[0];
  const end = to ?? dates[dates.length - 1];
  if (!start || !end) return [];
  const out: FireStats["daily"] = [];
  for (let d = new Date(`${start}T12:00:00Z`); d.toISOString().slice(0, 10) <= end && out.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    out.push(by.get(k) ?? { date: k, count: 0, frp: 0 });
  }
  return out;
}

export function FireStatsPanel({ bbox, days, from, to, compact }: { bbox: string; days: number; from?: string; to?: string; compact?: boolean }) {
  const { t } = useT();
  const stats = useAsync(() => fire.stats(bbox, days), [bbox, days]);
  const daily = useMemo(() => (stats.data ? dailyInRange(stats.data, from, to) : []), [stats.data, from, to]);
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  if (!stats.data) return <Loading label={t("stats.loading")} />;
  const total = daily.reduce((a, d) => a + d.count, 0);
  const frp = daily.reduce((a, d) => a + d.frp, 0);
  const peak = daily.reduce<FireStats["daily"][number] | null>((p, d) => (!p || d.count > p.count ? d : p), null);
  const sources = Object.entries(stats.data.by_source).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="stack fire-stats">
      <div className="tiles" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <Tile compact label={t("stats.detections")} value={fmtCompact(total)} />
        <Tile compact label={t("stats.frp")} value={fmtCompact(frp)} unit="MW" />
        <Tile compact label={t("stats.peak")} value={peak && peak.count ? fmtNum(peak.count) : "–"} foot={peak && peak.count ? fmtDayMonth(peak.date) : undefined} />
      </div>
      <div>
        <div className="section-title" style={{ marginTop: 0 }}>
          {t("stats.daily")}
        </div>
        {total === 0 ? (
          <div className="small muted">{t("stats.none")}</div>
        ) : (
          <BarChart
            ariaLabel={t("stats.dailyAria")}
            height={compact ? 120 : 150}
            color="#ff6a2b"
            formatLabel={(l) => fmtDayMonth(l)}
            data={daily.map((d) => ({
              label: d.date,
              value: d.count,
              tooltip: (
                <>
                  <b>{t("stats.tooltip", { count: d.count })}</b> · {fmtDate(d.date)}
                  <br />
                  FRP {fmtNum(d.frp)} MW
                </>
              ),
            }))}
          />
        )}
      </div>
      {sources.length > 0 && (
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            {t("stats.bySensor")}
          </div>
          <HBars rows={sources.map(([k, v]) => ({ label: k.replace(/_/g, " "), value: v, color: /^(GOES|HIMAWARI|METEOSAT)/.test(k) ? "#5aa9ff" : "#ffb02b" }))} />
          <div className="tiny muted mt-4">{t("stats.sensorNote", { days: stats.data.days })}</div>
        </div>
      )}
    </div>
  );
}
