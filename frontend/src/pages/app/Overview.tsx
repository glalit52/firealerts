import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { alerts as alertsApi, assets as assetsApi, fire, system } from "../../api/endpoints";
import type { AssetListItem, DetectionCollection } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { BarChart } from "../../components/charts";
import { IconMap, IconPlus, IconTree } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, ButtonLink, Card, DangerPill, EmptyState, ErrorState, Loading, SeverityChip, Tile } from "../../components/ui";
import { SENSOR_GROUPS, SEVERITY_COLORS, SEVERITY_ORDER } from "../../lib/constants";
import { fmtCompact, fmtDayMonth, fmtHa, fmtNum, fmtPct, timeAgo } from "../../lib/format";
import { syncMessage } from "../../lib/sync";
import { destination } from "../../lib/geo";
import { useAsync, useBusy, useDocumentTitle } from "../../lib/useAsync";
import { tEnum, useT } from "../../i18n";

/** Count detections within each asset's threat radius (bbox-expanded, then point-to-centroid sanity). */
function firesNear(assets: AssetListItem[], dets: DetectionCollection | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!dets) return out;
  for (const a of assets) {
    if (!a.bbox?.length) continue;
    const r = Math.max(a.buffer_km, a.threat_radius_km);
    const [w, s, e, n] = a.bbox;
    const sw = destination([w, s], 225, r * Math.SQRT2);
    const ne = destination([e, n], 45, r * Math.SQRT2);
    let c = 0;
    for (const f of dets.features) {
      const [x, y] = f.geometry.coordinates as [number, number];
      if (x >= sw[0] && x <= ne[0] && y >= sw[1] && y <= ne[1]) c++;
    }
    out.set(a.id, c);
  }
  return out;
}

