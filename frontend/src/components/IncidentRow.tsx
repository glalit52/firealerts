/* One incident row (live map and public map). */
import type { Incident } from "../api/types";
import { tEnum, useT } from "../i18n";
import { isGeoSource, prioColor } from "../lib/constants";
import { fmtHa, fmtKm, fmtNum, timeAgo } from "../lib/format";
import { StaticSourceChip } from "./StaticSourceChip";

/** One row in an incident list (shared by the live map and the public map). */
export function IncidentRow({ inc: i, selected, onClick, readOnly }: { inc: Incident; selected?: boolean; onClick?: () => void; readOnly?: boolean }) {
  const { t } = useT();
  const [c, bg] = prioColor(i.priority);
  const ss = i.static_source;
  const body = (
    <>
      <span className="prio" style={{ color: c, background: bg }}>
        {i.priority}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="inc-title" style={{ display: "block" }}>
          {i.lat.toFixed(3)}, {i.lon.toFixed(3)}
        </span>
        <span className="inc-meta" style={{ display: "block" }}>
          {i.count} px · {fmtHa(i.area_ha)} · {i.status === "active" ? t("live.seen", { ago: timeAgo(i.last_seen) }) : tEnum("incStatus", i.status)}
        </span>
        <span className="row wrap" style={{ gap: 3, marginTop: 3 }}>
          {ss && <StaticSourceChip source={ss} />}
          {i.sources.slice(0, 3).map((s) => (
            <span key={s} className={`chip ${isGeoSource(s) ? "geo" : ""}`}>
              {s.replace("VIIRS_", "")}
            </span>
          ))}
        </span>
        {ss && <span className="tiny faint" style={{ display: "block", marginTop: 2 }}>{ss.name ? `${ss.name} · ` : ""}{fmtKm(ss.distance_km)}</span>}
      </span>
      <span className="inc-right">
        <b>{fmtNum(i.frp_sum)}</b>MW FRP
      </span>
    </>
  );
  const cls = `inc ${selected ? "sel" : ""} ${ss ? "static" : ""} ${readOnly ? "readonly" : ""}`;
  if (readOnly && !onClick)
    return (
      <div role="listitem" className={cls}>
        {body}
      </div>
    );
  return (
    <button role="listitem" className={cls} onClick={onClick}>
      {body}
    </button>
  );
}
