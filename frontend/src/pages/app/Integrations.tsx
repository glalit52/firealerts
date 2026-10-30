import { useState } from "react";
import { assets as assetsApi, connectors as connApi, rules as rulesApi } from "../../api/endpoints";
import type { AlertType, Connector, NotificationRule, RuleInput, Severity } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { ConnectorForm } from "../../components/ConnectorForm";
import type { ConnectorFormResult } from "../../components/ConnectorForm";
import { IconEdit, IconPhone, IconPlus, IconSend, IconSmartphone, IconTrash } from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Notice, Select, SeverityChip, Switch, useConfirm } from "../../components/ui";
import { fmtNum, humanize, timeAgo } from "../../lib/format";
import { useAsync, useDocumentTitle } from "../../lib/useAsync";
import { tEnum, useT } from "../../i18n";

type Category = "notification" | "data";

function initialsOf(label: string) {
  return label.replace(/\(.*\)/, "").replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}

/** Connector badge: a pictogram for phone calls and mobile push, initials otherwise. */
export function ConnectorIcon({ type, label }: { type: string; label: string }) {
  if (type === "twilio_voice" || /voice|phone call/i.test(label))
    return (
      <span className="connector-icon" aria-hidden="true">
        <IconPhone size={16} />
      </span>
    );
  if (type === "push")
    return (
      <span className="connector-icon" aria-hidden="true">
        <IconSmartphone size={16} />
      </span>
    );
  return <span className="connector-icon">{initialsOf(label)}</span>;
}

