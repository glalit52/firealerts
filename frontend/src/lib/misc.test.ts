import { describe, expect, it } from "vitest";
import { dailyInRange } from "../components/FireStats";
import { historyRangeError } from "./history";
import { padBBox } from "./geo";
import { urlBase64ToUint8Array } from "./push";

describe("history range", () => {
  it("validates order, future and the 31-day limit", () => {
    expect(historyRangeError("2026-10-01", "2026-10-31", "2026-10-31")).toBeNull();
    expect(historyRangeError("2026-09-30", "2026-10-31", "2026-10-31")).toBe("history.errMax");
    expect(historyRangeError("2026-10-10", "2026-10-01", "2026-10-31")).toBe("history.errOrder");
    expect(historyRangeError("2026-10-10", "2026-11-02", "2026-10-31")).toBe("history.errFuture");
    expect(historyRangeError("", "2026-10-02")).toBe("history.errMissing");
  });
});

describe("fire stats", () => {
  it("fills missing days and clips to the range", () => {
    const d = dailyInRange({ days: 30, total: 3, frp_total: 9, by_source: {}, daily: [{ date: "2026-10-02", count: 2, frp: 5 }, { date: "2026-10-05", count: 1, frp: 4 }] }, "2026-10-01", "2026-10-03");
    expect(d.map((x) => [x.date, x.count])).toEqual([["2026-10-01", 0], ["2026-10-02", 2], ["2026-10-03", 0]]);
  });
});

describe("geo & push helpers", () => {
  it("pads a bbox in km", () => {
    const b = padBBox([10, 0, 11, 1], 111.32);
    expect(b[1]).toBeCloseTo(-1, 5);
    expect(b[0]).toBeCloseTo(9, 2);
  });
  it("decodes VAPID base64url keys", () => {
    expect([...urlBase64ToUint8Array("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});
