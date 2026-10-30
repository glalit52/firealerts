/* Connector configuration form rendered dynamically from meta.connector_types[type].fields. */
import { useState } from "react";
import type { Connector, ConnectorType } from "../api/types";
import { hasStoredSecret, initialValues, toConfig, validateConnector } from "../lib/connectorForm";
import type { FormValues } from "../lib/connectorForm";
import { Button, Field, Input, Switch } from "./ui";

export interface ConnectorFormResult {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export function ConnectorForm({ spec, existing, onSubmit, onCancel, busy }: { spec: ConnectorType; existing?: Connector; onSubmit: (r: ConnectorFormResult) => void; onCancel: () => void; busy?: boolean }) {
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
      <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} error={errors.__name} maxLength={120} hint="Shown in rules and delivery logs." />
      {spec.fields.map((f) => {
        const id = `cf-${f.key}`;
        const stored = hasStoredSecret(f, existing?.config);
        const hint = [f.help, stored ? "A value is stored. Leave blank to keep it." : "", f.type === "list" ? "Separate multiple entries with commas or new lines." : ""].filter(Boolean).join(" ");
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
                placeholder={stored ? "•••••• (stored)" : f.placeholder}
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
            placeholder={stored ? "•••••• (stored)" : f.placeholder}
            onChange={(e) => set(f.key, e.target.value)}
            error={errors[f.key]}
            hint={hint || undefined}
            spellCheck={false}
          />
        );
      })}
      <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
      <div className="row end">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>
          {existing ? "Save changes" : "Add connection"}
        </Button>
      </div>
    </form>
  );
}
