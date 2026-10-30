import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { assets as assetsApi, data as dataApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { IconDownload, IconPlus, IconSearch, IconTree } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, DangerPill, EmptyState, ErrorState, Input, Loading, Segmented, Select } from "../../components/ui";
import { fmtCompact, fmtHa, fmtNum, fmtPct, humanize } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { CreateAssetModal } from "./assets/CreateAsset";

type Sort = "risk" | "name" | "area" | "alerts";

export default function Assets() {
  useDocumentTitle("Forests & assets");
  const { can, me } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const list = useAsync(() => assetsApi.list(true), []);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState<Sort>("risk");
  const [view, setView] = useState<"cards" | "table">("cards");
  const creating = params.get("new") === "1";
  const setCreating = (v: boolean) => {
    if (v) params.set("new", "1");
    else params.delete("new");
    setParams(params, { replace: true });
  };

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    const xs = (list.data ?? []).filter((a) => (!kind || a.kind === kind) && (!s || a.name.toLowerCase().includes(s) || a.tags.some((t) => t.toLowerCase().includes(s))));
    const by: Record<Sort, (a: (typeof xs)[number], b: (typeof xs)[number]) => number> = {
      risk: (a, b) => (b.risk_today?.fwi ?? -1) - (a.risk_today?.fwi ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
      area: (a, b) => b.area_ha - a.area_ha,
      alerts: (a, b) => b.open_alerts - a.open_alerts,
    };
    return xs.sort(by[sort]);
  }, [list.data, q, kind, sort]);

  const kinds = [...new Set((list.data ?? []).map((a) => a.kind))];
  const total = (list.data ?? []).reduce((a, x) => a + x.area_ha, 0);
  const limit = me?.org?.limits?.assets;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Forests &amp; assets</h1>
          <p>
            {list.data ? `${fmtNum(list.data.length)}${limit != null ? ` of ${limit}` : ""} assets · ${fmtCompact(total)} ha monitored` : "Areas Firealerts watches for fires, danger and vegetation change."}
          </p>
        </div>
        <div className="row wrap">
          <Button
            icon={<IconDownload />}
            onClick={() => dataApi.exportAssets("geojson").catch((e) => toast.error(e))}
            disabled={!list.data?.length}
          >
            Export GeoJSON
          </Button>
          {can("member") && (
            <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
              Add asset
            </Button>
          )}
        </div>
      </div>

      {list.data && list.data.length > 0 && (
        <div className="filters mb-16">
          <div className="search-box" style={{ width: 260, maxWidth: "100%" }}>
            <IconSearch size={14} />
            <Input type="search" placeholder="Search name or tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search assets" />
          </div>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="risk">Sort: risk today</option>
            <option value="alerts">Sort: open alerts</option>
            <option value="area">Sort: area</option>
            <option value="name">Sort: name</option>
          </Select>
          <div className="grow" />
          <Segmented value={view} onChange={setView} options={[{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }]} label="View" />
        </div>
      )}

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading label="Loading assets" />
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconTree size={20} />}
            title="No assets yet"
            action={
              can("member") ? (
                <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
                  Add your first asset
                </Button>
              ) : undefined
            }
          >
            Add forests, plantations, protected areas or infrastructure. You'll get alerts for nearby fires, fire-danger forecasts and Sentinel-2 vegetation monitoring for each.
          </EmptyState>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title="No matches">Try a different search or filter.</EmptyState>
        </Card>
      ) : view === "cards" ? (
        <div className="asset-grid">
          {items.map((a) => (
            <Link key={a.id} to={`/app/assets/${a.id}`} className="asset-card">
              <div className="row between top">
                <div style={{ minWidth: 0 }}>
                  <div className="strong truncate" style={{ fontSize: 15 }}>
                    {a.name}
                  </div>
                  <div className="small muted">
                    {humanize(a.kind)} · {fmtHa(a.area_ha)}
                    {!a.active && " · paused"}
                  </div>
                </div>
                {a.risk_today ? <DangerPill danger={a.risk_today.danger} /> : <Badge>Risk pending</Badge>}
              </div>
              <div className="metrics">
                <div>
                  <b>{fmtNum(a.risk_today?.fwi)}</b>
                  <span>FWI today</span>
                </div>
                <div>
                  <b>{fmtPct(a.risk_today?.ignition_p)}</b>
                  <span>Ignition</span>
                </div>
                <div>
                  <b style={{ color: a.open_alerts ? "var(--sev-high)" : undefined }}>{a.open_alerts}</b>
                  <span>Open alerts</span>
                </div>
              </div>
              {a.tags.length > 0 && (
                <div className="row wrap" style={{ gap: 4 }}>
                  {a.tags.slice(0, 6).map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th className="right">Area</th>
                  <th>Risk today</th>
                  <th className="right">FWI</th>
                  <th className="right">Open alerts</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => navigate(`/app/assets/${a.id}`)}>
                    <td>
                      <Link to={`/app/assets/${a.id}`} className="strong" style={{ color: "var(--text)" }} onClick={(e) => e.stopPropagation()}>
                        {a.name}
                      </Link>
                    </td>
                    <td>{humanize(a.kind)}</td>
                    <td className="right">{fmtHa(a.area_ha)}</td>
                    <td>{a.risk_today ? <DangerPill danger={a.risk_today.danger} /> : <span className="muted">–</span>}</td>
                    <td className="right">{fmtNum(a.risk_today?.fwi)}</td>
                    <td className="right">{a.open_alerts ? <Badge kind="bad">{a.open_alerts}</Badge> : 0}</td>
                    <td>
                      <span className="row wrap" style={{ gap: 4 }}>
                        {a.tags.map((t) => (
                          <span key={t} className="chip">
                            {t}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && <CreateAssetModal open={creating} onClose={() => setCreating(false)} existing={list.data ?? []} onChanged={list.reload} />}
    </div>
  );
}
