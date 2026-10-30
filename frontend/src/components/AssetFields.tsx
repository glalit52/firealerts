/* Shared asset settings fields (create + edit). */
import type { Asset, AssetPatch, Confidence, Danger } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { DANGER } from "../lib/constants";
import { tEnum, useT } from "../i18n";
import { Input, Select, Switch, Textarea } from "./ui";

export interface AssetFormValues {
  name: string;
  kind: string;
  description: string;
  tags: string;
  buffer_km: number;
  min_confidence: Confidence;
  threat_radius_km: number;
  risk_alerts: boolean;
  risk_min_danger: Danger;
}

export const defaultAssetValues = (bufferKm = 2): AssetFormValues => ({
  name: "",
  kind: "forest",
  description: "",
  tags: "",
  buffer_km: bufferKm,
  min_confidence: "n",
  threat_radius_km: 30,
  risk_alerts: true,
  risk_min_danger: "high",
});

export function valuesFromAsset(a: Asset): AssetFormValues {
  return {
    name: a.name,
    kind: a.kind,
    description: a.description ?? "",
    tags: (a.tags ?? []).join(", "),
    buffer_km: a.buffer_km,
    min_confidence: a.min_confidence,
    threat_radius_km: a.threat_radius_km,
    risk_alerts: a.risk_alerts,
    risk_min_danger: a.risk_min_danger,
  };
}

export function valuesToPayload(v: AssetFormValues): AssetPatch {
  return {
    name: v.name.trim(),
    kind: v.kind,
    description: v.description,
    tags: v.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    buffer_km: v.buffer_km,
    min_confidence: v.min_confidence,
    threat_radius_km: v.threat_radius_km,
    risk_alerts: v.risk_alerts,
    risk_min_danger: v.risk_min_danger,
  };
}

export function AssetFields({ value, onChange, errors = {}, compact }: { value: AssetFormValues; onChange: (v: AssetFormValues) => void; errors?: Partial<Record<keyof AssetFormValues, string>>; compact?: boolean }) {
  const { meta } = useAuth();
  const { t } = useT();
  const set = <K extends keyof AssetFormValues>(k: K, v: AssetFormValues[K]) => onChange({ ...value, [k]: v });
  const kinds = meta?.asset_kinds ?? ["forest", "plantation", "protected_area", "farm", "grassland", "infrastructure", "community", "other"];
  const dangers = (meta?.danger_classes ?? Object.keys(DANGER)) as Danger[];
  return (
    <div className="form-grid" style={compact ? { gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" } : undefined}>
      <Input fieldClassName="full" label={t("common.name")} required value={value.name} onChange={(e) => set("name", e.target.value)} error={errors.name} placeholder={t("assetForm.namePlaceholder")} maxLength={160} />
      <Select label={t("assets.kind")} value={value.kind} onChange={(e) => set("kind", e.target.value)} options={kinds.map((k) => ({ value: k, label: tEnum("kind", k) }))} />
      <Input label={t("assets.tags")} value={value.tags} onChange={(e) => set("tags", e.target.value)} placeholder={t("assetForm.tagsPlaceholder")} hint={t("assetForm.tagsHint")} />
      {!compact && <Textarea fieldClassName="full" label={t("assetForm.description")} value={value.description} onChange={(e) => set("description", e.target.value)} rows={2} maxLength={5000} />}
      <Input label={t("assetForm.buffer")} type="number" min={0} max={100} step={0.5} value={value.buffer_km} onChange={(e) => set("buffer_km", +e.target.value)} hint={t("assetForm.bufferHint")} />
      <Input label={t("assetForm.threat")} type="number" min={0} max={200} step={1} value={value.threat_radius_km} onChange={(e) => set("threat_radius_km", +e.target.value)} hint={t("assetForm.threatHint")} />
      <Select
        label={t("assetForm.minConfidence")}
        value={value.min_confidence}
        onChange={(e) => set("min_confidence", e.target.value as Confidence)}
        options={[
          { value: "l", label: t("assetForm.conf.l") },
          { value: "n", label: t("confidence.n") },
          { value: "h", label: t("assetForm.conf.h") },
        ]}
      />
      <Select label={t("assetForm.riskThreshold")} value={value.risk_min_danger} disabled={!value.risk_alerts} onChange={(e) => set("risk_min_danger", e.target.value as Danger)} options={dangers.map((d) => ({ value: d, label: t("assetForm.orWorse", { danger: DANGER[d]?.label ?? d }) }))} />
      <div className="full">
        <Switch checked={value.risk_alerts} onChange={(v) => set("risk_alerts", v)} label={t("assetForm.riskAlerts")} />
      </div>
    </div>
  );
}
