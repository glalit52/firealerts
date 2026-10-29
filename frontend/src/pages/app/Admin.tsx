import { useState } from "react";
import { admin } from "../../api/endpoints";
import type { AdminOrg } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { IconSearch } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Card, ErrorState, Input, Loading, Select, Tabs, Tile } from "../../components/ui";
import { fmtCompact, fmtDate, fmtNum, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";

export default function Admin() {
  useDocumentTitle("Platform admin");
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
      toast.success(`${o.name} is now on ${meta?.plans[plan]?.label ?? plan}.`);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Platform admin</h1>
          <p>All organisations and users on this Firealerts installation.</p>
        </div>
      </div>
      {stats.error ? (
        <ErrorState error={stats.error} onRetry={stats.reload} />
      ) : !s ? (
        <Loading />
      ) : (
        <div className="tiles mb-16">
          <Tile label="Organisations" value={fmtNum(s.organizations)} foot={Object.entries(s.plans).map(([k, v]) => `${v} ${k}`).join(" · ")} />
          <Tile label="Users" value={fmtNum(s.users)} foot={`${fmtNum(s.users_active_7d)} active in 7 d`} />
          <Tile label="Assets" value={fmtNum(s.assets)} foot={`${fmtCompact(s.monitored_ha)} ha monitored`} />
          <Tile label="Connectors" value={fmtNum(s.connectors)} />
          <Tile label="Alerts · 24 h" value={fmtNum(s.alerts_24h)} />
          <Tile label="Detections · 24 h" value={fmtCompact(s.detections_24h)} foot={`${fmtCompact(s.detections_total)} stored`} />
          <Tile label="Last ingest" value={s.last_ingest ? timeAgo(s.last_ingest.finished_at) : "never"} foot={s.last_ingest ? `${s.last_ingest.mode} · ${fmtNum(s.last_ingest.inserted)} new` : undefined} />
        </div>
      )}
      <Card flush>
        <div style={{ padding: "0 12px" }}>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: "orgs", label: "Organisations" }, { id: "users", label: "Users" }]} label="Admin lists" />
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
            <Input inputSize="sm" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === "orgs" ? "Search organisations" : "Search e-mail"} aria-label="Search" onBlur={() => setQuery(q)} />
          </div>
        </form>
        {tab === "orgs" ? (
          orgs.error ? <div className="card-body"><ErrorState error={orgs.error} onRetry={orgs.reload} /></div> : !orgs.data ? <Loading /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>ID</th><th>Name</th><th className="right">Members</th><th className="right">Assets</th><th>Created</th><th>Plan</th></tr></thead>
                <tbody>
                  {orgs.data.map((o) => (
                    <tr key={o.id}>
                      <td className="muted">{o.id}</td>
                      <td className="strong">{o.name}</td>
                      <td className="right">{o.members}</td>
                      <td className="right">{o.assets}</td>
                      <td className="small">{fmtDate(o.created_at)}</td>
                      <td>
                        <Select inputSize="sm" value={o.plan} onChange={(e) => setPlan(o, e.target.value)} aria-label={`Plan for ${o.name}`} style={{ width: 140 }}>
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
              <thead><tr><th>ID</th><th>User</th><th>Status</th><th>Created</th><th>Last sign-in</th></tr></thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td className="muted">{u.id}</td>
                    <td><div className="strong">{u.name || u.email}</div><div className="tiny muted">{u.email}</div></td>
                    <td className="row wrap" style={{ gap: 4 }}>
                      {u.email_verified ? <Badge kind="ok">verified</Badge> : <Badge kind="warn">unverified</Badge>}
                      {u.is_superuser && <Badge kind="accent">superuser</Badge>}
                    </td>
                    <td className="small">{fmtDate(u.created_at)}</td>
                    <td className="small muted">{u.last_login_at ? timeAgo(u.last_login_at) : "never"}</td>
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
