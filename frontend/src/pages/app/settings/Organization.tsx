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
import { LOCALES, LOCALE_NAMES, getLocale, isLocale, tEnum, useT } from "../../../i18n";
import type { Locale } from "../../../i18n";

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
  const { t } = useT();
  useDocumentTitle(t("nav.organization"));
  const { me, meta, can, refresh, switchOrg } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const org = useAsync(() => orgs.get(), []);
  const bill = useAsync(() => billing.status(), [], { enabled: !!meta?.billing_enabled });
  const [name, setName] = useState("");
  const [tz, setTz] = useState("UTC");
  const [digest, setDigest] = useState(true);
  const [buffer, setBuffer] = useState(2);
  const [lang, setLang] = useState<Locale>(getLocale());
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
    setLang(isLocale(org.data.settings.language) ? org.data.settings.language : "en");
  }, [org.data]);

  const admin = can("admin");
  const save = async () => {
    setSaving(true);
    try {
      await orgs.update({ name: name.trim(), settings: { ...org.data?.settings, timezone: tz, daily_digest: digest, default_buffer_km: buffer, language: lang } });
      await Promise.all([org.reload(), refresh()]);
      toast.success(t("org.saved"));
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
      toast.success(t("org.createdViewing", { org: o.name }));
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
      toast.success(t("org.deleted"));
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
  if (!org.data) return <Loading label={t("org.loading")} />;
  const o = org.data;
  const planKeys = Object.keys(meta?.plans ?? {});
  const higher = planKeys.slice(planKeys.indexOf(o.plan) + 1).filter((p) => !bill.data || bill.data.purchasable.includes(p));
  const tzs = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.organization")}</h1>
          <p>
            {o.name} · {t("org.createdOn", { date: fmtDate(o.created_at) })} · {t("org.youAre")} <b>{tEnum("role", o.role)}</b>
          </p>
        </div>
        {me?.authenticated && (
          <Button onClick={() => setNewOrg("")}>{t("shell.newOrg")}</Button>
        )}
      </div>
      <div className="settings-layout">
        <Card title={t("org.planUsage")} actions={<Badge kind="accent">{o.limits.label}</Badge>}>
          <UsageRow label={t("live.tab.assets")} used={o.usage.assets} limit={o.limits.assets} />
          <UsageRow label={t("org.teamMembers")} used={o.usage.members} limit={o.limits.members} />
          <UsageRow label={t("nav.integrations")} used={o.usage.connectors} limit={o.limits.connectors} />
          <div className="small muted mt-8">
            {t("org.limits", {
              size: o.limits.max_asset_ha == null ? t("common.unlimitedLower") : `${fmtNum(o.limits.max_asset_ha)} ha`,
              keys: o.limits.api_keys ?? t("common.unlimitedLower"),
              members: o.limits.forecast_members ?? "–",
            })}
          </div>
          <div className="row wrap mt-16">
            {meta?.billing_enabled ? (
              <>
                {higher.map((p) => (
                  <UpgradeButton key={p} plan={p} variant={p === higher[0] ? "primary" : "default"} />
                ))}
                {bill.data?.has_customer && can("owner") && (
                  <Button loading={portalBusy} onClick={portal}>
                    {t("org.manageBilling")}
                  </Button>
                )}
                {!can("owner") && <span className="small muted">{t("org.ownersOnly")}</span>}
              </>
            ) : (
              <span className="small muted">{t("plan.contactAdmin")}</span>
            )}
          </div>
        </Card>

        <Card title={t("nav.settings")} footer={admin ? <Button variant="primary" loading={saving} onClick={save} disabled={!name.trim()}>{t("org.saveSettings")}</Button> : undefined}>
          {!admin && <div className="mb-12"><Notice kind="info">{t("org.adminsOnly")}</Notice></div>}
          <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }} className="form-grid">
            <Input label={t("auth.register.orgName")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Select label={t("org.timezone")} value={tz} onChange={(e) => setTz(e.target.value)} hint={t("org.timezoneHint")} options={tzs.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />
            <Input label={t("org.buffer")} type="number" min={0} max={100} step={0.5} value={buffer} onChange={(e) => setBuffer(+e.target.value)} hint={t("org.bufferHint")} />
            <Select
              label={t("org.language")}
              value={lang}
              onChange={(e) => isLocale(e.target.value) && setLang(e.target.value)}
              hint={t("org.languageHint")}
              options={LOCALES.filter((l) => !meta?.languages || meta.languages.includes(l)).map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
            />
            <div className="field full" style={{ justifyContent: "center" }}>
              <Switch checked={digest} onChange={setDigest} label={t("org.digest")} />
            </div>
          </fieldset>
        </Card>

        {can("owner") && (
          <Card title={t("profile.danger")}>
            <div className="row between wrap">
              <div className="small muted" style={{ maxWidth: 520 }}>{t("org.deleteLead")}</div>
              <Button variant="danger" onClick={() => setDel(true)}>
                {t("org.delete")}
              </Button>
            </div>
          </Card>
        )}
      </div>

      <Modal
        open={newOrg !== null}
        onClose={() => setNewOrg(null)}
        title={t("shell.newOrg")}
        description={t("org.newDesc")}
        footer={
          <>
            <Button onClick={() => setNewOrg(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={creating} disabled={!newOrg?.trim()} onClick={create}>
              {t("common.create")}
            </Button>
          </>
        }
      >
        <Input label={t("common.name")} value={newOrg ?? ""} onChange={(e) => setNewOrg(e.target.value)} placeholder={t("org.newPh")} />
      </Modal>
      <Modal
        open={del}
        onClose={() => setDel(false)}
        title={t("asset.deleteTitle", { name: o.name })}
        description={t("org.deleteDesc")}
        footer={
          <>
            <Button onClick={() => setDel(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={delText !== o.name} onClick={remove}>
              {t("org.delete")}
            </Button>
          </>
        }
      >
        <Input label={<>{t("confirm.typePre")} <b>{o.name}</b> {t("confirm.typePost")}</>} value={delText} onChange={(e) => setDelText(e.target.value)} autoComplete="off" />
      </Modal>
    </div>
  );
}
