/* Hand-written response types for the Firealerts API.
 * Request bodies follow docs/openapi.json; response shapes come from the
 * backend routers and the as_dict() methods in backend/firealerts/models.py. */

import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon } from "geojson";

export type Role = "viewer" | "member" | "admin" | "owner";
export type Severity = "info" | "low" | "moderate" | "high" | "critical";
export type AlertType = "detection" | "threat" | "risk" | "system";
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type Danger = "very_low" | "low" | "moderate" | "high" | "very_high" | "extreme";
export type Confidence = "l" | "n" | "h";

// ------------------------------------------------------------------ system

export interface PlanLimits {
  label: string;
  assets: number | null;
  members: number | null;
  connectors: number | null;
  api_keys: number | null;
  forecast_members: number | null;
  max_asset_ha: number | null;
}

export type ConnectorFieldType = "text" | "password" | "url" | "list" | "bool" | "textarea";

export interface ConnectorField {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required: boolean;
  secret: boolean;
  help: string;
  placeholder: string;
}

export interface ConnectorType {
  category: "notification" | "data";
  label: string;
  description: string;
  fields: ConnectorField[];
}

export interface Meta {
  version: string;
  auth_required: boolean;
  registration_open: boolean;
  require_email_verification: boolean;
  email_configured: boolean;
  data_mode: string;
  billing_enabled?: boolean;
  plans: Record<string, PlanLimits>;
  roles: Role[];
  asset_kinds: string[];
  alert_types: AlertType[];
  severities: Severity[];
  danger_classes: Danger[];
  fuels: Fuel[];
  connector_types: Record<string, ConnectorType>;
  /** Supported UI / alert languages (newer servers). */
  languages?: string[];
  /** Whether the public live map (/api/public/*) is enabled. */
  public_map?: boolean;
  /** Whether Web Push is configured (VAPID keys present). */
  push_enabled?: boolean;
}

export type Language = "en" | "es" | "pt";

export interface Fuel {
  code: string;
  name: string;
}

export interface IngestRun {
  id: number;
  started_at: string | null;
  finished_at: string | null;
  mode: string;
  fetched: number;
  inserted: number;
  alerts: number;
  per_source: Record<string, number>;
  errors: string[];
}

export interface Status {
  version: string;
  data_mode: string;
  active_mode: string | null;
  poll_minutes: number;
  detections_24h: number;
  by_source_24h: Record<string, number>;
  latest_detection: string | null;
  runs: IngestRun[];
  region_bbox: number[] | null;
}

export interface PublicSource {
  id: string;
  name: string;
  kind: string;
  coverage: string;
  cadence: string;
  auth: string;
  url: string;
  status: "ok" | "idle" | "error" | "disabled" | "available" | string;
  last_count?: number;
}

export interface SourcesResponse {
  sources: PublicSource[];
  last_ingest: IngestRun | null;
  mode: string;
}

// ------------------------------------------------------------------ accounts

export interface User {
  id: number;
  email: string;
  name: string;
  is_superuser: boolean;
  email_verified: boolean;
  created_at: string | null;
  language?: Language | null;
}

export interface Membership {
  org_id: number;
  org_name: string;
  role: Role;
  plan: string;
}

export interface Org {
  id: number;
  name: string;
  plan: string;
  settings: OrgSettings;
  created_at: string | null;
}

export interface OrgSettings {
  timezone?: string;
  daily_digest?: boolean;
  units?: string;
  default_buffer_km?: number;
  /** Language for alert messages and e-mails sent to this organisation. */
  language?: Language;
}

export interface Me {
  authenticated: boolean;
  auth_required: boolean;
  registration_open: boolean;
  require_email_verification: boolean;
  user: User | null;
  memberships: Membership[];
  org: (Org & { limits: PlanLimits }) | null;
  role: Role | null;
  via?: "session" | "api" | "anonymous";
}

export interface SessionPayload {
  token: string;
  user: User;
  memberships: Membership[];
}

export interface Verification {
  emailed: boolean;
  dev_link?: string;
}

export interface RegisterResponse extends SessionPayload {
  verification: Verification | null;
}

export interface OrgDetail extends Org {
  role: Role;
  limits: PlanLimits;
  usage: { assets: number; members: number; connectors: number };
}

