import { useState } from "react";
import { data as dataApi, system } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { IconDownload, IconExternal, IconRefresh } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, ErrorState, Loading, Select, Tile } from "../../components/ui";
import { fmtDateTime, fmtNum, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { syncMessage } from "../../lib/sync";
import { t as tr, useT } from "../../i18n";

function statusBadge(s: string) {
  if (s === "ok") return <Badge kind="ok" dot>{tr("data.status.ok")}</Badge>;
  if (s === "available") return <Badge kind="info" dot>{tr("data.status.available")}</Badge>;
  if (s === "error") return <Badge kind="bad" dot>{tr("data.status.error")}</Badge>;
  if (s === "disabled") return <Badge dot>{tr("data.status.disabled")}</Badge>;
  if (s === "idle") return <Badge kind="warn" dot>{tr("data.status.idle")}</Badge>;
  return <Badge>{s}</Badge>;
}

export default function DataPage() {
  const { t } = useT();
  useDocumentTitle(t("nav.data"));
  const { can } = useAuth();
  const toast = useToast();
  const sources = useAsync(() => system.sources(), []);
  const usage = useAsync(() => dataApi.usage(), []);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);

  const dl = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e, t("data.downloadFailed"));
    } finally {
      setBusy(null);
    }
  };

  const ingest = async () => {
    setBusy("ingest");
    try {
      const r = await system.ingest();
      toast.success(syncMessage(r, true));
      await Promise.all([sources.reload(), usage.reload()]);
      window.dispatchEvent(new Event("fa:alerts-changed"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const last = sources.data?.last_ingest;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.data")}</h1>
          <p>{t("data.lead")}</p>
        </div>
        {can("admin") && (
          <Button variant="primary" icon={<IconRefresh />} loading={busy === "ingest"} onClick={ingest}>
            {t("data.ingest")}
          </Button>
        )}
      </div>

      <div className="detail-layout overview-layout">
        <Card
          title={t("integ.sources")}
          sub={last ? t("data.sub", { ago: timeAgo(last.finished_at), mode: last.mode, fetched: fmtNum(last.fetched), inserted: fmtNum(last.inserted) }) : t("overview.noSync")}
          flush
        >
          {sources.error ? (
            <div className="card-body">
              <ErrorState error={sources.error} onRetry={sources.reload} />
            </div>
          ) : !sources.data ? (
            <Loading />
          ) : (
            <div>
              {sources.data.sources.map((s) => (
                <div key={s.id} className="source-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="row wrap">
                      <span className="strong">{s.name}</span>
                      <span className="chip">{s.kind}</span>
                    </div>
                    <div className="small muted mt-4">
                      {s.coverage} · {s.cadence} · {t("data.access", { auth: s.auth })}
                      {s.last_count != null && ` · ${t("data.inLast", { n: fmtNum(s.last_count) })}`}
                    </div>
                  </div>
                  <div className="row">
                    {statusBadge(s.status)}
                    <a className="btn sm ghost icon" href={s.url} target="_blank" rel="noreferrer" aria-label={t("data.website", { name: s.name })} title={t("data.sourceWebsite")}>
                      <IconExternal />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          {last?.errors?.length ? (
            <div className="card-body" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="section-title" style={{ marginTop: 0 }}>
                {t("data.errors")}
              </div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {last.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <div className="stack loose">
          <Card title={t("data.downloads")} sub={t("data.downloadsSub")}>
            <div className="stack">
              <div>
                <div className="row between wrap">
                  <span className="strong small">{t("data.detections")}</span>
                  <Select inputSize="sm" style={{ width: 140 }} value={hours} onChange={(e) => setHours(+e.target.value)} aria-label={t("data.period")}>
                    {[6, 24, 48, 72, 168, 336, 744].map((h) => (
                      <option key={h} value={h}>
                        {h < 48 ? t("common.lastHours", { n: h }) : t("common.lastDays", { n: h / 24 })}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="row wrap mt-8">
                  {(["csv", "geojson", "kml"] as const).map((f) => (
                    <Button key={f} size="sm" icon={<IconDownload />} loading={busy === `det-${f}`} onClick={() => dl(`det-${f}`, () => dataApi.exportDetections(f, hours))}>
                      {f.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <div className="tiny muted mt-4">{t("data.detNote")}</div>
              </div>
              <hr className="divider" style={{ margin: "4px 0" }} />
              <div>
                <span className="strong small">{t("nav.alerts")}</span>
                <div className="row wrap mt-8">
                  <Button size="sm" icon={<IconDownload />} loading={busy === "alerts"} onClick={() => dl("alerts", () => dataApi.exportAlerts(365))}>
                    {t("data.csvYear")}
                  </Button>
                </div>
              </div>
              <hr className="divider" style={{ margin: "4px 0" }} />
              <div>
                <span className="strong small">{t("live.tab.assets")}</span>
                <div className="row wrap mt-8">
                  {(["geojson", "kml", "csv"] as const).map((f) => (
                    <Button key={f} size="sm" icon={<IconDownload />} loading={busy === `as-${f}`} onClick={() => dl(`as-${f}`, () => dataApi.exportAssets(f))}>
                      {f.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <div className="tiny muted mt-4">{t("data.assetNote")}</div>
              </div>
            </div>
          </Card>

          <Card title={t("data.storage")}>
            {usage.error ? (
              <ErrorState error={usage.error} onRetry={usage.reload} />
            ) : !usage.data ? (
              <Loading />
            ) : (
              <div className="grid-2" style={{ gap: 10 }}>
                <Tile compact label={t("live.tab.assets")} value={fmtNum(usage.data.assets)} />
                <Tile compact label={t("nav.alerts")} value={fmtNum(usage.data.alerts)} />
                <Tile compact label={t("data.obs")} value={fmtNum(usage.data.observations)} />
                <Tile compact label={t("data.snapshots")} value={fmtNum(usage.data.risk_snapshots)} />
                <Tile compact label={t("data.platformDets")} value={fmtNum(usage.data.platform_detections)} foot={t("data.shared")} />
                {last && <Tile compact label={t("data.lastIngest")} value={timeAgo(last.finished_at)} foot={fmtDateTime(last.finished_at)} />}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
