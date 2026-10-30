/* Dynamic connector forms: values, validation and conversion to the API config. */

import type { ConnectorField } from "../api/types";
import { t } from "../i18n";

export const SECRET_MARKER = "••••••";

export type FormValues = Record<string, string | boolean>;

/** Initial form values from a field list and (optionally) a stored, redacted config. */
export function initialValues(fields: ConnectorField[], config?: Record<string, unknown>): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = config?.[f.key];
    if (f.type === "bool") out[f.key] = Boolean(v);
    else if (f.secret) out[f.key] = ""; // never prefill secrets; blank means "keep"
    else if (Array.isArray(v)) out[f.key] = v.join(", ");
    else out[f.key] = v == null ? "" : String(v);
  }
  return out;
}

/** Whether a secret is already stored for this field (the API returns the redaction marker). */
export function hasStoredSecret(field: ConnectorField, config?: Record<string, unknown>): boolean {
  return Boolean(field.secret && config && config[field.key] === SECRET_MARKER);
}

export function splitList(v: string): string[] {
  return v
    .split(/[\n,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validate form values. Returns a map of field key → error message (empty when valid). */
export function validateConnector(
  fields: ConnectorField[],
  values: FormValues,
  opts: { name?: string; storedConfig?: Record<string, unknown> } = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (opts.name !== undefined && !opts.name.trim()) errors.__name = t("cform.errName");
  for (const f of fields) {
    const raw = values[f.key];
    if (f.type === "bool") continue;
    const v = typeof raw === "string" ? raw.trim() : "";
    const kept = !v && hasStoredSecret(f, opts.storedConfig);
    if (f.required && !v && !kept) {
      errors[f.key] = t("cform.errRequired", { label: f.label });
      continue;
    }
    if (!v || v === SECRET_MARKER) continue;
    if (f.type === "url" && !isUrl(v)) errors[f.key] = t("cform.errUrl");
    if (f.type === "list") {
      const items = splitList(v);
      if (f.required && !items.length) errors[f.key] = t("cform.errList", { label: f.label });
      if (/recipient|email/i.test(f.key)) {
        const bad = items.filter((x) => !EMAIL_RE.test(x));
        if (bad.length) errors[f.key] = t("cform.errEmail", { list: bad.join(", ") });
      }
    }
    if (f.type === "textarea" && /json/i.test(f.key)) {
      try {
        JSON.parse(v);
      } catch {
        errors[f.key] = t("cform.errJson");
      }
    }
  }
  return errors;
}

/** Convert form values to the `config` object the API expects. Blank secrets are omitted so the stored value is kept. */
export function toConfig(fields: ConnectorField[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.key];
    if (f.type === "bool") {
      out[f.key] = Boolean(raw);
      continue;
    }
    const v = typeof raw === "string" ? raw.trim() : "";
    if (f.secret && (!v || v === SECRET_MARKER)) continue;
    if (f.type === "list") out[f.key] = splitList(v);
    else out[f.key] = v;
  }
  return out;
}
