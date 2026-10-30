import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { billing, orgs } from "../../../api/endpoints";
import { session } from "../../../api/client";
import { useAuth } from "../../../auth/AuthContext";
import { UpgradeButton } from "../../../components/PlanLimitNotice";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, ErrorState, Input, Loading, Modal, Notice, Select, Switch } from "../../../components/ui";
import { TIMEZONES } from "../../../lib/constants";
import { fmtDate, fmtNum } from "../../../lib/format";
import { useAsync, useDocumentTitle } from "../../../lib/useAsync";

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="usage-row">
      <span className="muted">{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: limit ? `${pct}%` : "0%", background: pct >= 100 ? "var(--bad)" : pct >= 80 ? "var(--warn)" : "var(--accent)" }} />
      </div>
      <span className="num" style={{ textAlign: "right" }}>
        {fmtNum(used)} / {limit == null ? "∞" : fmtNum(limit)}
      </span>
    </div>
  );
}

export default function Organization() {
  useDocumentTitle("Organisation");
  const { me, meta, can, refresh, switchOrg } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const org = useAsync(() => orgs.get(), []);
  const bill = useAsync(() => billing.status(), [], { enabled: !!meta?.billing_enabled });
  const [name, setName] = useState("");
  const [tz, setTz] = useState("UTC");
  const [digest, setDigest] = useState(true);
  const [buffer, setBuffer] = useState(2);
  const [saving, setSaving] = useState(false);
  const [newOrg, setNewOrg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [del, setDel] = useState(false);
  const [delText, setDelText] = useState("");
  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    if (!org.data) return;
    setName(org.data.name);
    setTz(org.data.settings.timezone ?? "UTC");
    setDigest(org.data.settings.daily_digest ?? true);
    setBuffer(org.data.settings.default_buffer_km ?? 2);
  }, [org.data]);

  const admin = can("admin");
  const save = async () => {
    setSaving(true);
    try {
      await orgs.update({ name: name.trim(), settings: { timezone: tz, daily_digest: digest, default_buffer_km: buffer } });
      await Promise.all([org.reload(), refresh()]);
      toast.success("Organisation settings saved.");
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    if (!newOrg?.trim()) return;
    setCreating(true);
    try {
      const o = await orgs.create(newOrg.trim());
      setNewOrg(null);
      await switchOrg(o.id);
      toast.success(`Created ${o.name}. You're now viewing it.`);
      navigate("/app");
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    try {
      await orgs.remove();
      session.setOrgId(null);
      await refresh();
      toast.success("Organisation deleted.");
      navigate("/app");
      window.location.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const portal = async () => {
    setPortalBusy(true);
    try {
      window.location.assign((await billing.portal()).url);
    } catch (e) {
      toast.error(e);
      setPortalBusy(false);
    }
  };

  if (org.error) return <div className="page"><ErrorState error={org.error} onRetry={org.reload} /></div>;
  if (!org.data) return <Loading label="Loading organisation" />;
  const o = org.data;
  const planKeys = Object.keys(meta?.plans ?? {});
  const higher = planKeys.slice(planKeys.indexOf(o.plan) + 1).filter((p) => !bill.data || bill.data.purchasable.includes(p));
  const tzs = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Organisation</h1>
          <p>
            {o.name} · created {fmtDate(o.created_at)} · you are <b>{o.role}</b>
          </p>
        </div>
        {me?.authenticated && (
          <Button onClick={() => setNewOrg("")}>New organisation</Button>
        )}
      </div>
      <div className="settings-layout">
        <Card title="Plan & usage" actions={<Badge kind="accent">{o.limits.label}</Badge>}>
          <UsageRow label="Assets" used={o.usage.assets} limit={o.limits.assets} />
          <UsageRow label="Team members" used={o.usage.members} limit={o.limits.members} />
          <UsageRow label="Integrations" used={o.usage.connectors} limit={o.limits.connectors} />
          <div className="small muted mt-8">
            Max asset size: {o.limits.max_asset_ha == null ? "unlimited" : `${fmtNum(o.limits.max_asset_ha)} ha`} · API keys per user: {o.limits.api_keys ?? "unlimited"} · forecast ensemble: {o.limits.forecast_members} members
          </div>
          <div className="row wrap mt-16">
            {meta?.billing_enabled ? (
              <>
                {higher.map((p) => (
                  <UpgradeButton key={p} plan={p} variant={p === higher[0] ? "primary" : "default"} />
                ))}
                {bill.data?.has_customer && can("owner") && (
                  <Button loading={portalBusy} onClick={portal}>
                    Manage billing
                  </Button>
                )}
                {!can("owner") && <span className="small muted">Only owners can change the plan.</span>}
              </>
            ) : (
              <span className="small muted">To change plans, contact your Firealerts administrator.</span>
            )}
          </div>
        </Card>

        <Card title="Settings" footer={admin ? <Button variant="primary" loading={saving} onClick={save} disabled={!name.trim()}>Save settings</Button> : undefined}>
          {!admin && <div className="mb-12"><Notice kind="info">Only admins can change organisation settings.</Notice></div>}
          <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }} className="form-grid">
            <Input label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Select label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} hint="Used for daily digests and report times." options={tzs.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} />
            <Input label="Default detection buffer (km)" type="number" min={0} max={100} step={0.5} value={buffer} onChange={(e) => setBuffer(+e.target.value)} hint="Pre-filled when creating assets." />
            <div className="field" style={{ justifyContent: "center" }}>
              <Switch checked={digest} onChange={setDigest} label="Daily digest e-mail to members" />
            </div>
          </fieldset>
        </Card>

        {can("owner") && (
          <Card title="Danger zone">
            <div className="row between wrap">
              <div className="small muted" style={{ maxWidth: 520 }}>Delete this organisation with all its assets, alerts, integrations and history. Members keep their accounts.</div>
              <Button variant="danger" onClick={() => setDel(true)}>
                Delete organisation
              </Button>
            </div>
          </Card>
        )}
      </div>

      <Modal
        open={newOrg !== null}
        onClose={() => setNewOrg(null)}
        title="New organisation"
        description="A separate workspace with its own assets, alerts, team and plan. You'll be its owner."
        footer={
          <>
            <Button onClick={() => setNewOrg(null)}>Cancel</Button>
            <Button variant="primary" loading={creating} disabled={!newOrg?.trim()} onClick={create}>
              Create
            </Button>
          </>
        }
      >
        <Input label="Name" value={newOrg ?? ""} onChange={(e) => setNewOrg(e.target.value)} placeholder="e.g. Northern Plantations Ltd." />
      </Modal>
      <Modal
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${o.name}?`}
        description="This permanently deletes the organisation and everything in it."
        footer={
          <>
            <Button onClick={() => setDel(false)}>Cancel</Button>
            <Button variant="danger" disabled={delText !== o.name} onClick={remove}>
              Delete organisation
            </Button>
          </>
        }
      >
        <Input label={<>Type <b>{o.name}</b> to confirm</>} value={delText} onChange={(e) => setDelText(e.target.value)} autoComplete="off" />
      </Modal>
    </div>
  );
}