export interface Member {
  user_id: number;
  email: string;
  name: string;
  role: Role;
  joined_at: string;
  last_login_at: string | null;
}

export interface PendingInvite {
  id: number;
  email: string;
  role: Role;
  created_at: string;
}

export interface MembersResponse {
  members: Member[];
  pending_invites: PendingInvite[];
}

export interface InviteCreated {
  id: number;
  email: string;
  role: Role;
  invite_url: string;
  emailed: boolean;
}

export interface InviteInfo {
  email: string;
  role: Role;
  org_name: string;
}

export interface AuditEntry {
  id: number;
  user_id: number | null;
  user_email: string | null;
  action: string;
  target: string;
  data: Record<string, unknown>;
  created_at: string | null;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeyCreated {
  name: string;
  key: string;
  note: string;
}

// ------------------------------------------------------------------ assets

export interface RiskDay {
  date: string;
  fwi: number;
  danger: Danger;
  ignition_p: number | null;
  forecast: boolean;
  data: Record<string, number | string | null>;
  computed_at: string | null;
}

export interface Asset {
  id: number;
  name: string;
  kind: string;
  description: string;
  tags: string[];
  area_ha: number;
  centroid: [number, number];
  bbox: [number, number, number, number];
  buffer_km: number;
  min_confidence: Confidence;
  threat_radius_km: number;
  risk_alerts: boolean;
  risk_min_danger: Danger;
  active: boolean;
  properties: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
  geometry?: Polygon | MultiPolygon;
}

export interface AssetListItem extends Asset {
  open_alerts: number;
  risk_today: RiskDay | null;
}

export interface AssetInput {
  name: string;
  kind?: string;
  description?: string;
  tags?: string[];
  geometry?: Polygon | MultiPolygon | null;
  center?: [number, number] | null;
  radius_km?: number | null;
  buffer_km?: number;
  min_confidence?: Confidence;
  threat_radius_km?: number;
  risk_alerts?: boolean;
  risk_min_danger?: Danger;
  properties?: Record<string, unknown>;
}

export type AssetPatch = Partial<Omit<AssetInput, "center" | "radius_km" | "properties">> & { active?: boolean };

export interface ImportResult {
  created: Asset[];
  errors: { feature: number; error: string }[];
}

export interface NearbyIncident {
  id: string;
  lat: number;
  lon: number;
  count: number;
  frp_sum: number;
  area_ha: number;
  status: string;
  last_seen: string;
  priority: number;
  distance_km: number;
  bearing_deg: number;
}

export interface VegObservation {
  date: string;
  source: string;
  scene_id: string;
  cloud_pct: number | null;
  valid_frac: number;
  ndvi: number | null;
  nbr: number | null;
  ndmi: number | null;
  stats: Record<string, unknown>;
}

export interface VegTrend {
  ndvi_change: number | null;
  nbr_change: number | null;
  from: string;
  to: string;
  possible_burn: boolean;
}

export interface Vegetation {
  observations: VegObservation[];
  latest: VegObservation | null;
  trend: VegTrend | null;
  scenes_found?: number;
  analysed?: number;
}

export interface AssetSummary {
  asset: Asset;
  fires: {
    inside_24h: number;
    buffer_24h: number;
    within_25km_7d: number;
    nearest: { km: number; acq_time: string; source: string; lat: number; lon: number } | null;
  };
  incidents_nearby: NearbyIncident[];
  risk: RiskDay[];
  vegetation: { latest: VegObservation | null; trend: VegTrend | null };
  open_alerts: Alert[];
}

export interface Scene {
  id: string;
  datetime: string;
  date: string;
  cloud_pct: number | null;
  epsg?: number;
}

export type ImageCoordinates = [[number, number], [number, number], [number, number], [number, number]];

export interface ImageryResult {
  index: string;
  scene: Scene;
  url: string;
  coordinates: ImageCoordinates;
  resolution_m?: number;
}

export interface BurnSeverityClass {
  class: string;
  min: number | null;
  max: number | null;
  fraction: number;
  area_ha: number;
}

export interface BurnSeverityResult {
  pre: Scene;
  post: Scene;
  valid_frac: number;
  dnbr: { mean: number; p10: number; p50: number; p90: number };
  burned_fraction: number;
  burned_ha: number;
  classes: BurnSeverityClass[];
  image: ImageryResult;
}

export interface Analysis<T> {
  kind: string;
  source: string | null;
  params?: string;
  result: T;
  created_at: string | null;
}

export interface BurnHistory {
  months: { month: string; burned_ha: number }[];
  archive: { month: string; detections: number }[];
  errors?: string[];
}

export interface ForestLoss {
  loss_by_year: { year: number; loss_ha: number }[];
  recent_alerts?: { since: string; alerts: number; area_ha: number };
  errors?: string[];
}

export interface Exposure {
  radius_m?: number;
  settlements?: number;
  buildings?: number;
  road_segments?: number;
  places?: { name: string; place: string; population: string | number | null; lat: number; lon: number }[];
  error?: string;
}

// ------------------------------------------------------------------ alerts

export interface Delivery {
  connector_id: number;
  type: string;
  name: string;
  status: string;
  at: string;
  severity: Severity;
}

export interface Alert {
  id: number;
  asset_id: number | null;
  asset_name?: string | null;
  type: AlertType;
  severity: Severity;
  title: string;
  message: string;
  data: Record<string, unknown>;
  lat: number | null;
  lon: number | null;
  status: AlertStatus;
  acknowledged_by: number | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  deliveries: Delivery[];
  created_at: string | null;
  updated_at: string | null;
}

export interface AlertDetail extends Alert {
  asset: Asset | null;
}

export interface AlertList {
  total: number;
  items: Alert[];
}

export interface AlertStats {
  days: number;
  by_type: Record<AlertType, number>;
  by_severity: Record<Severity, number>;
  by_status: Partial<Record<AlertStatus, number>>;
  daily: { date: string; count: number }[];
  open: number;
}

// ------------------------------------------------------------------ integrations

export interface Connector {
  id: number;
  type: string;
  category: "notification" | "data" | null;
  label: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  last_status: string;
  last_error: string;
  last_used_at: string | null;
  created_at: string;
}

export interface ConnectorInput {
  type: string;
  name: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}

export interface NotificationRule {
  id: number;
  name: string;
  asset_ids: number[] | null;
  alert_types: AlertType[];
  min_severity: Severity;
  connector_ids: number[];
  enabled: boolean;
  created_at: string | null;
}

export type RuleInput = Omit<NotificationRule, "id" | "created_at">;

// ------------------------------------------------------------------ fire data

export interface DetectionProps {
  id: string;
  source: string;
  satellite: string;
  acq_time: string;
  frp: number | null;
  brightness: number | null;
  confidence: Confidence;
  daynight: string;
  pixel_m: number;
  distance_km?: number;
  age_h?: number;
  kind?: "geo" | "polar";
  /** Known static heat source near the pixel (volcano, gas flare, persistent industrial heat). */
  static_source?: StaticSourceType | null;
}

export type StaticSourceType = "volcano" | "industrial" | "persistent";

export interface StaticSource {
  type: StaticSourceType;
  name: string;
  distance_km: number;
}

export type DetectionCollection = FeatureCollection<Point, DetectionProps>;

export interface Incident {
  id: string;
  lat: number;
  lon: number;
  count: number;
  sources: string[];
  first_seen: string;
  last_seen: string;
  age_h: number;
  frp_sum: number;
  frp_max: number;
  area_ha: number;
  high_confidence: number;
  recent_6h: number;
  priority: number;
  status: string;
  hull: Polygon | null;
  static_source?: StaticSource | null;
}

export interface IncidentList {
  count: number;
  incidents: Incident[];
}

export interface DangerDay {
  date: string;
  temp: number;
  rh: number;
  wind: number;
  rain: number;
  ffmc: number;
  dmc: number;
  dc: number;
  isi: number;
  bui: number;
  fwi: number;
  danger: Danger;
  forecast: boolean;
}

export interface HourlyBehaviour {
  time: string;
  ffmc: number;
  isi: number;
  ros_m_min: number;
  max_ros_m_min: number;
  back_ros_m_min: number;
  length_to_breadth: number;
  spread_dir: number;
  intensity_kw_m: number;
  intensity_class: number;
  wind: number;
  wind_dir: number;
  temp: number;
  rh: number;
  rain: number;
}

export interface HorizonStat {
  horizon_h: number;
  time: string;
  area_ha_p10: number;
  area_ha_p50: number;
  area_ha_p90: number;
  growth_ha_p50: number;
  max_run_km: number;
}

export interface Forecast {
  model: "raster" | "uniform";
  fuel: Fuel;
  seed: Feature<Geometry, { area_ha: number }>;
  perimeters: FeatureCollection<Geometry, { horizon_h: number; kind: "likely" | "p90"; area_ha: number }>;
  burn_probability: FeatureCollection<Geometry, { p: number }>;
  images?: { coordinates: ImageCoordinates; arrival: string; burn: string; fuel: string } | null;
  fuel_mix?: Record<string, number>;
  domain_limited?: boolean;
  stats: HorizonStat[];
  hourly: HourlyBehaviour[];
  members: number;
  fwi_state: { ffmc: number; dmc: number; dc: number; bui: number };
  terrain?: {
    source: string;
    cell_m: number;
    size_km: number;
    elevation_m: [number, number];
    slope_pct_p50: number;
    slope_pct_p90: number;
    landcover: Record<string, number>;
  };
  model_note: string | null;
  weather_source: string;
  danger: DangerDay[];
  current: { temp: number; rh: number; wind: number; wind_dir: number; ffmc: number; isi: number };
  incident?: Incident;
}

export interface DangerPoint {
  lat: number;
  lon: number;
  source: string;
  current: { temp: number; rh: number; wind: number; wind_dir: number; ffmc: number; isi: number };
  state: { ffmc: number; dmc: number; dc: number };
  days: DangerDay[];
  hourly: { time: string; temp: number; rh: number; wind: number; wind_dir: number; rain: number }[];
}

export interface DangerGrid extends FeatureCollection<Polygon, { fwi: number[]; danger: Danger[] }> {
  dates: string[];
  source: string;
}

export interface RiskModelMeta {
  kind: "trained" | "baseline" | string;
  description?: string;
  region?: string;
  trained_at?: string;
  test?: { roc_auc?: number | null; brier?: number };
  test_baseline?: { roc_auc?: number | null };
  warning?: string;
  features?: string[];
}

export interface IgnitionGrid extends FeatureCollection<Polygon, { p: number[]; fwi: number[]; fuel_frac: number }> {
  dates: string[];
  weather_source: string;
  model: RiskModelMeta;
}

export interface DataUsage {
  assets: number;
  alerts: number;
  observations: number;
  risk_snapshots: number;
  platform_detections: number;
}

export interface WindProps {
  /** km/h, one value per entry of `hours`. */
  speed: number[];
  /** Degrees the wind blows FROM (meteorological), one per hour. */
  dir: number[];
}

export interface WindField {
  source: "open-meteo" | "demo" | string;
  hours: string[];
  features: Feature<Point, WindProps>[];
}

export interface FireStats {
  days: number;
  total: number;
  frp_total: number;
  daily: { date: string; count: number; frp: number }[];
  by_source: Record<string, number>;
}

/** /api/public/status: the public subset of /api/status (no runs or errors). */
export interface PublicStatus {
  detections_24h: number;
  by_source_24h: Record<string, number>;
  latest_detection: string | null;
  last_sync?: string | null;
  active_mode?: string | null;
}

// ------------------------------------------------------------------ push

export interface VapidKey {
  enabled: boolean;
  key: string | null;
}

export interface PushDevice {
  id: number | string;
  endpoint_host: string;
  user_agent: string | null;
  created_at: string | null;
}

// ------------------------------------------------------------------ admin

export interface AdminStats {
  organizations: number;
  users: number;
  users_active_7d: number;
  assets: number;
  monitored_ha: number;
  connectors: number;
  alerts_24h: number;
  detections_24h: number;
  detections_total: number;
  last_ingest: IngestRun | null;
  plans: Record<string, number>;
}

export interface AdminOrg extends Org {
  members: number;
  assets: number;
}

export interface AdminUser extends User {
  last_login_at: string | null;
}

// ------------------------------------------------------------------ billing

export interface BillingStatus {
  enabled: boolean;
  plan: string;
  has_customer: boolean;
  purchasable: string[];
}
