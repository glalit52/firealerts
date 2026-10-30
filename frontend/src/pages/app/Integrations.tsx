import { useState } from "react";
import { assets as assetsApi, connectors as connApi, rules as rulesApi } from "../../api/endpoints";
import type { AlertType, Connector, NotificationRule, RuleInput, Severity } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { ConnectorForm } from "../../components/ConnectorForm";
import type { ConnectorFormResult } from "../../components/ConnectorForm";
import { IconEdit, IconPlus, IconSend, IconTrash } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Notice, Select, SeverityChip, Switch, useConfirm } from "../../components/ui";
import { fmtNum, humanize, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";

type Category = "notification" | "data";

function initialsOf(label: string) {
  return label.replace(/\(.*\)/, "").replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}

function ConnectorCard({ c, canEdit, onEdit, onChanged, onDelete }: { c: Connector; canEdit: boolean; onEdit: () => void; onChanged: (c: Connector) => void; onDelete: () => void }) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await connApi.test(c.id);
      setResult(r);
      onChanged({ ...c, last_status: r.ok ? "ok" : "error", last_error: r.ok ? "" : r.message });
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(false);
    }
  };
  const toggle = async (v: boolean) => {
    try {
      onChanged(await connApi.update(c.id, { enabled: v }));
    } catch (e) {
      toast.error(e);
    }
  };
  const summary = Object.entries(c.config)
    .filter(([, v]) => v !== "" && v != null && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${humanize(k)}: ${Array.isArray(v) ? v.join(", ") : v === true ? "yes" : String(v)}`)
    .slice(0, 2);
  return (
    <div className="connector-card">
      <div className="row top">
        <span className="connector-icon">{initialsOf(c.label)}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="strong truncate">{c.name}</div>
          <div className="tiny muted">{c.label}</div>
        </div>
        <Switch checked={c.enabled} onChange={toggle} disabled={!canEdit} label={<span className="sr-only">Enabled</span>} />
      </div>
      {summary.length > 0 && (
        <div className="tiny muted" style={{ wordBreak: "break-all" }}>
          {summary.map((s) => (
            <div key={s} className="truncate">
              {s}
            </div>
          ))}
        </div>
      )}
      <div className="row small">
        <span className={`status-dot ${c.last_status === "ok" ? "ok" : c.last_status === "error" ? "bad" : "idle"}`} />
        <span className="muted">
          {c.last_status === "ok" ? "Working" : c.last_status === "error" ? "Last attempt failed" : "Not used yet"}
          {c.last_used_at && ` · used ${timeAgo(c.last_used_at)}`}
        </span>
      </div>
      {c.last_status === "error" && c.last_error && !result && <div className="tiny bad-text" style={{ wordBreak: "break-word" }}>{c.last_error}</div>}
      {result && (
        <div className={`notice ${result.ok ? "ok" : "bad"} small`} role="status">
          {result.ok ? "✓ " : "✕ "}
          {result.message}
        </div>
      )}
      {canEdit && (
        <div className="row" style={{ marginTop: "auto" }}>
          <Button size="sm" icon={<IconSend />} loading={testing} onClick={test}>
            Send test
          </Button>
          <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={onEdit}>
            Edit
          </Button>
          <div className="grow" />
          <Button size="sm" variant="ghost" iconOnly aria-label={`Delete ${c.name}`} title="Delete" onClick={onDelete}>
            <IconTrash />
          </Button>
        </div>
      )}
    </div>
  );
}

function RuleModal({ rule, connectors, onClose, onSaved }: { rule: NotificationRule | null; connectors: Connector[]; onClose: () => void; onSaved: () => void }) {
  const { meta } = useAuth();
  const toast = useToast();
  const assets = useAsync(() => assetsApi.list(), []);
  const types = (meta?.alert_types ?? ["detection", "threat", "risk", "system"]) as AlertType[];
  const sevs = (meta?.severities ?? ["info", "low", "moderate", "high", "critical"]) as Severity[];
  const [form, setForm] = useState<RuleInput>(
    rule
      ? { name: rule.name, asset_ids: rule.asset_ids, alert_types: rule.alert_types, min_severity: rule.min_severity, connector_ids: rule.connector_ids, enabled: rule.enabled }
      : { name: "", asset_ids: null, alert_types: types.filter((t) => t !== "system"), min_severity: "moderate", connector_ids: [], enabled: true },
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const notif = connectors.filter((c) => c.category === "notification");

  const save = async () => {
    if (!form.name.trim()) return setErr("Give the rule a name.");
    if (!form.alert_types.length) return setErr("Pick at least one alert type.");
    if (!form.connector_ids.length) return setErr("Pick at least one channel to deliver to.");
    if (form.asset_ids && !form.asset_ids.length) return setErr("Pick at least one asset, or choose “All assets”.");
    setBusy(true);
    setErr(null);
    try {
      const body = { ...form, name: form.name.trim() };
      if (rule) await rulesApi.update(rule.id, body);
      else await rulesApi.create(body);
      toast.success(rule ? "Rule updated." : "Rule created.");
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? "Edit notification rule" : "New notification rule"}
      description="Rules decide which alerts go to which channels."
      size="wide"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {rule ? "Save rule" : "Create rule"}
          </Button>
        </>
      }
    >
      <div className="stack loose">
        <div className="form-grid">
          <Input label="Rule name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Critical threats to on-call" />
          <Select label="Minimum severity" value={form.min_severity} onChange={(e) => setForm({ ...form, min_severity: e.target.value as Severity })} options={sevs.map((s) => ({ value: s, label: `${humanize(s)} and above` }))} />
        </div>
        <div className="field">
          <span className="field-label">Alert types</span>
          <div className="row wrap">
            {types.map((t) => (
              <button key={t} type="button" className="chip-toggle" aria-pressed={form.alert_types.includes(t)} onClick={() => setForm({ ...form, alert_types: toggle(form.alert_types, t) })}>
                {humanize(t)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">Assets</span>
          <div className="row wrap">
            <button type="button" className="chip-toggle" aria-pressed={form.asset_ids === null} onClick={() => setForm({ ...form, asset_ids: null })}>
              All assets (incl. future)
            </button>
            <button type="button" className="chip-toggle" aria-pressed={form.asset_ids !== null} onClick={() => setForm({ ...form, asset_ids: form.asset_ids ?? [] })}>
              Selected assets
            </button>
          </div>
          {form.asset_ids !== null && (
            <div className="row wrap mt-8">
              {!assets.data ? (
                <Loading />
              ) : assets.data.length === 0 ? (
                <span className="small muted">No assets yet.</span>
              ) : (
                assets.data.map((a) => (
                  <button key={a.id} type="button" className="chip-toggle" aria-pressed={form.asset_ids!.includes(a.id)} onClick={() => setForm({ ...form, asset_ids: toggle(form.asset_ids!, a.id) })}>
                    {a.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <div className="field">
          <span className="field-label">Deliver to</span>
          {notif.length === 0 ? (
            <span className="small muted">Add a notification channel first.</span>
          ) : (
            <div className="row wrap">
              {notif.map((c) => (
                <button key={c.id} type="button" className="chip-toggle" aria-pressed={form.connector_ids.includes(c.id)} onClick={() => setForm({ ...form, connector_ids: toggle(form.connector_ids, c.id) })}>
                  {c.name} <span className="tiny muted">{c.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Rule enabled" />
        {err && <div className="form-error">{err}</div>}
      </div>
    </Modal>
  );
}

export default function Integrations() {
  useDocumentTitle("Integrations");
  const { meta, can, me } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const list = useAsync(() => connApi.list(), []);
  const rules = useAsync(() => rulesApi.list(), []);
  const assets = useAsync(() => assetsApi.list(), []);
  const [adding, setAdding] = useState<Category | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [busy, setBusy] = useState(false);
  const [ruleModal, setRuleModal] = useState<NotificationRule | "new" | null>(null);
  const canEdit = can("admin");
  const types = meta?.connector_types ?? {};

  const closeForm = () => {
    setAdding(null);
    setType(null);
    setEditing(null);
  };

  const submit = async (r: ConnectorFormResult) => {
    setBusy(true);
    try {
      if (editing) {
        const c = await connApi.update(editing.id, r);
        list.setData((xs) => (xs ?? []).map((x) => (x.id === c.id ? c : x)));
        toast.success("Connection updated.");
      } else if (type) {
        const c = await connApi.create({ type, ...r });
        list.setData((xs) => [...(xs ?? []), c]);
        toast.success(`${c.label} connected. Send a test to check it works.`);
      }
      closeForm();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Connector) => {
    if (!(await confirm({ title: `Delete “${c.name}”?`, body: "It will be removed from all notification rules.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await connApi.remove(c.id);
      list.setData((xs) => (xs ?? []).filter((x) => x.id !== c.id));
      void rules.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const removeRule = async (r: NotificationRule) => {
    if (!(await confirm({ title: `Delete rule “${r.name}”?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await rulesApi.remove(r.id);
      void rules.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const toggleRule = async (r: NotificationRule, enabled: boolean) => {
    try {
      const { id: _id, created_at: _c, ...body } = r;
      await rulesApi.update(r.id, { ...body, enabled });
      void rules.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const section = (cat: Category, title: string, sub: string) => {
    const items = (list.data ?? []).filter((c) => (c.category ?? types[c.type]?.category) === cat);
    return (
      <Card
        title={title}
        sub={sub}
        actions={
          canEdit && (
            <Button size="sm" variant={cat === "notification" ? "primary" : "default"} icon={<IconPlus />} onClick={() => setAdding(cat)}>
              Add {cat === "notification" ? "channel" : "data source"}
            </Button>
          )
        }
      >
        {!list.data ? (
          list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : <Loading />
        ) : items.length === 0 ? (
          <EmptyState title={cat === "notification" ? "No channels yet" : "No data sources connected"}>
            {cat === "notification"
              ? "Alerts are shown in-app. Connect e-mail, Slack, Teams, SMS, WhatsApp, PagerDuty or a webhook to be notified."
              : "Connect Google Earth Engine or Global Forest Watch for burned-area history and forest-loss analytics, or your own FIRMS key."}
          </EmptyState>
        ) : (
          <div className="connector-grid">
            {items.map((c) => (
              <ConnectorCard key={c.id} c={c} canEdit={canEdit} onEdit={() => setEditing(c)} onDelete={() => remove(c)} onChanged={(n) => list.setData((xs) => (xs ?? []).map((x) => (x.id === n.id ? n : x)))} />
            ))}
          </div>
        )}
      </Card>
    );
  };

  const connName = (id: number) => list.data?.find((c) => c.id === id)?.name ?? `#${id}`;
  const assetName = (id: number) => assets.data?.find((a) => a.id === id)?.name ?? `#${id}`;
  const spec = editing ? types[editing.type] : type ? types[type] : null;
  const limit = me?.org?.limits?.connectors;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <p>
            Where alerts go and which external data sources power your analytics.
            {limit != null && list.data && ` ${fmtNum(list.data.length)} of ${limit} connections used.`}
          </p>
        </div>
      </div>
      {!canEdit && (
        <div className="mb-16">
          <Notice kind="info">Only organisation admins can add or change integrations.</Notice>
        </div>
      )}
      <div className="stack loose">
        {section("notification", "Notification channels", "E-mail, chat, SMS, paging and webhooks")}

        <Card
          title="Notification rules"
          sub="Route alerts by asset, type and severity"
          actions={
            canEdit && (
              <Button size="sm" icon={<IconPlus />} onClick={() => setRuleModal("new")} disabled={!list.data?.some((c) => c.category === "notification")}>
                New rule
              </Button>
            )
          }
          flush
        >
          <div className="card-body" style={{ paddingBottom: rules.data?.length ? 0 : undefined }}>
            <Notice kind="info" title="Default routing">
              With no rules, every alert of <b>moderate</b> severity or higher goes to all enabled notification channels. As soon as you add a rule, only matching rules deliver.
            </Notice>
          </div>
          {rules.data && rules.data.length > 0 && (
            <div className="table-wrap mt-12">
              <table className="table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Assets</th>
                    <th>Types</th>
                    <th>Min severity</th>
                    <th>Channels</th>
                    <th>On</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rules.data.map((r) => (
                    <tr key={r.id}>
                      <td className="strong">{r.name}</td>
                      <td className="small">{r.asset_ids === null ? "All assets" : r.asset_ids.map(assetName).join(", ") || "–"}</td>
                      <td className="small">{r.alert_types.map(humanize).join(", ")}</td>
                      <td>
                        <SeverityChip severity={r.min_severity} />
                      </td>
                      <td className="small">{r.connector_ids.length ? r.connector_ids.map(connName).join(", ") : <span className="warn-text">none</span>}</td>
                      <td>
                        <Switch checked={r.enabled} onChange={(v) => toggleRule(r, v)} disabled={!canEdit} label={<span className="sr-only">Enabled</span>} />
                      </td>
                      <td className="actions">
                        {canEdit && (
                          <>
                            <Button size="sm" variant="ghost" iconOnly aria-label="Edit rule" onClick={() => setRuleModal(r)}>
                              <IconEdit />
                            </Button>
                            <Button size="sm" variant="ghost" iconOnly aria-label="Delete rule" onClick={() => removeRule(r)}>
                              <IconTrash />
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {section("data", "Data sources", "Bring your own credentials for premium analytics")}
      </div>

      <Modal open={!!adding && !type} onClose={closeForm} title={adding === "data" ? "Connect a data source" : "Add a notification channel"} size="wide">
        <div className="type-picker">
          {Object.entries(types)
            .filter(([, t]) => t.category === adding)
            .map(([key, t]) => (
              <button key={key} type="button" className="type-option" onClick={() => setType(key)}>
                <span className="connector-icon">{initialsOf(t.label)}</span>
                <span>
                  <span className="strong">{t.label}</span>
                  <span className="desc" style={{ display: "block" }}>
                    {t.description}
                  </span>
                </span>
              </button>
            ))}
        </div>
      </Modal>

      {spec && (
        <Modal open onClose={closeForm} title={editing ? `Edit ${editing.name}` : `Connect ${spec.label}`}>
          <ConnectorForm spec={spec} existing={editing ?? undefined} onSubmit={submit} onCancel={closeForm} busy={busy} />
        </Modal>
      )}
      {ruleModal && <RuleModal rule={ruleModal === "new" ? null : ruleModal} connectors={list.data ?? []} onClose={() => setRuleModal(null)} onSaved={rules.reload} />}
      {dialog}
      {editing && !spec && <Badge kind="warn">Unknown connector type {editing.type}</Badge>}
    </div>
  );
}
