import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, buildUrl, describeDetail, filenameFromDisposition, onApiEvent, request, session } from "./client";

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("describeDetail", () => {
  it("passes strings through", () => expect(describeDetail("wrong e-mail or password", "x")).toBe("wrong e-mail or password"));
  it("flattens FastAPI validation errors", () => {
    const d = [{ loc: ["body", "password"], msg: "String should have at least 8 characters", type: "x" }, { loc: ["body", "email"], msg: "Value error, invalid e-mail address", type: "y" }];
    expect(describeDetail(d, "x")).toBe("password: String should have at least 8 characters; email: invalid e-mail address");
  });
  it("falls back", () => expect(describeDetail(undefined, "Server error (500)")).toBe("Server error (500)"));
});

describe("request", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends bearer token and org header when signed in", async () => {
    session.setToken("tok123");
    session.setOrgId(7);
    const f = mockFetch(200, { ok: true });
    await request("/api/me");
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
    expect((init.headers as Record<string, string>)["X-Org-Id"]).toBe("7");
  });

  it("omits auth headers when anonymous", async () => {
    const f = mockFetch(200, {});
    await request("/api/status");
    const h = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBeUndefined();
    expect(h["X-Org-Id"]).toBeUndefined();
  });

  it("serialises JSON bodies and defaults to POST", async () => {
    const f = mockFetch(201, { id: 1 });
    const r = await request<{ id: number }>("/api/assets", { body: { name: "A" } });
    expect(r.id).toBe(1);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"A"}');
  });

  it("returns null for 204", async () => {
    mockFetch(204, undefined);
    expect(await request("/api/assets/1", { method: "DELETE" })).toBeNull();
  });

  it("throws ApiError with status and server detail", async () => {
    mockFetch(409, { detail: "an account with this e-mail already exists" });
    await expect(request("/api/auth/register", { body: {} })).rejects.toMatchObject({ status: 409, message: "an account with this e-mail already exists" });
  });

  it("emits a plan-limit event on 402", async () => {
    mockFetch(402, { detail: "Your Free plan allows 3 assets. Upgrade to add more." });
    const seen: ApiError[] = [];
    const off = onApiEvent("planLimit", (e) => seen.push(e));
    await expect(request("/api/assets", { body: {} })).rejects.toBeInstanceOf(ApiError);
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isPlanLimit).toBe(true);
  });

  it("emits unauthorized on 401 except for auth endpoints", async () => {
    const seen: number[] = [];
    const off = onApiEvent("unauthorized", (e) => seen.push(e.status));
    mockFetch(401, { detail: "sign in required" });
    await expect(request("/api/assets")).rejects.toThrow("sign in required");
    mockFetch(401, { detail: "wrong e-mail or password" });
    await expect(request("/api/auth/login", { body: {} })).rejects.toThrow();
    off();
    expect(seen).toEqual([401]);
  });

  it("maps network failures to status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(request("/api/status")).rejects.toMatchObject({ status: 0 });
  });
});

describe("helpers", () => {
  it("builds query strings skipping empty values", () => {
    expect(buildUrl("/api/alerts", { status: "open", type: undefined, limit: 25, q: "" })).toBe("/api/alerts?status=open&limit=25");
  });
  it("parses Content-Disposition", () => {
    expect(filenameFromDisposition('attachment; filename="alerts.csv"', "x")).toBe("alerts.csv");
    expect(filenameFromDisposition(null, "fallback.csv")).toBe("fallback.csv");
  });
});