function ConnectorCard({ c, canEdit, onEdit, onChanged, onDelete }: { c: Connector; canEdit: boolean; onEdit: () => void; onChanged: (c: Connector) => void; onDelete: () => void }) {
  const toast = useToast();
  const { t } = useT();
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
    .map(([k, v]) => `${humanize(k)}: ${Array.isArray(v) ? v.join(", ") : v === true ? t("common.yes") : String(v)}`)
    .slice(0, 2);
  return (
    <div className="connector-card">
      <div className="row top">
        <ConnectorIcon type={c.type} label={c.label} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="strong truncate">{c.name}</div>
          <div className="tiny muted">{c.label}</div>
        </div>
        <Switch checked={c.enabled} onChange={toggle} disabled={!canEdit} label={<span className="sr-only">{t("common.enabled")}</span>} />
      </div>
      {c.type === "push" && <div className="tiny muted">{t("integ.pushHint")}</div>}
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
          {c.last_status === "ok" ? t("integ.working") : c.last_status === "error" ? t("integ.failed") : t("integ.unused")}
          {c.last_used_at && ` · ${t("integ.used", { ago: timeAgo(c.last_used_at) })}`}
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
            {t("integ.sendTest")}
          </Button>
          <Button size="sm" variant="ghost" icon={<IconEdit />} onClick={onEdit}>
            {t("common.edit")}
          </Button>
          <div className="grow" />
          <Button size="sm" variant="ghost" iconOnly aria-label={t("integ.deleteNamed", { name: c.name })} title={t("common.delete")} onClick={onDelete}>
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
  const { t } = useT();
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
    if (!form.name.trim()) return setErr(t("rule.errName"));
    if (!form.alert_types.length) return setErr(t("rule.errTypes"));
    if (!form.connector_ids.length) return setErr(t("rule.errChannels"));
    if (form.asset_ids && !form.asset_ids.length) return setErr(t("rule.errAssets"));
    setBusy(true);
    setErr(null);
    try {
      const body = { ...form, name: form.name.trim() };
      if (rule) await rulesApi.update(rule.id, body);
      else await rulesApi.create(body);
      toast.success(rule ? t("rule.updated") : t("rule.created"));
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
      title={rule ? t("rule.editTitle") : t("rule.newTitle")}
      description={t("rule.desc")}
      size="wide"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {rule ? t("rule.save") : t("rule.create")}
          </Button>
        </>
      }
    >
      <div className="stack loose">
        <div className="form-grid">
          <Input label={t("rule.name")} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("rule.namePh")} />
          <Select label={t("rule.minSeverity")} value={form.min_severity} onChange={(e) => setForm({ ...form, min_severity: e.target.value as Severity })} options={sevs.map((s) => ({ value: s, label: t("rule.andAbove", { sev: tEnum("severityName", s) }) }))} />
        </div>
        <div className="field">
          <span className="field-label">{t("rule.types")}</span>
          <div className="row wrap">
            {types.map((x) => (
              <button key={x} type="button" className="chip-toggle" aria-pressed={form.alert_types.includes(x)} onClick={() => setForm({ ...form, alert_types: toggle(form.alert_types, x) })}>
                {tEnum("alertType", x)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">{t("live.tab.assets")}</span>
          <div className="row wrap">
            <button type="button" className="chip-toggle" aria-pressed={form.asset_ids === null} onClick={() => setForm({ ...form, asset_ids: null })}>
              {t("rule.allAssets")}
            </button>
            <button type="button" className="chip-toggle" aria-pressed={form.asset_ids !== null} onClick={() => setForm({ ...form, asset_ids: form.asset_ids ?? [] })}>
              {t("rule.selectedAssets")}
            </button>
          </div>
          {form.asset_ids !== null && (
            <div className="row wrap mt-8">
              {!assets.data ? (
                <Loading />
              ) : assets.data.length === 0 ? (
                <span className="small muted">{t("assets.noneYet")}</span>
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
          <span className="field-label">{t("rule.deliverTo")}</span>
          {notif.length === 0 ? (
            <span className="small muted">{t("rule.noChannels")}</span>
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
        <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t("rule.enabled")} />
        {err && <div className="form-error">{err}</div>}
      </div>
    </Modal>
  );
}

export default function Integrations() {
  const { t } = useT();
  useDocumentTitle(t("nav.integrations"));
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
        toast.success(t("integ.updated"));
      } else if (type) {
        const c = await connApi.create({ type, ...r });
        list.setData((xs) => [...(xs ?? []), c]);
        toast.success(t("integ.connected", { label: c.label }));
      }
      closeForm();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Connector) => {
    if (!(await confirm({ title: t("integ.deleteTitle", { name: c.name }), body: t("integ.deleteBody"), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await connApi.remove(c.id);
      list.setData((xs) => (xs ?? []).filter((x) => x.id !== c.id));
      void rules.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const removeRule = async (r: NotificationRule) => {
    if (!(await confirm({ title: t("rule.deleteTitle", { name: r.name }), confirmLabel: t("common.delete"), danger: true }))) return;
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
              {cat === "notification" ? t("integ.addChannel") : t("integ.addSource")}
            </Button>
          )
        }
      >
        {!list.data ? (
          list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : <Loading />
        ) : items.length === 0 ? (
          <EmptyState title={cat === "notification" ? t("integ.noChannels") : t("integ.noSources")}>
            {cat === "notification" ? t("integ.noChannelsBody") : t("integ.noSourcesBody")}
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
          <h1>{t("nav.integrations")}</h1>
          <p>
            {t("integ.lead")}
            {limit != null && list.data && ` ${t("integ.used2", { n: fmtNum(list.data.length), limit })}`}
          </p>
        </div>
      </div>
      {!canEdit && (
        <div className="mb-16">
          <Notice kind="info">{t("integ.adminsOnly")}</Notice>
        </div>
      )}
      <div className="stack loose">
        {section("notification", t("integ.channels"), t("integ.channelsSub"))}

        <Card
          title={t("integ.rules")}
          sub={t("integ.rulesSub")}
          actions={
            canEdit && (
              <Button size="sm" icon={<IconPlus />} onClick={() => setRuleModal("new")} disabled={!list.data?.some((c) => c.category === "notification")}>
                {t("integ.newRule")}
              </Button>
            )
          }
          flush
        >
          <div className="card-body" style={{ paddingBottom: rules.data?.length ? 0 : undefined }}>
            <Notice kind="info" title={t("integ.defaultRouting")}>
              {t("integ.defaultRoutingBody")}
            </Notice>
          </div>
          {rules.data && rules.data.length > 0 && (
            <div className="table-wrap mt-12">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("integ.col.rule")}</th>
                    <th>{t("live.tab.assets")}</th>
                    <th>{t("integ.col.types")}</th>
                    <th>{t("integ.col.minSev")}</th>
                    <th>{t("integ.col.channels")}</th>
                    <th>{t("integ.col.on")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rules.data.map((r) => (
                    <tr key={r.id}>
                      <td className="strong">{r.name}</td>
                      <td className="small">{r.asset_ids === null ? t("alerts.allAssets") : r.asset_ids.map(assetName).join(", ") || "–"}</td>
                      <td className="small">{r.alert_types.map((x) => tEnum("alertType", x)).join(", ")}</td>
                      <td>
                        <SeverityChip severity={r.min_severity} />
                      </td>
                      <td className="small">{r.connector_ids.length ? r.connector_ids.map(connName).join(", ") : <span className="warn-text">{t("integ.none")}</span>}</td>
                      <td>
                        <Switch checked={r.enabled} onChange={(v) => toggleRule(r, v)} disabled={!canEdit} label={<span className="sr-only">{t("common.enabled")}</span>} />
                      </td>
                      <td className="actions">
                        {canEdit && (
                          <>
                            <Button size="sm" variant="ghost" iconOnly aria-label={t("integ.editRule")} onClick={() => setRuleModal(r)}>
                              <IconEdit />
                            </Button>
                            <Button size="sm" variant="ghost" iconOnly aria-label={t("integ.deleteRule")} onClick={() => removeRule(r)}>
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

        {section("data", t("integ.sources"), t("integ.sourcesSub"))}
      </div>

      <Modal open={!!adding && !type} onClose={closeForm} title={adding === "data" ? t("integ.connectSource") : t("integ.addChannelTitle")} size="wide">
        <div className="type-picker">
          {Object.entries(types)
            .filter(([, ct]) => ct.category === adding)
            .map(([key, ct]) => (
              <button key={key} type="button" className="type-option" onClick={() => setType(key)}>
                <ConnectorIcon type={key} label={ct.label} />
                <span>
                  <span className="strong">{ct.label}</span>
                  <span className="desc" style={{ display: "block" }}>
                    {ct.description}
                  </span>
                </span>
              </button>
            ))}
        </div>
      </Modal>

      {spec && (
        <Modal open onClose={closeForm} title={editing ? t("integ.editTitle", { name: editing.name }) : t("integ.connectTitle", { label: spec.label })}>
          <ConnectorForm spec={spec} existing={editing ?? undefined} onSubmit={submit} onCancel={closeForm} busy={busy} />
        </Modal>
      )}
      {ruleModal && <RuleModal rule={ruleModal === "new" ? null : ruleModal} connectors={list.data ?? []} onClose={() => setRuleModal(null)} onSaved={rules.reload} />}
      {dialog}
      {editing && !spec && <Badge kind="warn">{t("common.unknownConnector", { type: editing.type })}</Badge>}
    </div>
  );
}
