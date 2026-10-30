import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { alerts as alertsApi } from "../../api/endpoints";
import type { AlertDetail as AlertDetailT } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { IconChevronRight, IconMap } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, ButtonLink, Card, DangerPill, ErrorState, Loading, SeverityChip, Tile } from "../../components/ui";
import { compass, fmtCoord, fmtDateTime, fmtDayMonth, fmtHours, fmtKm, fmtNum, fmtPct, humanize, timeAgo } from "../../lib/format";
import { tEnum, useT } from "../../i18n";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { MapView } from "../../map/MapView";
import { addLayer, ensureSource, fitGeometry, setData } from "../../map/utils";

function DataTiles({ a }: { a: AlertDetailT }) {
  const { t } = useT();
  const d = a.data as Record<string, unknown>;
  const n = (k: string) => (d[k] == null ? null : Number(d[k]));
  if (a.type === "threat")
    return (
      <div className="grid-4">
        <Tile label={t("alert.likely")} value={fmtHours(n("eta_likely_h"))} accent="#ff4d5e" foot={t("alert.p50")} />
        <Tile label={t("alert.worst")} value={fmtHours(n("eta_p90_h"))} foot={t("alert.p90")} />
        <Tile label={t("alert.distance")} value={fmtKm(n("distance_km"))} foot={d.bearing_deg != null ? t("alert.bearing", { dir: compass(n("bearing_deg")), deg: String(d.bearing_deg) }) : undefined} />
        <Tile label={t("alert.incident")} value={<span className="mono" style={{ fontSize: 15 }}>{String(d.incident_id ?? "–")}</span>} />
      </div>
    );
  if (a.type === "risk")
    return (
      <div className="stack">
        <div className="grid-4">
          <Tile label={t("alert.worstDay")} value={d.date ? fmtDayMonth(String(d.date)) : "–"} />
          <Tile label="FWI" value={fmtNum(n("fwi"), 1)} />
          <Tile label={t("overview.col.danger")} value={d.danger ? <DangerPill danger={String(d.danger)} /> : "–"} />
          <Tile label={t("chart.ignition")} value={fmtPct(n("ignition_p"), 1)} />
        </div>
        {Array.isArray(d.days) && (
          <div className="row wrap" style={{ gap: 6 }}>
            {(d.days as { date: string; fwi: number; danger: string }[]).map((x) => (
              <DangerPill key={x.date} danger={x.danger}>
                {fmtDayMonth(x.date)} · {fmtNum(x.fwi)}
              </DangerPill>
            ))}
          </div>
        )}
      </div>
    );
  if (a.type === "detection")
    return (
      <div className="grid-4">
        <Tile label={t("stats.detections")} value={fmtNum(n("count"))} accent="#ff6a2b" />
        <Tile label={t("asset.popup.inside")} value={fmtNum(n("inside"))} />
        <Tile label={t("alert.nearest")} value={fmtKm(n("nearest_km"))} />
        <Tile label={t("alert.maxFrp")} value={fmtNum(n("max_frp"), 1)} unit="MW" foot={Array.isArray(d.sources) ? (d.sources as string[]).join(", ") : undefined} />
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
  const { t } = useT();
  const alert = useAsync(() => alertsApi.get(Number(id)), [id]);
  const [map, setMap] = useState<MlMap | null>(null);
  const [busy, setBusy] = useState(false);
  const a = alert.data;
  useDocumentTitle(a ? a.title : t("alert.doc"));

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
      toast.success(action === "ack" ? t("alert.acked") : action === "resolve" ? t("alert.resolved") : t("alert.reopened"));
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
  if (!a) return <Loading label={t("alert.loading")} />;
  const incidentId = (a.data as Record<string, unknown>).incident_id;

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/app/alerts">{t("nav.alerts")}</Link>
        <IconChevronRight size={12} />
        <span>#{a.id}</span>
      </div>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="row wrap">
            <SeverityChip severity={a.severity} />
            <Badge>{tEnum("alertType", a.type)}</Badge>
            <Badge kind={a.status === "open" ? "bad" : a.status === "acknowledged" ? "info" : undefined}>{tEnum("alertStatus", a.status)}</Badge>
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
                {t("alerts.ack")}
              </Button>
            )}
            {a.status !== "resolved" && (
              <Button loading={busy && a.status !== "open"} onClick={() => act("resolve")}>
                {t("alerts.resolve")}
              </Button>
            )}
            {a.status === "resolved" && (
              <Button loading={busy} onClick={() => act("reopen")}>
                {t("alerts.reopen")}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="detail-layout">
        <div className="stack loose">
          <Card title={t("alert.details")}>
            <div className="stack">
              {a.message && <p style={{ whiteSpace: "pre-wrap", color: "var(--text-2)" }}>{a.message}</p>}
              <DataTiles a={a} />
              <div className="row wrap">
                {typeof incidentId === "string" && (
                  <ButtonLink to={`/app/map?incident=${incidentId}`} icon={<IconMap />}>
                    {t("alert.openForecast")}
                  </ButtonLink>
                )}
                {a.lat != null && (
                  <ButtonLink to={`/app/map?lat=${a.lat}&lon=${a.lon}&zoom=11`} icon={<IconMap />} variant="ghost">
                    {t("alert.viewMap")}
                  </ButtonLink>
                )}
              </div>
            </div>
          </Card>
          <Card title={t("alert.timeline")}>
            <dl className="kv">
              <dt>{t("alert.created")}</dt>
              <dd>{fmtDateTime(a.created_at)}</dd>
              <dt>{t("alertStatus.acknowledged")}</dt>
              <dd>{a.acknowledged_at ? `${fmtDateTime(a.acknowledged_at)}${a.acknowledged_by ? ` · ${t("alert.user", { id: a.acknowledged_by })}` : ""}` : "–"}</dd>
              <dt>{t("alertStatus.resolved")}</dt>
              <dd>{a.resolved_at ? fmtDateTime(a.resolved_at) : "–"}</dd>
              <dt>{t("alert.lastUpdate")}</dt>
              <dd>{fmtDateTime(a.updated_at)}</dd>
            </dl>
          </Card>
          <Card title={t("alert.deliveryLog")} sub={t("alert.deliverySub")} flush>
            {a.deliveries.length === 0 ? (
              <div className="card-body small muted">
                {t("alert.notDelivered")} <Link to="/app/integrations">{t("alert.configure")}</Link>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>{t("alert.channel")}</th>
                      <th>{t("alerts.status")}</th>
                      <th>{t("alert.time")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.deliveries.map((d, i) => (
                      <tr key={i}>
                        <td>
                          {d.name} <span className="tiny muted">{d.type}</span>
                        </td>
                        <td>{d.status === "ok" ? <Badge kind="ok">{t("alert.deliveredBadge")}</Badge> : <span className="small bad-text">{d.status}</span>}</td>
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
              {t("alert.noLocation")}
            </div>
          ) : (
            <MapView onReady={onReady} center={a.lon != null && a.lat != null ? [a.lon, a.lat] : undefined} zoom={9} ariaLabel={t("alert.location")} />
          )}
        </div>
      </div>
    </div>
  );
}
