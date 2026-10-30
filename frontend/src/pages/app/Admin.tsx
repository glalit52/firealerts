import { useState } from "react";
import { admin } from "../../api/endpoints";
import type { AdminOrg } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { IconSearch } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Card, ErrorState, Input, Loading, Select, Tabs, Tile } from "../../components/ui";
import { fmtCompact, fmtDate, fmtNum, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { useT } from "../../i18n";

export default function Admin() {
  const { t } = useT();
  useDocumentTitle(t("nav.admin"));
  const { meta } = useAuth();
  const toast = useToast();
  const stats = useAsync(() => admin.stats(), []);
  const [tab, setTab] = useState<"orgs" | "users">("orgs");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const orgs = useAsync(() => admin.orgs(query), [query], { enabled: tab === "orgs" });
  const users = useAsync(() => admin.users(query), [query], { enabled: tab === "users" });
  const s = stats.data;

  const setPlan = async (o: AdminOrg, plan: string) => {
    try {
      const r = await admin.setPlan(o.id, plan);
      orgs.setData((xs) => (xs ?? []).map((x) => (x.id === o.id ? { ...x, plan: r.plan } : x)));
      toast.success(t("admin.planSet", { org: o.name, plan: meta?.plans[plan]?.label ?? plan }));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.admin")}</h1>
          <p>{t("admin.lead")}</p>
        </div>
      </div>
      {stats.error ? (
        <ErrorState error={stats.error} onRetry={stats.reload} />
      ) : !s ? (
        <Loading />
      ) : (
        <div className="tiles mb-16">
          <Tile label={t("shell.orgs")} value={fmtNum(s.organizations)} foot={Object.entries(s.plans).map(([k, v]) => `${v} ${k}`).join(" · ")} />
          <Tile label={t("admin.users")} value={fmtNum(s.users)} foot={t("admin.active7", { n: fmtNum(s.users_active_7d) })} />
          <Tile label={t("live.tab.assets")} value={fmtNum(s.assets)} foot={t("assets.monitored", { ha: fmtCompact(s.monitored_ha) })} />
          <Tile label={t("admin.connectors")} value={fmtNum(s.connectors)} />
          <Tile label={t("admin.alerts24")} value={fmtNum(s.alerts_24h)} />
          <Tile label={t("landing.stat.detections")} value={fmtCompact(s.detections_24h)} foot={t("admin.stored", { n: fmtCompact(s.detections_total) })} />
          <Tile label={t("data.lastIngest")} value={s.last_ingest ? timeAgo(s.last_ingest.finished_at) : t("common.never")} foot={s.last_ingest ? t("admin.newCount", { mode: s.last_ingest.mode, n: fmtNum(s.last_ingest.inserted) }) : undefined} />
        </div>
      )}
      <Card flush>
        <div style={{ padding: "0 12px" }}>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: "orgs", label: t("shell.orgs") }, { id: "users", label: t("admin.users") }]} label={t("admin.lists")} />
        </div>
        <form
          className="filters"
          style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q);
          }}
        >
          <div className="search-box" style={{ width: 280, maxWidth: "100%" }}>
            <IconSearch size={14} />
            <Input inputSize="sm" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "orgs" ? t("admin.searchOrgs") : t("admin.searchEmail")} aria-label={t("admin.search")} onBlur={() => setQuery(q)} />
          </div>
        </form>
        {tab === "orgs" ? (
          orgs.error ? <div className="card-body"><ErrorState error={orgs.error} onRetry={orgs.reload} /></div> : !orgs.data ? <Loading /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>ID</th><th>{t("common.name")}</th><th className="right">{t("admin.members")}</th><th className="right">{t("live.tab.assets")}</th><th>{t("alert.created")}</th><th>{t("admin.plan")}</th></tr></thead>
                <tbody>
                  {orgs.data.map((o) => (
                    <tr key={o.id}>
                      <td className="muted">{o.id}</td>
                      <td className="strong">{o.name}</td>
                      <td className="right">{o.members}</td>
                      <td className="right">{o.assets}</td>
                      <td className="small">{fmtDate(o.created_at)}</td>
                      <td>
                        <Select inputSize="sm" value={o.plan} onChange={(e) => setPlan(o, e.target.value)} aria-label={t("admin.planFor", { org: o.name })} style={{ width: 140 }}>
                          {Object.entries(meta?.plans ?? {}).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : users.error ? <div className="card-body"><ErrorState error={users.error} onRetry={users.reload} /></div> : !users.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>ID</th><th>{t("admin.user")}</th><th>{t("alerts.status")}</th><th>{t("alert.created")}</th><th>{t("admin.lastSignIn")}</th></tr></thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td className="muted">{u.id}</td>
                    <td><div className="strong">{u.name || u.email}</div><div className="tiny muted">{u.email}</div></td>
                    <td className="row wrap" style={{ gap: 4 }}>
                      {u.email_verified ? <Badge kind="ok">{t("profile.verified").toLowerCase()}</Badge> : <Badge kind="warn">{t("profile.unverified").toLowerCase()}</Badge>}
                      {u.is_superuser && <Badge kind="accent">{t("shell.superuser")}</Badge>}
                    </td>
                    <td className="small">{fmtDate(u.created_at)}</td>
                    <td className="small muted">{u.last_login_at ? timeAgo(u.last_login_at) : t("common.never")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
