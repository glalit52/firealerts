/* Typed wrappers for every Firealerts API operation (see docs/openapi.json). */

import { download, openHtml, request } from "./client";
import type * as T from "./types";

const enc = encodeURIComponent;

// ------------------------------------------------------------------ system
export const system = {
  health: () => request<{ status: string; version: string }>("/api/health"),
  meta: () => request<T.Meta>("/api/meta"),
  status: () => request<T.Status>("/api/status"),
  sources: () => request<T.SourcesResponse>("/api/sources"),
  ingest: () => request<T.IngestRun>("/api/ingest", { method: "POST" }),
};

// ------------------------------------------------------------------ auth & profile
export const auth = {
  register: (body: { email: string; password: string; name?: string; org_name?: string; invite_token?: string }) =>
    request<T.RegisterResponse>("/api/auth/register", { method: "POST", body, quiet: true }),
  login: (body: { email: string; password: string }) => request<T.SessionPayload>("/api/auth/login", { method: "POST", body, quiet: true }),
  logout: () => request<null>("/api/auth/logout", { method: "POST", quiet: true }),
  verifyEmail: (token: string) => request<{ verified: boolean; email: string }>("/api/auth/verify-email", { method: "POST", body: { token }, quiet: true }),
  resendVerification: () => request<T.Verification & { already_verified?: boolean }>("/api/auth/resend-verification", { method: "POST" }),
  forgotPassword: (email: string) => request<{ accepted: boolean; dev_link?: string }>("/api/auth/forgot-password", { method: "POST", body: { email }, quiet: true }),
  resetPassword: (token: string, password: string) => request<T.SessionPayload>("/api/auth/reset-password", { method: "POST", body: { token, password }, quiet: true }),
  me: () => request<T.Me>("/api/me", { quiet: true }),
  updateMe: (body: { name?: string }) => request<T.User>("/api/me", { method: "PATCH", body }),
  deleteMe: () => request<null>("/api/me", { method: "DELETE" }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ changed: boolean }>("/api/me/password", { method: "POST", body: { current_password, new_password } }),
  inviteInfo: (token: string) => request<T.InviteInfo>(`/api/invites/${enc(token)}`, { quiet: true }),
  acceptInvite: (token: string) => request<{ org_id: number; role: T.Role }>(`/api/invites/${enc(token)}/accept`, { method: "POST" }),
};

