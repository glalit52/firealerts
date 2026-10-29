import { useState } from "react";
import { data as dataApi, system } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { IconDownload, IconExternal, IconRefresh } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, ErrorState, Loading, Select, Tile } from "../../components/ui";
import { fmtDateTime, fmtNum, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";

function statusBadge(s: string) {
  if (s === "ok") return <Badge kind="ok" dot>Receiving</Badge>;
  if (s === "available") return <Badge kind="info" dot>On demand</Badge>;
  if (s === "error") return <Badge kind="bad" dot>Error</Badge>;
  if (s === "disabled") return <Badge dot>Not configured</Badge>;
  if (s === "idle") return <Badge kind="warn" dot>No data last sync</Badge>;
  return <Badge>{s}</Badge>;
}

export default function DataPage() {
  useDocumentTitle("Data");
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
      toast.error(e, "Download failed");
    } finally {
      setBusy(null);
    }
  };

  const ingest = async () => {
    setBusy("ingest");
    try {
      const r = await system.ingest();
      toast.success(`Sync complete: fetched ${fmtNum(r.fetched)}, ${fmtNum(r.inserted)} new detections${r.alerts ? `, ${r.alerts} alerts` : ""}.`);
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
          <h1>Data</h1>
          <p>Public Earth-observation sources behind Firealerts, exports of your data and storage usage.</p>
        </div>
        {can("admin") && (
          <Button variant="primary" icon={<IconRefresh />} loading={busy === "ingest"} onClick={ingest}>
            Ingest now
          </Button>
        )}
      </div>

      <div className="detail-layout overview-layout">
        <Card
          title="Data sources"
          sub={last ? `Last sync ${timeAgo(last.finished_at)} · ${last.mode} mode · fetched ${fmtNum(last.fetched)}, inserted ${fmtNum(last.inserted)}` : "No sync yet"}
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
                      {s.coverage} · {s.cadence} · access: {s.auth}
                      {s.last_count != null && ` · ${fmtNum(s.last_count)} in last sync`}
                    </div>
                  </div>
                  <div className="row">
                    {statusBadge(s.status)}
                    <a className="btn sm ghost icon" href={s.url} target="_blank" rel="noreferrer" aria-label={`${s.name} website`} title="Source website">
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
                Errors in last sync
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
          <Card title="Downloads" sub="Exports use your current organisation and permissions">
            <div className="stack">
              <div>
                <div className="row between wrap">
                  <span className="strong small">Fire detections</span>
                  <Select inputSize="sm" style={{ width: 130 }} value={hours} onChange={(e) => setHours(+e.target.value)} aria-label="Detections period">
                    {[6, 24, 48, 72, 168, 336, 744].map((h) => (
                      <option key={h} value={h}>
                        Last {h < 48 ? `${h} h` : `${h / 24} days`}
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
                <div className="tiny muted mt-4">All platform detections (global), up to 100,000 rows.</div>
              </div>
              <hr className="divider" style={{ margin: "4px 0" }} />
              <div>
                <span className="strong small">Alerts</span>
                <div className="row wrap mt-8">
                  <Button size="sm" icon={<IconDownload />} loading={busy === "alerts"} onClick={() => dl("alerts", () => dataApi.exportAlerts(365))}>
                    CSV · last year
                  </Button>
                </div>
              </div>
              <hr className="divider" style={{ margin: "4px 0" }} />
              <div>
                <span className="strong small">Assets</span>
                <div className="row wrap mt-8">
                  {(["geojson", "kml", "csv"] as const).map((f) => (
                    <Button key={f} size="sm" icon={<IconDownload />} loading={busy === `as-${f}`} onClick={() => dl(`as-${f}`, () => dataApi.exportAssets(f))}>
                      {f.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <div className="tiny muted mt-4">Per-asset vegetation and risk time series are on each asset's page.</div>
              </div>
            </div>
          </Card>

          <Card title="Storage usage">
            {usage.error ? (
              <ErrorState error={usage.error} onRetry={usage.reload} />
            ) : !usage.data ? (
              <Loading />
            ) : (
              <div className="grid-2" style={{ gap: 10 }}>
                <Tile compact label="Assets" value={fmtNum(usage.data.assets)} />
                <Tile compact label="Alerts" value={fmtNum(usage.data.alerts)} />
                <Tile compact label="Vegetation observations" value={fmtNum(usage.data.observations)} />
                <Tile compact label="Risk snapshots" value={fmtNum(usage.data.risk_snapshots)} />
                <Tile compact label="Platform detections" value={fmtNum(usage.data.platform_detections)} foot="shared across all organisations" />
                {last && <Tile compact label="Last ingest" value={timeAgo(last.finished_at)} foot={fmtDateTime(last.finished_at)} />}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
