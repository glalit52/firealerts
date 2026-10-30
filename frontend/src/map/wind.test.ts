import { describe, expect, it } from "vitest";
import type { WindField } from "../api/types";
import { ARROW_SHAPE, arrowSDF, bboxContains, nearestHour, toBearing, windBBox, windColor, windFeatures, windLegend } from "./wind";

const size = (b: number[]) => [+(b[2]! - b[0]!).toFixed(2), +(b[3]! - b[1]!).toFixed(2)];

describe("wind bbox", () => {
  it("never requests finer than 1°×1°", () => {
    const b = windBBox([-64.71, -31.3, -64.69, -31.28]);
    expect(size(b)).toEqual([1, 1]);
    expect((b[0] + b[2]) / 2).toBeCloseTo(-64.7, 1);
  });
  it("clamps to at most 60°×40° around the centre", () => {
    const b = windBBox([-170, -80, 170, 80]);
    expect(size(b)).toEqual([60, 40]);
    expect(windBBox([-100, -10, -20, 50])).toEqual([-90, 0, -30, 40]);
  });
  it("keeps the box inside the world by shifting it", () => {
    const b = windBBox([179.8, 84.8, 180, 85]);
    expect(b[2]).toBeLessThanOrEqual(180);
    expect(b[3]).toBeLessThanOrEqual(85);
    expect(size(b)).toEqual([1, 1]);
  });
  it("detects containment", () => {
    expect(bboxContains([0, 0, 10, 10], [1, 1, 9, 9])).toBe(true);
    expect(bboxContains([0, 0, 10, 10], [1, 1, 11, 9])).toBe(false);
  });
});

describe("wind arrows", () => {
  it("rotate toward where the wind blows (dir + 180)", () => {
    expect(toBearing(0)).toBe(180); // northerly wind blows south
    expect(toBearing(270)).toBe(90); // westerly wind blows east
    expect(toBearing(200)).toBe(20);
    expect(toBearing(-90)).toBe(90);
  });
  it("colours by speed band with a km/h legend", () => {
    expect(windColor(5)).toBe(windColor(0));
    expect(windColor(65)).not.toBe(windColor(25));
    const l = windLegend();
    expect(l[0]!.label).toBe("0–10");
    expect(l[l.length - 1]!.label).toBe("60+");
  });
  it("builds point features for one forecast hour, skipping gaps", () => {
    const field: WindField = {
      source: "demo",
      hours: ["2026-10-30T00:00:00Z", "2026-10-30T03:00:00Z"],
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { speed: [10, 30], dir: [90, 180] } },
        { type: "Feature", geometry: { type: "Point", coordinates: [3, 4] }, properties: { speed: [12], dir: [45] } },
      ],
    };
    const h1 = windFeatures(field, 1);
    expect(h1.features).toHaveLength(1);
    expect(h1.features[0]!.properties).toEqual({ speed: 30, dir: 180, rot: 0 });
    expect(windFeatures(field, 0).features[1]!.properties.rot).toBe(225);
    expect(windFeatures(null, 0).features).toHaveLength(0);
    expect(nearestHour(field.hours, Date.parse("2026-10-30T02:00:00Z"))).toBe(1);
  });
  it("draws an SDF arrow: opaque inside the shape, transparent in the corners", () => {
    const img = arrowSDF(48, 6);
    expect(img.data.length).toBe(48 * 48 * 4);
    const alpha = (x: number, y: number) => img.data[(y * 48 + x) * 4 + 3]!;
    expect(alpha(24, 30)).toBeGreaterThan(191); // shaft
    expect(alpha(24, 12)).toBeGreaterThan(191); // head
    expect(alpha(1, 1)).toBeLessThan(100);
    expect(alpha(46, 46)).toBeLessThan(100);
    expect(ARROW_SHAPE[0]![1]).toBeLessThan(0.1); // tip points north
  });
});
