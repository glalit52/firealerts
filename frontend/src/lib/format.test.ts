import { describe, expect, it } from "vitest";
import { compass, fmtCompact, fmtHa, fmtHours, fmtKm, fmtNum, fmtPct, humanize, initials, timeAgo } from "./format";

describe("format", () => {
  it("formats numbers null-safely", () => {
    expect(fmtNum(1234.567, 1)).toBe("1,234.6");
    expect(fmtNum(null)).toBe("–");
    expect(fmtNum(Number.NaN)).toBe("–");
  });
  it("compacts large numbers", () => {
    expect(fmtCompact(950)).toBe("950");
    expect(fmtCompact(1234)).toBe("1.2k");
    expect(fmtCompact(25_000)).toBe("25k");
    expect(fmtCompact(2_500_000)).toBe("2.5M");
  });
  it("formats units", () => {
    expect(fmtHa(7841.43)).toBe("7,841 ha");
    expect(fmtHa(3.25)).toBe("3.3 ha");
    expect(fmtPct(0.6846)).toBe("68%");
    expect(fmtPct(0.6846, 1)).toBe("68.5%");
    expect(fmtKm(0)).toBe("inside");
    expect(fmtKm(6.81)).toBe("6.8 km");
    expect(fmtHours(0.5)).toBe("30 min");
    expect(fmtHours(5.25)).toBe("5.3 h");
    expect(fmtHours(72)).toBe("3.0 d");
  });
  it("relative times", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(timeAgo("2026-10-29T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-10-29T11:15:00Z", now)).toBe("45 min ago");
    expect(timeAgo("2026-10-29T06:00:00Z", now)).toBe("6 h ago");
    expect(timeAgo("2026-10-25T12:00:00Z", now)).toBe("4 d ago");
    expect(timeAgo(null, now)).toBe("–");
  });
  it("compass, humanize, initials", () => {
    expect(compass(0)).toBe("N");
    expect(compass(267)).toBe("W");
    expect(compass(-45)).toBe("NW");
    expect(humanize("protected_area")).toBe("Protected area");
    expect(initials("Ana María López")).toBe("AM");
    expect(initials("ops@example.com")).toBe("OE");
  });
});