export const keys = {
  list: () => request<T.ApiKey[]>("/api/keys"),
  create: (name: string) => request<T.ApiKeyCreated>("/api/keys", { method: "POST", body: { name } }),
  remove: (id: number) => request<null>(`/api/keys/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ organisation
export const orgs = {
  create: (name: string) => request<{ id: number; name: string; role: T.Role; plan: string }>("/api/orgs", { method: "POST", body: { name } }),
  get: () => request<T.OrgDetail>("/api/org"),
  update: (body: { name?: string; settings?: T.OrgSettings }) => request<T.Org>("/api/org", { method: "PATCH", body }),
  remove: () => request<null>("/api/org", { method: "DELETE" }),
  members: () => request<T.MembersResponse>("/api/org/members"),
  setRole: (userId: number, role: T.Role) => request<{ user_id: number; role: T.Role }>(`/api/org/members/${userId}`, { method: "PATCH", body: { role } }),
  removeMember: (userId: number) => request<null>(`/api/org/members/${userId}`, { method: "DELETE" }),
  invite: (email: string, role: T.Role) => request<T.InviteCreated>("/api/org/invites", { method: "POST", body: { email, role } }),
  revokeInvite: (id: number) => request<null>(`/api/org/invites/${id}`, { method: "DELETE" }),
  audit: (limit = 100) => request<T.AuditEntry[]>("/api/org/audit", { query: { limit } }),
};

// ------------------------------------------------------------------ assets
export const assets = {
  list: (geometry = false) => request<T.AssetListItem[]>("/api/assets", { query: { geometry } }),
  create: (body: T.AssetInput) => request<T.Asset>("/api/assets", { method: "POST", body }),
  import: (file: File, kind: string, bufferKm: number) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<T.ImportResult>("/api/assets/import", { method: "POST", body: fd, query: { kind, buffer_km: bufferKm } });
  },
  get: (id: number) => request<T.Asset>(`/api/assets/${id}`),
  update: (id: number, body: T.AssetPatch) => request<T.Asset>(`/api/assets/${id}`, { method: "PATCH", body }),
  remove: (id: number) => request<null>(`/api/assets/${id}`, { method: "DELETE" }),
  summary: (id: number) => request<T.AssetSummary>(`/api/assets/${id}/summary`),
  detections: (id: number, days = 7, radiusKm?: number) => request<T.DetectionCollection>(`/api/assets/${id}/detections`, { query: { days, radius_km: radiusKm } }),
  risk: (id: number, refresh = false) => request<{ days: T.RiskDay[] }>(`/api/assets/${id}/risk`, { query: { refresh: refresh || undefined } }),
  vegetation: (id: number, days = 365) => request<T.Vegetation>(`/api/assets/${id}/vegetation`, { query: { days } }),
  refreshVegetation: (id: number, days = 120) => request<T.Vegetation>(`/api/assets/${id}/vegetation/refresh`, { method: "POST", query: { days } }),
  scenes: (id: number, days = 90, maxCloud = 60) => request<T.Scene[]>(`/api/assets/${id}/scenes`, { query: { days, max_cloud: maxCloud } }),
  imagery: (id: number, index: "ndvi" | "nbr" | "ndmi", sceneId?: string, date?: string) =>
    request<T.ImageryResult>(`/api/assets/${id}/imagery`, { query: { index, scene_id: sceneId, date } }),
  burnSeverity: (id: number, body: { pre_date?: string; post_date?: string; pre_scene_id?: string; post_scene_id?: string }) =>
    request<T.BurnSeverityResult>(`/api/assets/${id}/burn-severity`, { method: "POST", body }),
  history: (id: number, years = 5) => request<T.Analysis<T.BurnHistory>>(`/api/assets/${id}/history`, { query: { years } }),
  forestLoss: (id: number) => request<T.Analysis<T.ForestLoss>>(`/api/assets/${id}/forest-loss`),
  exposure: (id: number, radiusKm = 10) => request<T.Analysis<T.Exposure>>(`/api/assets/${id}/exposure`, { query: { radius_km: radiusKm } }),
  openReport: (id: number, win?: Window | null) => openHtml(`/api/assets/${id}/report`, win),
  downloadTimeseries: (id: number) => download(`/api/export/assets/${id}/timeseries.csv`, undefined, `asset-${id}-timeseries.csv`),
};

// ------------------------------------------------------------------ alerts
export interface AlertQuery {
  status?: "open" | "acknowledged" | "resolved" | "active";
  type?: string;
  severity?: string;
  asset_id?: number;
  days?: number;
  limit?: number;
  offset?: number;
}

export const alerts = {
  list: (q: AlertQuery = {}) => request<T.AlertList>("/api/alerts", { query: { ...q } }),
  stats: (days = 30) => request<T.AlertStats>("/api/alerts/stats", { query: { days } }),
  get: (id: number) => request<T.AlertDetail>(`/api/alerts/${id}`),
  ack: (id: number) => request<T.Alert>(`/api/alerts/${id}/ack`, { method: "POST" }),
  resolve: (id: number) => request<T.Alert>(`/api/alerts/${id}/resolve`, { method: "POST" }),
  reopen: (id: number) => request<T.Alert>(`/api/alerts/${id}/reopen`, { method: "POST" }),
};

// ------------------------------------------------------------------ integrations
export const connectors = {
  types: () => request<Record<string, T.ConnectorType>>("/api/connectors/types"),
  list: () => request<T.Connector[]>("/api/connectors"),
  create: (body: T.ConnectorInput) => request<T.Connector>("/api/connectors", { method: "POST", body }),
  update: (id: number, body: Partial<Omit<T.ConnectorInput, "type">>) => request<T.Connector>(`/api/connectors/${id}`, { method: "PATCH", body }),
  remove: (id: number) => request<null>(`/api/connectors/${id}`, { method: "DELETE" }),
  test: (id: number) => request<{ ok: boolean; message: string }>(`/api/connectors/${id}/test`, { method: "POST" }),
};

export const rules = {
  list: () => request<T.NotificationRule[]>("/api/notification-rules"),
  create: (body: T.RuleInput) => request<T.NotificationRule>("/api/notification-rules", { method: "POST", body }),
  update: (id: number, body: T.RuleInput) => request<T.NotificationRule>(`/api/notification-rules/${id}`, { method: "PUT", body }),
  remove: (id: number) => request<null>(`/api/notification-rules/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ fire data
export interface ForecastParams {
  fuel?: string;
  curing?: number;
  hours?: number;
  members?: number;
  model?: "auto" | "raster" | "uniform";
}

export const fire = {
  detections: (q: { bbox?: string; hours?: number; sources?: string } = {}, signal?: AbortSignal) =>
    request<T.DetectionCollection>("/api/detections", { query: q, signal }),
  incidents: (q: { bbox?: string; hours?: number; min_count?: number; limit?: number } = {}, signal?: AbortSignal) =>
    request<T.IncidentList>("/api/incidents", { query: q, signal }),
  incident: (id: string, hours = 24) => request<T.Incident & { timeline: { hour: string; count: number }[] }>(`/api/incidents/${enc(id)}`, { query: { hours } }),
  incidentForecast: (id: string, p: ForecastParams = {}, signal?: AbortSignal) =>
    request<T.Forecast>(`/api/incidents/${enc(id)}/forecast`, { query: { ...p }, signal }),
  spread: (lat: number, lon: number, p: ForecastParams = {}, signal?: AbortSignal) =>
    request<T.Forecast>("/api/forecast/spread", { query: { lat, lon, ...p }, signal }),
  danger: (lat: number, lon: number) => request<T.DangerPoint>("/api/danger", { query: { lat, lon } }),
  dangerGrid: (bbox: string, n = 10) => request<T.DangerGrid>("/api/danger/grid", { query: { bbox, n } }),
  ignition: (bbox: string, n = 10) => request<T.IgnitionGrid>("/api/risk/ignition", { query: { bbox, n } }),
  riskModel: () => request<T.RiskModelMeta>("/api/risk/model"),
  fuels: () => request<T.Fuel[]>("/api/fuels"),
};

// ------------------------------------------------------------------ data
export const data = {
  usage: () => request<T.DataUsage>("/api/data/usage"),
  exportDetections: (fmt: "csv" | "geojson" | "kml", hours: number, bbox?: string) =>
    download(`/api/export/detections.${fmt}`, { hours, bbox }, `detections.${fmt}`),
  exportAlerts: (days = 90) => download("/api/export/alerts.csv", { days }, "alerts.csv"),
  exportAssets: (fmt: "csv" | "geojson" | "kml") => download(`/api/export/assets.${fmt}`, undefined, `assets.${fmt}`),
};

// ------------------------------------------------------------------ admin
export const admin = {
  stats: () => request<T.AdminStats>("/api/admin/stats"),
  orgs: (q = "", limit = 200) => request<T.AdminOrg[]>("/api/admin/orgs", { query: { q, limit } }),
  setPlan: (orgId: number, plan: string) => request<T.Org>(`/api/admin/orgs/${orgId}`, { method: "PATCH", body: { plan } }),
  users: (q = "", limit = 200) => request<T.AdminUser[]>("/api/admin/users", { query: { q, limit } }),
};

// ------------------------------------------------------------------ billing
export const billing = {
  status: () => request<T.BillingStatus>("/api/billing"),
  checkout: (plan: string) => request<{ url: string }>("/api/billing/checkout", { method: "POST", body: { plan } }),
  portal: () => request<{ url: string }>("/api/billing/portal", { method: "POST" }),
};
