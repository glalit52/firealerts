import { describe, expect, it } from "vitest";
import type { DetectionCollection, Incident } from "../api/types";
import { countStatic, filterDetections, filterIncidents, staticLabel, staticTooltip } from "./staticSources";
import { setLocale } from "../i18n";

const inc = (id: string, ss: Incident["static_source"]) => ({ id, static_source: ss }) as Pick<Incident, "id" | "static_source">;

describe("static heat source filtering", () => {
  const items = [inc("a", null), inc("b", { type: "volcano", name: "Villarrica", distance_km: 1.2 }), inc("c", undefined), inc("d", { type: "industrial", name: "", distance_km: 0.4 })];
  it("hides flagged incidents only when asked", () => {
    expect(filterIncidents(items, true).map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterIncidents(items, false)).toHaveLength(4);
    expect(countStatic(items)).toBe(2);
  });
  it("filters detection features by properties.static_source", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: "1", static_source: null } },
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: "2", static_source: "persistent" } },
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: "3" } },
      ],
    } as unknown as DetectionCollection;
    const out = filterDetections(fc, true);
    expect(out.features.map((f) => f.properties.id)).toEqual(["1", "3"]);
    expect(fc.features).toHaveLength(3); // not mutated
    expect(filterDetections(fc, false)).toBe(fc);
  });
  it("labels and tooltips are translated", () => {
    expect(staticLabel("industrial")).toBe("Industrial / gas flare");
    expect(staticTooltip({ type: "volcano", name: "Villarrica", distance_km: 1.24 })).toBe("Volcano: Villarrica · 1.2 km away. Probably not a wildfire.");
    setLocale("es");
    expect(staticLabel("volcano")).toBe("Volcán");
    expect(staticTooltip({ type: "persistent", name: "", distance_km: 12 })).toContain("Fuente de calor persistente · a 12 km");
    setLocale("en");
  });
});