export default function Overview() {
  const { t, locale } = useT();
  useDocumentTitle(t("nav.overview"));
  const { me, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { busy, run } = useBusy();
  const assets = useAsync(() => assetsApi.list(), []);
  const stats = useAsync(() => alertsApi.stats(30), []);
  const active = useAsync(() => alertsApi.list({ status: "active", limit: 500, days: 365 }), []);
  const latest = useAsync(() => alertsApi.list({ limit: 6 }), []);
  const status = useAsync(() => system.status(), []);
  const dets = useAsync(() => fire.detections({ hours: 24 }), []);

  const totalHa = (assets.data ?? []).reduce((a, x) => a + x.area_ha, 0);
  const openBySev = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of active.data?.items ?? []) m[a.severity] = (m[a.severity] ?? 0) + 1;
    return m;
  }, [active.data]);
  const near = useMemo(() => firesNear(assets.data ?? [], dets.data), [assets.data, dets.data]);
  const nearTotal = [...near.values()].reduce((a, b) => a + b, 0);
  const assetsNear = [...near.values()].filter((v) => v > 0).length;

  const ingest = () =>
    run("ingest", async () => {
      try {
        const r = await system.ingest();
        toast.success(syncMessage(r));
        await Promise.all([status.reload(), dets.reload(), assets.reload(), latest.reload(), stats.reload(), active.reload()]);
        window.dispatchEvent(new Event("fa:alerts-changed"));
      } catch (err) {
        toast.error(err);
      }
    });

  const daily = useMemo(() => {
    const byDate = new Map((stats.data?.daily ?? []).map((d) => [d.date, d.count]));
    const out = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      out.push({ label: d, value: byDate.get(d) ?? 0 });
    }
    return out;
  }, [stats.data]);

  const groups = useMemo(() => {
    const s = status.data?.by_source_24h ?? {};
    return SENSOR_GROUPS.map((g) => ({ id: g.id, label: g.label, count: Object.entries(s).filter(([k]) => g.match(k)).reduce((a, [, v]) => a + v, 0) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data, locale]);
  const lastRun = status.data?.runs[0];
  const noAssets = assets.data && assets.data.length === 0;
  const greeting = me?.user?.name ? t("overview.welcome", { name: me.user.name.split(" ")[0] }) : t("nav.overview");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting}</h1>
          <p>
            {me?.org?.name} · {t("overview.worldwide", { n: fmtNum(status.data?.detections_24h) })}
            {status.data?.latest_detection ? ` · ${t("overview.latest", { ago: timeAgo(status.data.latest_detection) })}` : ""}
          </p>
        </div>
        <div className="row wrap">
          {can("admin") && (
            <Button loading={busy === "ingest"} onClick={ingest} title={t("sync.title")}>
              {t("sync.now")}
            </Button>
          )}
          <ButtonLink to="/app/map" icon={<IconMap />}>
            {t("nav.map")}
          </ButtonLink>
          {can("member") && (
            <ButtonLink to="/app/assets?new=1" variant="primary" icon={<IconPlus />}>
              {t("assets.add")}
            </ButtonLink>
          )}
        </div>
      </div>

      <div className="grid-4 mb-16">
        <Tile label={t("overview.assetsMonitored")} value={assets.data ? fmtNum(assets.data.length) : "…"} foot={me?.org?.limits?.assets != null ? t("overview.ofPlan", { n: me.org.limits.assets }) : t("overview.unlimitedPlan")} to="/app/assets" accent="#5aa9ff" />
        <Tile label={t("overview.areaProtected")} value={assets.data ? fmtCompact(totalHa) : "…"} unit="ha" foot={`${fmtNum((totalHa / 100) | 0)} km²`} accent="#3ecf8e" />
        <Tile
          label={t("overview.openAlerts")}
          value={active.data ? fmtNum(active.data.total) : "…"}
          to="/app/alerts?status=active"
          accent={openBySev.critical ? SEVERITY_COLORS.critical : openBySev.high ? SEVERITY_COLORS.high : "#ffd84d"}
          foot={
            <span className="row wrap" style={{ gap: 6 }}>
              {SEVERITY_ORDER.slice()
                .reverse()
                .filter((s) => openBySev[s])
                .map((s) => (
                  <span key={s} className="row" style={{ gap: 4 }}>
                    <span className="status-dot" style={{ background: SEVERITY_COLORS[s] }} />
                    {openBySev[s]} {tEnum("severity", s)}
                  </span>
                ))}
              {active.data && !active.data.total && t("overview.allClear")}
            </span>
          }
        />
        <Tile label={t("overview.firesNear")} value={dets.data && assets.data ? fmtNum(nearTotal) : "…"} foot={t("overview.assetsNear", { count: assetsNear })} accent="#ff6a2b" />
      </div>

      {noAssets && (
        <Card className="mb-16">
          <EmptyState
            icon={<IconTree size={20} />}
            title={t("overview.firstForest")}
            action={
              can("member") ? (
                <ButtonLink to="/app/assets?new=1" variant="primary" icon={<IconPlus />}>
                  {t("overview.drawOrUpload")}
                </ButtonLink>
              ) : undefined
            }
          >
            {t("overview.firstForestBody")}
          </EmptyState>
        </Card>
      )}

      <div className="detail-layout overview-layout">
        <div className="stack loose">
          <Card title={t("overview.byRisk")} sub={t("overview.byRiskSub")} flush actions={<Link to="/app/assets" className="small">{t("overview.allAssets")}</Link>}>
            {assets.error ? (
              <div className="card-body"><ErrorState error={assets.error} onRetry={assets.reload} /></div>
            ) : !assets.data ? (
              <Loading />
            ) : assets.data.length === 0 ? (
              <div className="card-body muted small">{t("assets.noneYet")}</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("overview.col.asset")}</th>
                      <th>{t("overview.col.danger")}</th>
                      <th className="right">FWI</th>
                      <th className="right">{t("overview.col.ignition")}</th>
                      <th className="right">{t("overview.col.fires")}</th>
                      <th className="right">{t("nav.alerts")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...assets.data]
                      .sort((a, b) => (b.risk_today?.fwi ?? -1) - (a.risk_today?.fwi ?? -1))
                      .slice(0, 10)
                      .map((a) => (
                        <tr key={a.id} className="clickable" onClick={() => navigate(`/app/assets/${a.id}`)}>
                          <td>
                            <Link to={`/app/assets/${a.id}`} className="strong" style={{ color: "var(--text)" }} onClick={(e) => e.stopPropagation()}>
                              {a.name}
                            </Link>
                            <div className="tiny muted">
                              {tEnum("kind", a.kind)} · {fmtHa(a.area_ha)}
                            </div>
                          </td>
                          <td>{a.risk_today ? <DangerPill danger={a.risk_today.danger} /> : <span className="muted small">{t("overview.pending")}</span>}</td>
                          <td className="right">{fmtNum(a.risk_today?.fwi, 0)}</td>
                          <td className="right">{fmtPct(a.risk_today?.ignition_p, 0)}</td>
                          <td className="right">{near.get(a.id) ? <b style={{ color: "var(--accent)" }}>{near.get(a.id)}</b> : <span className="muted">0</span>}</td>
                          <td className="right">{a.open_alerts ? <Badge kind="bad">{a.open_alerts}</Badge> : <span className="muted">0</span>}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={t("overview.perDay")} sub={t("overview.perDaySub", { n: fmtNum(stats.data ? Object.values(stats.data.by_type).reduce((a, b) => a + b, 0) : 0) })}>
            {stats.data ? (
              <>
                <BarChart data={daily} height={150} ariaLabel={t("overview.perDayAria")} formatLabel={(l) => fmtDayMonth(l)} />
                <div className="row wrap mt-12" style={{ gap: 14 }}>
                  {Object.entries(stats.data.by_type)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <span key={k} className="small muted">
                        {tEnum("alertType", k)} <b style={{ color: "var(--text)" }}>{v}</b>
                      </span>
                    ))}
                </div>
              </>
            ) : stats.error ? (
              <ErrorState error={stats.error} onRetry={stats.reload} />
            ) : (
              <Loading />
            )}
          </Card>
        </div>

        <div className="stack loose">
          <Card title={t("overview.latestAlerts")} flush actions={<Link to="/app/alerts" className="small">{t("overview.inbox")}</Link>}>
            {!latest.data ? (
              <Loading />
            ) : latest.data.items.length === 0 ? (
              <EmptyState title={t("overview.noAlerts")}>{t("overview.noAlertsBody")}</EmptyState>
            ) : (
              <div className="list-rows">
                {latest.data.items.map((a) => (
                  <Link key={a.id} to={`/app/alerts/${a.id}`} style={{ display: "block", color: "var(--text)" }}>
                    <div className="row between">
                      <SeverityChip severity={a.severity} />
                      <span className="tiny muted">{timeAgo(a.created_at)}</span>
                    </div>
                    <div className="strong small mt-4 truncate">{a.title}</div>
                    <div className="tiny muted truncate">
                      {tEnum("alertType", a.type)}
                      {a.asset_name ? ` · ${a.asset_name}` : ""} · {tEnum("alertStatus", a.status).toLowerCase()}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card title={t("overview.feeds")} sub={lastRun ? t("overview.feedsSub", { ago: timeAgo(lastRun.finished_at), mode: lastRun.mode, n: status.data?.poll_minutes ?? "" }) : t("overview.noSync")} actions={<Link to="/app/data" className="small">{t("overview.sources")}</Link>}>
            {status.data ? (
              <div className="stack tight">
                {groups.map((g) => (
                  <div key={g.id} className="row between small">
                    <span className="row">
                      <span className={`status-dot ${g.count ? "ok" : "idle"}`} />
                      {g.label}
                    </span>
                    <span className="num">{fmtNum(g.count)} <span className="muted">/ 24 h</span></span>
                  </div>
                ))}
                {lastRun?.errors?.length ? (
                  <div className="notice warn small mt-8">
                    {lastRun.errors.slice(0, 3).join(" · ")}
                  </div>
                ) : null}
                {!lastRun && can("admin") && (
                  <Button className="mt-8" variant="primary" loading={busy === "ingest"} onClick={ingest}>
                    {t("sync.first")}
                  </Button>
                )}
              </div>
            ) : (
              <Loading />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
