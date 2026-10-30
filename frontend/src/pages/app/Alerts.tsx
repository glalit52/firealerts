import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { alerts as alertsApi, assets as assetsApi, data as dataApi } from "../../api/endpoints";
import type { AlertQuery } from "../../api/endpoints";
import type { Alert } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { IconBell, IconDownload } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Pagination, Select, SeverityChip, Tabs } from "../../components/ui";
import { fmtDateTime, fmtHours, fmtKm, fmtNum, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { t as tr, tEnum, useT } from "../../i18n";

const LIMIT = 25;

export function alertSummary(a: Alert): string {
  const d = a.data as Record<string, number | string | undefined>;
  if (a.type === "threat" && d.eta_likely_h != null) return `ETA ~${fmtHours(Number(d.eta_likely_h))}${d.eta_p90_h != null ? ` (P90 ${fmtHours(Number(d.eta_p90_h))})` : ""} · ${fmtKm(Number(d.distance_km))}`;
  if (a.type === "risk" && d.fwi != null) return `FWI ${fmtNum(Number(d.fwi))} · ${tEnum("danger", String(d.danger))}${d.date ? ` · ${tr("alerts.onDate", { date: String(d.date) })}` : ""}`;
  if (a.type === "detection" && d.count != null)
    return `${tr("stats.tooltip", { count: Number(d.count) })}${d.inside ? ` · ${tr("alerts.inside", { n: Number(d.inside) })}` : ""}${d.nearest_km != null ? ` · ${tr("alerts.nearest", { km: fmtKm(Number(d.nearest_km)) })}` : ""}`;
  return a.message.slice(0, 120);
}

export default function Alerts() {
  const { t } = useT();
  useDocumentTitle(t("nav.alerts"));
  const { meta, can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") || "active") as AlertQuery["status"];
  const type = params.get("type") || "";
  const severity = params.get("severity") || "";
  const assetId = params.get("asset_id") ? Number(params.get("asset_id")) : undefined;
  const days = Number(params.get("days")) || 30;
  const offset = Number(params.get("offset")) || 0;
  const [busy, setBusy] = useState<number | null>(null);

  const q: AlertQuery = { status, type: type || undefined, severity: severity || undefined, asset_id: assetId, days, limit: LIMIT, offset };
  const list = useAsync(() => alertsApi.list(q), [status, type, severity, assetId, days, offset]);
  const stats = useAsync(() => alertsApi.stats(Math.min(365, days)), [days]);
  const assets = useAsync(() => assetsApi.list(), []);

  const setParam = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === "" || v === null) params.delete(k);
    else params.set(k, String(v));
    if (k !== "offset") params.delete("offset");
    setParams(params, { replace: true });
  };

  const severityOptions = useMemo(() => {
    const sev = meta?.severities ?? ["info", "low", "moderate", "high", "critical"];
    return [{ value: "", label: t("alerts.anySeverity") }, ...sev.map((s, i) => ({ value: sev.slice(i).join(","), label: `${tEnum("severityName", s)}${i < sev.length - 1 ? " +" : ""}` }))];
  }, [meta, t]);

  const act = async (a: Alert, action: "ack" | "resolve" | "reopen") => {
    setBusy(a.id);
    try {
      const r = await alertsApi[action](a.id);
      list.setData((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === a.id ? { ...x, ...r } : x)) } : prev!));
      window.dispatchEvent(new Event("fa:alerts-changed"));
      void stats.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const bs = stats.data?.by_status ?? {};
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.alerts")}</h1>
          <p>{t("alerts.lead")}</p>
        </div>
        <Button icon={<IconDownload />} onClick={() => dataApi.exportAlerts(Math.max(days, 90)).catch((e) => toast.error(e))}>
          {t("alerts.export")}
        </Button>
      </div>

      <Card flush>
        <div style={{ padding: "0 12px" }}>
          <Tabs
            value={status ?? "active"}
            onChange={(v) => setParam("status", v)}
            label={t("alerts.status")}
            tabs={[
              { id: "active", label: t("alertStatus.active"), count: (bs.open ?? 0) + (bs.acknowledged ?? 0) },
              { id: "open", label: t("alertStatus.open"), count: bs.open ?? 0 },
              { id: "acknowledged", label: t("alertStatus.acknowledged"), count: bs.acknowledged ?? 0 },
              { id: "resolved", label: t("alertStatus.resolved"), count: bs.resolved ?? 0 },
            ]}
          />
        </div>
        <div className="filters" style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}>
          <Select inputSize="sm" value={type} onChange={(e) => setParam("type", e.target.value)} aria-label={t("alerts.type")}>
            <option value="">{t("alerts.allTypes")}</option>
            {(meta?.alert_types ?? ["detection", "threat", "risk", "system"]).map((x) => (
              <option key={x} value={x}>
                {tEnum("alertType", x)}
              </option>
            ))}
          </Select>
          <Select inputSize="sm" value={severity} onChange={(e) => setParam("severity", e.target.value)} aria-label={t("alerts.severity")} options={severityOptions} />
          <Select inputSize="sm" value={assetId ?? ""} onChange={(e) => setParam("asset_id", e.target.value)} aria-label={t("overview.col.asset")}>
            <option value="">{t("alerts.allAssets")}</option>
            {(assets.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select inputSize="sm" value={days} onChange={(e) => setParam("days", e.target.value)} aria-label={t("alerts.period")}>
            {[1, 7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? t("common.lastHours", { n: 24 }) : t("common.lastDays", { n: d })}
              </option>
            ))}
          </Select>
          {(type || severity || assetId) && (
            <Button size="sm" variant="ghost" onClick={() => setParams(status ? { status } : {}, { replace: true })}>
              {t("alerts.clear")}
            </Button>
          )}
          <div className="grow" />
          {list.data && <span className="small muted">{t("alerts.count", { count: list.data.total })}</span>}
        </div>
        {list.error ? (
          <div className="card-body">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <Loading label={t("alerts.loading")} />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={<IconBell size={20} />} title={status === "resolved" ? t("alerts.noResolved") : t("alerts.noMatch")}>
            {status === "active" && !type && !severity && !assetId ? t("alerts.allClear") : t("alerts.widen")}
          </EmptyState>
        ) : (
          <>
            <div>
              {list.data.items.map((a) => (
                <div key={a.id} className={`alert-row ${a.status === "resolved" ? "resolved" : ""}`}>
                  <div>
                    <SeverityChip severity={a.severity} />
                    <div className="tiny muted mt-4">{tEnum("alertType", a.type)}</div>
                  </div>
                  <Link to={`/app/alerts/${a.id}`} style={{ color: "var(--text)", minWidth: 0 }}>
                    <div className="title truncate">{a.title}</div>
                    <div className="small muted truncate">
                      {a.asset_name && <>{a.asset_name} · </>}
                      {alertSummary(a)}
                    </div>
                    <div className="tiny faint" title={fmtDateTime(a.created_at)}>
                      {timeAgo(a.created_at)}
                      {a.deliveries.length > 0 && ` · ${t("alerts.delivered", { count: a.deliveries.length })}`}
                    </div>
                  </Link>
                  <div className="row right" style={{ justifyContent: "flex-end" }}>
                    {a.status === "acknowledged" && <Badge kind="info">{t("alertStatus.acknowledged")}</Badge>}
                    {a.status === "resolved" && <Badge>{t("alertStatus.resolved")}</Badge>}
                    {can("member") && a.status === "open" && (
                      <Button size="sm" loading={busy === a.id} onClick={() => act(a, "ack")}>
                        {t("alerts.ack")}
                      </Button>
                    )}
                    {can("member") && a.status !== "resolved" && (
                      <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => act(a, "resolve")}>
                        {t("alerts.resolve")}
                      </Button>
                    )}
                    {can("member") && a.status === "resolved" && (
                      <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => act(a, "reopen")}>
                        {t("alerts.reopen")}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={(o) => setParam("offset", o || undefined)} />
          </>
        )}
      </Card>
    </div>
  );
}
