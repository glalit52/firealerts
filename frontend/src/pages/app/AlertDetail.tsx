import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { alerts as alertsApi } from "../../api/endpoints";
import type { AlertDetail as AlertDetailT } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { IconChevronRight, IconMap } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, ButtonLink, Card, DangerPill, ErrorState, Loading, SeverityChip, Tile } from "../../components/ui";
import { compass, fmtCoord, fmtDate, fmtDateTime, fmtHours, fmtKm, fmtNum, fmtPct, humanize, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { MapView } from "../../map/MapView";
import { addLayer, ensureSource, fitGeometry, setData } from "../../map/utils";

function DataTiles({ a }: { a: AlertDetailT }) {
  const d = a.data as Record<string, unknown>;
  const n = (k: string) => (d[k] == null ? null : Number(d[k]));
  if (a.type === "threat")
    return (
      <div className="grid-4">
        <Tile label="Likely arrival" value={fmtHours(n("eta_likely_h"))} accent="#ff4d5e" foot="P50 ensemble" />
        <Tile label="Worst case" value={fmtHours(n("eta_p90_h"))} foot="P90 ensemble" />
        <Tile label="Distance" value={fmtKm(n("distance_km"))} foot={d.bearing_deg != null ? `bearing ${compass(n("bearing_deg"))} (${d.bearing_deg}°)` : undefined} />
        <Tile label="Incident" value={<span className="mono" style={{ fontSize: 15 }}>{String(d.incident_id ?? "–")}</span>} />
      </div>
    );
  if (a.type === "risk")
    return (
      <div className="stack">
        <div className="grid-4">
          <Tile label="Worst day" value={d.date ? fmtDate(String(d.date)).replace(/ \d{4}$/, "") : "–"} />
          <Tile label="FWI" value={fmtNum(n("fwi"), 1)} />
          <Tile label="Danger" value={d.danger ? <DangerPill danger={String(d.danger)} /> : "–"} />
          <Tile label="Ignition probability" value={fmtPct(n("ignition_p"), 1)} />
        </div>
        {Array.isArray(d.days) && (
          <div className="row wrap" style={{ gap: 6 }}>
            {(d.days as { date: string; fwi: number; danger: string }[]).map((x) => (
              <DangerPill key={x.date} danger={x.danger}>
                {fmtDate(x.date).slice(0, 6)} · {fmtNum(x.fwi)}
              </DangerPill>
            ))}
          </div>
        )}
      </div>
    );
  if (a.type === "detection")
    return (
      <div className="grid-4">
        <Tile label="Detections" value={fmtNum(n("count"))} accent="#ff6a2b" />
        <Tile label="Inside the asset" value={fmtNum(n("inside"))} />
        <Tile label="Nearest" value={fmtKm(n("nearest_km"))} />
        <Tile label="Max FRP" value={fmtNum(n("max_frp"), 1)} unit="MW" foot={Array.isArray(d.sources) ? (d.sources as string[]).join(", ") : undefined} />
      </div>
    );
  const entries = Object.entries(d).filter(([k]) => k !== "detection_ids");
  if (!entries.length) return null;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{humanize(k)}</dt>
          <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AlertDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const alert = useAsync(() => alertsApi.get(Number(id)), [id]);
  const [map, setMap] = useState<MlMap | null>(null);
  const [busy, setBusy] = useState(false);
  const a = alert.data;
  useDocumentTitle(a ? a.title : "Alert");

  const onReady = useCallback((m: MlMap) => {
    ensureSource(m, "asset");
    ensureSource(m, "pin");
    addLayer(m, { id: "asset-fill", type: "fill", source: "asset", paint: { "fill-color": "#5aa9ff", "fill-opacity": 0.08 } });
    addLayer(m, { id: "asset-line", type: "line", source: "asset", paint: { "line-color": "#5aa9ff", "line-width": 2 } });
    addLayer(m, { id: "pin-halo", type: "circle", source: "pin", paint: { "circle-radius": 16, "circle-color": "rgba(255,77,94,.18)" } });
    addLayer(m, { id: "pin", type: "circle", source: "pin", paint: { "circle-radius": 6, "circle-color": "#ff4d5e", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    setMap(m);
  }, []);

  useEffect(() => {
    if (!map || !a) return;
    const geoms = [];
    if (a.asset?.geometry) {
      setData(map, "asset", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: a.asset.geometry }] });
      geoms.push(a.asset.geometry);
    }
    if (a.lat != null && a.lon != null) {
      const pt = { type: "Point" as const, coordinates: [a.lon, a.lat] };
      setData(map, "pin", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: pt }] });
      geoms.push(pt);
    }
    if (geoms.length) fitGeometry(map, geoms, { padding: 60, maxZoom: 12 });
  }, [map, a]);

  const act = async (action: "ack" | "resolve" | "reopen") => {
    if (!a) return;
    setBusy(true);
    try {
      const r = await alertsApi[action](a.id);
      alert.setData({ ...a, ...r });
      window.dispatchEvent(new Event("fa:alerts-changed"));
      toast.success(action === "ack" ? "Alert acknowledged." : action === "resolve" ? "Alert resolved." : "Alert reopened.");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (alert.error)
    return (
      <div className="page">
        <ErrorState error={alert.error} onRetry={alert.reload} />
      </div>
    );
  if (!a) return <Loading label="Loading alert" />;
  const incidentId = (a.data as Record<string, unknown>).incident_id;

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/app/alerts">Alerts</Link>
        <IconChevronRight size={12} />
        <span>#{a.id}</span>
      </div>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="row wrap">
            <SeverityChip severity={a.severity} />
            <Badge>{humanize(a.type)}</Badge>
            <Badge kind={a.status === "open" ? "bad" : a.status === "acknowledged" ? "info" : undefined}>{humanize(a.status)}</Badge>
          </div>
          <h1 className="mt-8">{a.title}</h1>
          <div className="small muted mt-4">
            {fmtDateTime(a.created_at)} ({timeAgo(a.created_at)})
            {a.asset && (
              <>
                {" "}
                · <Link to={`/app/assets/${a.asset.id}`}>{a.asset.name}</Link>
              </>
            )}
            {a.lat != null && <> · <span className="mono">{fmtCoord(a.lat, a.lon)}</span></>}
          </div>
        </div>
        {can("member") && (
          <div className="row wrap">
            {a.status === "open" && (
              <Button variant="primary" loading={busy} onClick={() => act("ack")}>
                Acknowledge
              </Button>
            )}
            {a.status !== "resolved" && (
              <Button loading={busy && a.status !== "open"} onClick={() => act("resolve")}>
                Resolve
              </Button>
            )}
            {a.status === "resolved" && (
              <Button loading={busy} onClick={() => act("reopen")}>
                Reopen
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="detail-layout">
        <div className="stack loose">
          <Card title="Details">
            <div className="stack">
              {a.message && <p style={{ whiteSpace: "pre-wrap", color: "var(--text-2)" }}>{a.message}</p>}
              <DataTiles a={a} />
              <div className="row wrap">
                {typeof incidentId === "string" && (
                  <ButtonLink to={`/app/map?incident=${incidentId}`} icon={<IconMap />}>
                    Open spread forecast
                  </ButtonLink>
                )}
                {a.lat != null && (
                  <ButtonLink to={`/app/map?lat=${a.lat}&lon=${a.lon}&zoom=11`} icon={<IconMap />} variant="ghost">
                    View on live map
                  </ButtonLink>
                )}
              </div>
            </div>
          </Card>
          <Card title="Timeline">
            <dl className="kv">
              <dt>Created</dt>
              <dd>{fmtDateTime(a.created_at)}</dd>
              <dt>Acknowledged</dt>
              <dd>{a.acknowledged_at ? `${fmtDateTime(a.acknowledged_at)}${a.acknowledged_by ? ` · user #${a.acknowledged_by}` : ""}` : "–"}</dd>
              <dt>Resolved</dt>
              <dd>{a.resolved_at ? fmtDateTime(a.resolved_at) : "–"}</dd>
              <dt>Last update</dt>
              <dd>{fmtDateTime(a.updated_at)}</dd>
            </dl>
          </Card>
          <Card title="Delivery log" sub="Notifications sent for this alert" flush>
            {a.deliveries.length === 0 ? (
              <div className="card-body small muted">
                Not delivered to any channel. Alerts below “moderate” are in-app only unless a notification rule routes them. <Link to="/app/integrations">Configure integrations →</Link>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Status</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.deliveries.map((d, i) => (
                      <tr key={i}>
                        <td>
                          {d.name} <span className="tiny muted">{d.type}</span>
                        </td>
                        <td>{d.status === "ok" ? <Badge kind="ok">Delivered</Badge> : <span className="small bad-text">{d.status}</span>}</td>
                        <td className="small">{fmtDateTime(d.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
        <div className="detail-map" style={{ position: "sticky", top: 16 }}>
          {a.lat == null && !a.asset?.geometry ? (
            <div className="loading-block" style={{ height: "100%" }}>
              No location for this alert.
            </div>
          ) : (
            <MapView onReady={onReady} center={a.lon != null && a.lat != null ? [a.lon, a.lat] : undefined} zoom={9} ariaLabel="Alert location" />
          )}
        </div>
      </div>
    </div>
  );
}
