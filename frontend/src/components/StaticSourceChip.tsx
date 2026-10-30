import type { StaticSource } from "../api/types";
import { useT } from "../i18n";
import { staticLabel, staticTooltip } from "../lib/staticSources";

/** Small chip marking an incident as a probable static heat source (name and distance in the tooltip). */
export function StaticSourceChip({ source }: { source: StaticSource }) {
  useT();
  const tip = staticTooltip(source);
  return (
    <span className={`chip static-chip static-${source.type}`} title={tip} aria-label={tip}>
      {staticLabel(source.type)}
    </span>
  );
}
