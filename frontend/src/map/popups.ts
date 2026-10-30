/* Popup HTML for map features (escaped, translated). */
import { t } from "../i18n";
import { CONFIDENCE_LABELS } from "../lib/constants";
import { fmtDateTime, fmtNum } from "../lib/format";
import { staticLabel } from "../lib/staticSources";
import { esc } from "./utils";

export function detectionPopup(p: Record<string, unknown>, lon: number, lat: number, extra = ""): string {
  const conf = CONFIDENCE_LABELS[String(p.confidence)] ?? String(p.confidence ?? "");
  const ss = p.static_source && p.static_source !== "null" ? `<br><span style="color:#8b93a7">⚠ ${esc(staticLabel(String(p.static_source)))}</span>` : "";
  return (
    `<b>${esc(p.source)}</b> ${esc(p.satellite ?? "")}<br>${esc(fmtDateTime(String(p.acq_time)))}<br>` +
    `${esc(t("popup.frpConf", { frp: fmtNum(Number(p.frp), 1), conf }))}${ss}${extra}<br>` +
    `<span style="font-family:var(--mono)">${lat.toFixed(4)}, ${lon.toFixed(4)}</span>`
  );
}
