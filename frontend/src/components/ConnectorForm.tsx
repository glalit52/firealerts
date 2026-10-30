/* Connector configuration form rendered dynamically from meta.connector_types[type].fields. */
import { useState } from "react";
import type { Connector, ConnectorType } from "../api/types";
import { hasStoredSecret, initialValues, toConfig, validateConnector } from "../lib/connectorForm";
import type { FormValues } from "../lib/connectorForm";
import { Button, Field, Input, Switch } from "./ui";
import { useT } from "../i18n";

export interface ConnectorFormResult {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export function ConnectorForm({ spec, existing, onSubmit, onCancel, busy }: { spec: ConnectorType; existing?: Connector; onSubmit: (r: ConnectorFormResult) => void; onCancel: () => void; busy?: boolean }) {
  const { t } = useT();
  const [name, setName] = useState(existing?.name ?? spec.label);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [values, setValues] = useState<FormValues>(() => initialValues(spec.fields, existing?.config));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: string, v: string | boolean) => setValues((x) => ({ ...x, [k]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateConnector(spec.fields, values, { name, storedConfig: existing?.config });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSubmit({ name: name.trim(), config: toConfig(spec.fields, values), enabled });
  };

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <p className="small muted">{spec.description}</p>
      <Input label={t("common.name")} required value={name} onChange={(e) => setName(e.target.value)} error={errors.__name} maxLength={120} hint={t("cform.nameHint")} />
      {spec.fields.length === 0 && <p className="small muted">{t("cform.noFields")}</p>}
      {spec.fields.map((f) => {
        const id = `cf-${f.key}`;
        const stored = hasStoredSecret(f, existing?.config);
        const hint = [f.help, stored ? t("cform.stored") : "", f.type === "list" ? t("cform.list") : ""].filter(Boolean).join(" ");
        if (f.type === "bool")
          return (
            <div key={f.key}>
              <Switch id={id} checked={Boolean(values[f.key])} onChange={(v) => set(f.key, v)} label={f.label} />
              {f.help && <div className="tiny muted mt-4">{f.help}</div>}
            </div>
          );
        if (f.type === "textarea" || f.type === "list")
          return (
            <Field key={f.key} label={f.label} required={f.required && !stored} htmlFor={id} error={errors[f.key]} hint={hint || undefined}>
              <textarea
                id={id}
                className="textarea mono"
                rows={f.type === "textarea" ? 6 : 2}
                value={String(values[f.key] ?? "")}
                placeholder={stored ? t("cform.storedPh") : f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
                aria-invalid={errors[f.key] ? true : undefined}
                spellCheck={false}
                style={{ fontSize: 12.5 }}
              />
            </Field>
          );
        return (
          <Input
            key={f.key}
            id={id}
            label={f.label}
            required={f.required && !stored}
            type={f.type === "password" ? "password" : f.type === "url" ? "url" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            value={String(values[f.key] ?? "")}
            placeholder={stored ? t("cform.storedPh") : f.placeholder}
            onChange={(e) => set(f.key, e.target.value)}
            error={errors[f.key]}
            hint={hint || undefined}
            spellCheck={false}
          />
        );
      })}
      <Switch checked={enabled} onChange={setEnabled} label={t("common.enabled")} />
      <div className="row end">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" loading={busy}>
          {existing ? t("common.saveChanges") : t("cform.add")}
        </Button>
      </div>
    </form>
  );
}
