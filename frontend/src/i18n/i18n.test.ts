import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import { es } from "./es";
import { pt } from "./pt";
import { detectLocale, formatNumber, getLocale, hasKey, interpolate, normalizeLocale, setLocale, t, tEnum, translate } from ".";
import { compass, fmtNum, fmtPct, timeAgo } from "../lib/format";
import { DANGER } from "../lib/constants";

afterEach(() => setLocale("en"));

describe("dictionaries", () => {
  it("have identical keys and plural shapes (runtime double-check of the type)", () => {
    const keys = Object.keys(en).sort();
    for (const d of [es, pt]) {
      expect(Object.keys(d).sort()).toEqual(keys);
      for (const k of keys) expect(typeof (d as Record<string, unknown>)[k]).toBe(typeof (en as Record<string, unknown>)[k]);
    }
  });
  it("keep every {placeholder} in translations", () => {
    for (const [k, v] of Object.entries(en)) {
      const ph = (s: unknown) => JSON.stringify(s).match(/\{\w+\}/g)?.sort().join() ?? "";
      for (const d of [es, pt]) expect(ph((d as Record<string, unknown>)[k]), k).toBe(ph(v));
    }
  });
  it("translate fire terms naturally", () => {
    expect(translate("es", "landing.f3.title")).toContain("Índice de peligro de incendio");
    expect(translate("pt", "landing.f3.title")).toContain("Índice de perigo de incêndio");
    expect(translate("pt", "burn.burned")).toBe("Área queimada");
    expect(translate("es", "burn.burned")).toBe("Área quemada");
  });
});

describe("t()", () => {
  it("interpolates {name} params and leaves unknown ones", () => {
    expect(t("overview.welcome", { name: "Ana" })).toBe("Welcome back, Ana");
    expect(interpolate("Hi {who} {missing}", { who: "you" })).toBe("Hi you {missing}");
    expect(translate("es", "overview.welcome", { name: "Ana" })).toBe("Hola de nuevo, Ana");
  });
  it("formats numeric params for the locale", () => {
    expect(translate("en", "overview.ofPlan", { n: 1234 })).toBe("of 1,234 on your plan");
    expect(translate("pt", "overview.ofPlan", { n: 1234 })).toBe("de 1.234 no seu plano");
  });
  it("picks plural forms", () => {
    expect(t("upload.created", { count: 1 })).toBe("1 asset created");
    expect(t("upload.created", { count: 3 })).toBe("3 assets created");
    expect(t("upload.created", { count: 0 })).toBe("0 assets created");
    expect(translate("es", "upload.created", { count: 1 })).toBe("1 activo creado");
    expect(translate("es", "upload.created", { count: 2 })).toBe("2 activos creados");
    expect(translate("pt", "alerts.count", { count: 1000000 })).toBe("1.000.000 alertas");
  });
  it("tEnum falls back to a humanised value", () => {
    expect(tEnum("kind", "protected_area")).toBe("Protected area");
    expect(tEnum("kind", "orchard_block")).toBe("Orchard block");
    expect(hasKey("kind.forest")).toBe(true);
    expect(hasKey("nope.nope")).toBe(false);
  });
});

describe("locale detection", () => {
  it("normalises tags", () => {
    expect(normalizeLocale("es-AR")).toBe("es");
    expect(normalizeLocale("pt_BR")).toBe("pt");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
  it("prefers user, then stored, then navigator, then English", () => {
    expect(detectLocale({ user: "pt", stored: "es", navigator: ["en-US"] })).toBe("pt");
    expect(detectLocale({ user: null, stored: "es", navigator: ["pt-BR"] })).toBe("es");
    expect(detectLocale({ stored: "xx", navigator: ["fr-FR", "pt-BR", "es"] })).toBe("pt");
    expect(detectLocale({ navigator: "es-MX" })).toBe("es");
    expect(detectLocale({ navigator: ["de-DE"] })).toBe("en");
    expect(detectLocale({})).toBe("en");
  });
});

describe("locale-aware formatting", () => {
  it("switches number, relative time, compass and domain labels", () => {
    setLocale("pt");
    expect(getLocale()).toBe("pt");
    expect(fmtNum(1234.5, 1)).toBe("1.234,5");
    expect(fmtPct(0.685, 1)).toBe("68,5%");
    expect(timeAgo("2026-10-29T11:15:00Z", Date.parse("2026-10-29T12:00:00Z"))).toBe("há 45 min");
    expect(compass(267)).toBe("O");
    expect(DANGER.very_high.label).toBe("Muito alto");
    setLocale("es");
    expect(timeAgo("2026-10-29T06:00:00Z", Date.parse("2026-10-29T12:00:00Z"))).toBe("hace 6 h");
    expect(DANGER.extreme.label).toBe("Extremo");
    expect(formatNumber(1234.5, { maximumFractionDigits: 1 })).toBe("1,234.5");
    setLocale("en");
    expect(fmtNum(1234.567, 1)).toBe("1,234.6");
    expect(compass(90)).toBe("E");
  });
});
