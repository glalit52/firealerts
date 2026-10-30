import { describe, expect, it } from "vitest";
import { addPoint, drawFeatures, drawResult, emptyDraw, undoPoint } from "../map/draw";
import { areaHa, circlePolygon, cleanVertices, clampBBox, closeRing, expandBBox, haversineKm, isSelfIntersecting, polygonFromVertices } from "./geo";
import type { LngLat } from "./geo";

const square: LngLat[] = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]];

describe("geometry", () => {
  it("haversine distance of 1° latitude ≈ 111 km", () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });
  it("closes rings and removes duplicates", () => {
    expect(cleanVertices([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
    const r = closeRing(square);
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual(r[4]);
  });
  it("computes spherical area (0.1° square at the equator ≈ 12,364 ha)", () => {
    const ha = areaHa({ type: "Polygon", coordinates: [closeRing(square)] });
    expect(ha).toBeGreaterThan(12_200);
    expect(ha).toBeLessThan(12_500);
  });
  it("subtracts holes", () => {
    const hole: LngLat[] = [[0.02, 0.02], [0.04, 0.02], [0.04, 0.04], [0.02, 0.04], [0.02, 0.02]];
    const full = areaHa({ type: "Polygon", coordinates: [closeRing(square)] });
    const holed = areaHa({ type: "Polygon", coordinates: [closeRing(square), hole] });
    expect(full - holed).toBeCloseTo(full * 0.04, -1);
  });
  it("detects self-intersections (bow tie)", () => {
    expect(isSelfIntersecting([[0, 0], [1, 1], [1, 0], [0, 1]])).toBe(true);
    expect(isSelfIntersecting(square)).toBe(false);
  });
  it("validates drawn polygons", () => {
    expect(polygonFromVertices([[0, 0], [1, 1]]).ok).toBe(false);
    const bow = polygonFromVertices([[0, 0], [1, 1], [1, 0], [0, 1]]);
    expect(bow.ok).toBe(false);
    const ok = polygonFromVertices(square);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.polygon.coordinates[0]).toHaveLength(5);
  });
  it("approximates circles", () => {
    const poly = circlePolygon([-64.65, -31.25], 5, 128);
    const ha = areaHa(poly);
    expect(ha / (Math.PI * 25 * 100)).toBeGreaterThan(0.99);
    expect(ha / (Math.PI * 25 * 100)).toBeLessThan(1.01);
  });
  it("expands and clamps bboxes", () => {
    expect(expandBBox([10, 10, 10.5, 10.5])).toEqual([8.75, 9.25, 11.75, 11.25]);
    const c = clampBBox([-100, -60, 100, 60]);
    expect(c[2] - c[0]).toBeLessThanOrEqual(60);
    expect(c[3] - c[1]).toBeLessThanOrEqual(40);
  });
});

describe("draw tool state", () => {
  it("adds and undoes polygon vertices", () => {
    let s = emptyDraw("polygon");
    for (const p of square) s = addPoint(s, p);
    expect(s.vertices).toHaveLength(4);
    expect(drawResult(s).ok).toBe(true);
    s = undoPoint(undoPoint(s));
    expect(s.vertices).toHaveLength(2);
    const r = drawResult(s);
    expect(r.ok).toBe(false);
  });
  it("draws a circle from centre + edge click", () => {
    let s = emptyDraw("circle");
    expect(drawResult(s).ok).toBe(false);
    s = addPoint(s, [0, 0]);
    expect(drawResult(s).ok).toBe(false);
    s = addPoint(s, [0, 0.09]); // ~10 km north
    const r = drawResult(s);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.radiusKm).toBeCloseTo(10, 0);
      expect(r.center).toEqual([0, 0]);
    }
    s = undoPoint(s);
    expect(s.radiusKm).toBeNull();
    expect(s.center).toEqual([0, 0]);
  });
  it("renders preview features with a rubber band", () => {
    let s = emptyDraw("polygon");
    s = addPoint(addPoint(s, [0, 0]), [1, 0]);
    s = { ...s, cursor: [1, 1] };
    const fc = drawFeatures(s);
    const roles = fc.features.map((f) => f.properties?.role);
    expect(roles).toContain("fill");
    expect(roles).toContain("line");
    expect(roles.filter((r) => r === "vertex")).toHaveLength(2);
  });
});
