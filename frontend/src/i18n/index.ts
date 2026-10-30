/* Tiny typed i18n: dictionaries with identical keys (en is the source of truth), {name} interpolation,
 * CLDR plurals via Intl.PluralRules and Intl-based formatting. The current locale is module state so
 * non-component helpers (lib/format, constants) translate too; components subscribe with useT(). */
import { useSyncExternalStore } from "react";
import { en } from "./en";
import type { Messages, Plural } from "./en";
import { es } from "./es";
import { pt } from "./pt";

export type { Messages, Plural };
export type Locale = "en" | "es" | "pt";
export type MsgKey = keyof Messages;
export type Params = Record<string, string | number | null | undefined>;

export const LOCALES: Locale[] = ["en", "es", "pt"];
/** Native names, shown in every language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", es: "Español", pt: "Português (Brasil)" };
export const LOCALE_SHORT: Record<Locale, string> = { en: "EN", es: "ES", pt: "PT" };
/** BCP-47 tags for Intl. English keeps en-US numbers and en-GB dates (the original app's formats). */
export const INTL_TAG: Record<Locale, { num: string; date: string }> = {
  en: { num: "en-US", date: "en-GB" },
  es: { num: "es-419", date: "es-419" },
  pt: { num: "pt-BR", date: "pt-BR" },
};

const DICTS: Record<Locale, Messages> = { en, es, pt };
export const STORAGE_KEY = "fa_lang";

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as string[]).includes(v);
}

/** Map any language tag (es-AR, pt_BR, en-GB …) to a supported locale, or null. */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}

/** Preference order: the signed-in user's language, then the stored choice, then the browser, then English. */
export function detectLocale(opts: { user?: string | null; stored?: string | null; navigator?: readonly string[] | string | null }): Locale {
  const nav = typeof opts.navigator === "string" ? [opts.navigator] : (opts.navigator ?? []);
  return normalizeLocale(opts.user) ?? normalizeLocale(opts.stored) ?? nav.map(normalizeLocale).find((x): x is Locale => !!x) ?? "en";
}

// ------------------------------------------------------------------ locale store
let current: Locale = "en";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = l === "pt" ? "pt-BR" : l;
  listeners.forEach((fn) => fn());
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ------------------------------------------------------------------ translate
const pluralRules = new Map<string, Intl.PluralRules>();
function pluralForm(locale: Locale, n: number): Intl.LDMLPluralRule {
  const tag = INTL_TAG[locale].num;
  let r = pluralRules.get(tag);
  if (!r) pluralRules.set(tag, (r = new Intl.PluralRules(tag)));
  return r.select(n);
}

/** Replace {name} placeholders; numbers are formatted for the locale. Unknown placeholders are left as-is. */
export function interpolate(s: string, params: Params | undefined, locale: Locale = current): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = params[k];
    if (v === undefined || v === null) return m;
    return typeof v === "number" ? formatNumber(v, undefined, locale) : String(v);
  });
}

/** Translate a key. Plural entries need a numeric `count` param (exact "zero" wins for 0 when defined). */
export function translate(locale: Locale, key: MsgKey, params?: Params): string {
  const entry = (DICTS[locale][key] ?? en[key]) as string | Plural | undefined;
  if (entry === undefined) return String(key);
  if (typeof entry === "string") return interpolate(entry, params, locale);
  const n = Number(params?.count ?? 0);
  const form = n === 0 && entry.zero !== undefined ? "zero" : pluralForm(locale, n);
  const text = (entry as unknown as Record<string, string | undefined>)[form] ?? entry.other;
  return interpolate(text, params, locale);
}

export function t(key: MsgKey, params?: Params): string {
  return translate(current, key, params);
}

export function hasKey(key: string): key is MsgKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** Translate `${prefix}.${value}` when such a key exists, else fall back (default: humanised value). */
export function tEnum(prefix: string, value: string | null | undefined, fallback?: (v: string) => string): string {
  if (!value) return "–";
  const k = `${prefix}.${value}`;
  if (hasKey(k)) return t(k);
  if (fallback) return fallback(value);
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ Intl formatting
const numFormats = new Map<string, Intl.NumberFormat>();
export function formatNumber(v: number, opts?: Intl.NumberFormatOptions, locale: Locale = current): string {
  const tag = INTL_TAG[locale].num;
  const key = `${tag}|${JSON.stringify(opts ?? {})}`;
  let f = numFormats.get(key);
  if (!f) numFormats.set(key, (f = new Intl.NumberFormat(tag, opts)));
  return f.format(v);
}

export function formatDate(d: Date, opts: Intl.DateTimeFormatOptions, locale: Locale = current): string {
  return d.toLocaleString(INTL_TAG[locale].date, opts);
}

export function dateTag(locale: Locale = current): string {
  return INTL_TAG[locale].date;
}

// ------------------------------------------------------------------ React
export interface I18n {
  t: (key: MsgKey, params?: Params) => string;
  locale: Locale;
}

/** Subscribe a component to the current locale; returns a bound `t`. */
export function useT(): I18n {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return { locale, t: (key, params) => translate(locale, key, params) };
}
