/* Global upgrade notice for HTTP 402 plan-limit responses, plus a reusable checkout button. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { billing } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { fmtNum } from "../lib/format";
import { IconZap } from "./Icons";
import { useToast } from "./Toast";
import { Button, Modal } from "./ui";
import { t as tr, useT } from "../i18n";

/** Start Stripe Checkout for a plan; falls back to a clear message when billing is disabled (501). */
export function useCheckout() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (plan: string) => {
    setBusy(plan);
    try {
      const { url } = await billing.checkout(plan);
      window.location.assign(url);
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) toast.show(tr("plan.billingOff"), "warning", tr("plan.billingOffTitle"), 7000);
      else toast.error(err);
      setBusy(null);
    }
  };
  return { start, busy };
}

export function UpgradeButton({ plan, label, variant = "primary", size }: { plan: string; label?: string; variant?: "primary" | "default"; size?: "sm" | "md" | "lg" }) {
  const { meta, can } = useAuth();
  const { start, busy } = useCheckout();
  const { t } = useT();
  const planLabel = meta?.plans[plan]?.label ?? plan;
  if (!meta?.billing_enabled) return null;
  return (
    <Button variant={variant} size={size} icon={<IconZap />} loading={busy === plan} disabled={!can("owner")} title={can("owner") ? undefined : t("plan.ownersOnly")} onClick={() => start(plan)}>
      {label ?? t("plan.upgradeTo", { plan: planLabel })}
    </Button>
  );
}

export function PlanLimitNotice() {
  const { planNotice, clearPlanNotice, me, meta, can } = useAuth();
  const navigate = useNavigate();
  const { t } = useT();
  const current = me?.org?.plan ?? "free";
  const order = Object.keys(meta?.plans ?? {});
  const higher = order.slice(order.indexOf(current) + 1);
  return (
    <Modal
      open={!!planNotice}
      onClose={clearPlanNotice}
      title={t("plan.limitTitle")}
      description={planNotice ?? undefined}
      footer={
        <>
          <Button onClick={clearPlanNotice}>{t("plan.notNow")}</Button>
          <Button
            onClick={() => {
              clearPlanNotice();
              navigate("/app/settings/organization");
            }}
          >
            {t("plan.viewUsage")}
          </Button>
          {meta?.billing_enabled && higher[0] && can("owner") && <UpgradeButton plan={higher[0]} />}
        </>
      }
    >
      <div className="stack">
        {higher.map((p) => {
          const l = meta!.plans[p]!;
          return (
            <div key={p} className="card inset" style={{ padding: 14 }}>
              <div className="row between">
                <b>{l.label}</b>
                {meta?.billing_enabled && can("owner") && <UpgradeButton plan={p} size="sm" variant="default" label={t("plan.choose")} />}
              </div>
              <div className="small muted mt-4">
                {t("plan.summary", {
                  assets: l.assets == null ? t("common.unlimitedLower") : fmtNum(l.assets),
                  members: l.members == null ? t("common.unlimitedLower") : fmtNum(l.members),
                  integrations: l.connectors == null ? t("common.unlimitedLower") : fmtNum(l.connectors),
                })}{" "}
                · {l.max_asset_ha == null ? t("plan.anySize") : t("plan.maxSize", { ha: fmtNum(l.max_asset_ha) })}
              </div>
            </div>
          );
        })}
        {!meta?.billing_enabled && <div className="small muted">{t("plan.contactAdmin")}</div>}
        {meta?.billing_enabled && !can("owner") && <div className="small muted">{t("plan.askOwner")}</div>}
      </div>
    </Modal>
  );
}
