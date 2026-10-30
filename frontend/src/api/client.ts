/* Low-level fetch client: base URL, auth headers, error handling. */

export const API_BASE: string = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

const TOKEN_KEY = "fa_token";
const ORG_KEY = "fa_org";

/** localStorage wrapped in try/catch: private windows and blocked storage must not break the app. */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

export const session = {
  token: () => storage.get(TOKEN_KEY),
  setToken: (t: string | null) => storage.set(TOKEN_KEY, t),
  orgId: () => storage.get(ORG_KEY),
  setOrgId: (id: number | string | null) => storage.set(ORG_KEY, id == null ? null : String(id)),
  clear() {
    storage.set(TOKEN_KEY, null);
    storage.set(ORG_KEY, null);
  },
};

/** An HTTP error from the API, carrying the status and the server's human-readable detail. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  get isPlanLimit() {
    return this.status === 402;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
}

/** Turn FastAPI's `detail` (string, validation error list or object) into one readable sentence. */
export function describeDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (d && typeof d === "object" && "msg" in d) {
          const loc = Array.isArray((d as { loc?: unknown[] }).loc)
            ? ((d as { loc: unknown[] }).loc.filter((x) => x !== "body" && x !== "query").join("."))
            : "";
          const msg = String((d as { msg: unknown }).msg).replace(/^Value error, /, "");
          return loc ? `${loc}: ${msg}` : msg;
        }
        return typeof d === "string" ? d : JSON.stringify(d);
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return fallback;
}

type Listener = (err: ApiError) => void;
const listeners = { unauthorized: new Set<Listener>(), planLimit: new Set<Listener>(), forbidden: new Set<Listener>() };

/** Subscribe to global API events (401 → sign-in, 402 → plan notice). Returns an unsubscribe function. */
export function onApiEvent(kind: keyof typeof listeners, fn: Listener): () => void {
  listeners[kind].add(fn);
  return () => listeners[kind].delete(fn);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw Response instead of parsing JSON (downloads, HTML). */
  raw?: boolean;
  /** Do not emit global 401/402 events (e.g. sign-in form handles its own errors). */
  quiet?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  let url = `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  return url;
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const token = session.token();
  if (token) {
    h.Authorization = `Bearer ${token}`;
    const org = session.orgId();
    if (org) h["X-Org-Id"] = org;
  }
  return h;
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(), ...(opts.headers || {}) };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method: opts.method || (body ? "POST" : "GET"), headers, body, signal: opts.signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach the Firealerts server. Check your connection and try again.");
  }
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = (await res.json()).detail;
    } catch {
      detail = undefined;
    }
    const fallback = res.status === 404 ? "Not found" : res.status >= 500 ? `Server error (${res.status})` : res.statusText || `Request failed (${res.status})`;
    const err = new ApiError(res.status, describeDetail(detail, fallback), detail);
    if (!opts.quiet) {
      if (res.status === 401 && !path.startsWith("/api/auth/")) {
        listeners.unauthorized.forEach((fn) => fn(err));
      } else if (res.status === 402) {
        listeners.planLimit.forEach((fn) => fn(err));
      } else if (res.status === 403) {
        listeners.forbidden.forEach((fn) => fn(err));
      }
    }
    throw err;
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return null as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Name from a Content-Disposition header, if any. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/** Authenticated download: fetch with the bearer header, then save via a blob URL. */
export async function download(path: string, query?: RequestOptions["query"], fallbackName = "download"): Promise<void> {
  const res = await request<Response>(path, { query, raw: true });
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition"), fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Fetch an authenticated HTML page (e.g. the printable report) and open it in a new tab. */
export async function openHtml(path: string, win?: Window | null): Promise<void> {
  const target = win ?? window.open("", "_blank");
  try {
    const res = await request<Response>(path, { raw: true, headers: { Accept: "text/html" } });
    const html = await res.text();
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    if (target) target.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (err) {
    target?.close();
    throw err;
  }
}
