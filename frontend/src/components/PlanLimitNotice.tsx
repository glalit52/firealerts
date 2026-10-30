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
      if (err instanceof ApiError && err.status === 501) toast.show("Online billing isn't enabled on this server. Contact your administrator to change plans.", "warning", "Billing unavailable", 7000);
      else toast.error(err);
      setBusy(null);
    }
  };
  return { start, busy };
}

export function UpgradeButton({ plan, label, variant = "primary", size }: { plan: string; label?: string; variant?: "primary" | "default"; size?: "sm" | "md" | "lg" }) {
  const { meta, can } = useAuth();
  const { start, busy } = useCheckout();
  const planLabel = meta?.plans[plan]?.label ?? plan;
  if (!meta?.billing_enabled) return null;
  return (
    <Button variant={variant} size={size} icon={<IconZap />} loading={busy === plan} disabled={!can("owner")} title={can("owner") ? undefined : "Only organisation owners can change the plan"} onClick={() => start(plan)}>
      {label ?? `Upgrade to ${planLabel}`}
    </Button>
  );
}

export function PlanLimitNotice() {
  const { planNotice, clearPlanNotice, me, meta, can } = useAuth();
  const navigate = useNavigate();
  const current = me?.org?.plan ?? "free";
  const order = Object.keys(meta?.plans ?? {});
  const higher = order.slice(order.indexOf(current) + 1);
  return (
    <Modal
      open={!!planNotice}
      onClose={clearPlanNotice}
      title="You've reached your plan's limit"
      description={planNotice ?? undefined}
      footer={
        <>
          <Button onClick={clearPlanNotice}>Not now</Button>
          <Button
            onClick={() => {
              clearPlanNotice();
              navigate("/app/settings/organization");
            }}
          >
            View plan &amp; usage
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
                {meta?.billing_enabled && can("owner") && <UpgradeButton plan={p} size="sm" variant="default" label="Choose" />}
              </div>
              <div className="small muted mt-4">
                {l.assets == null ? "Unlimited" : fmtNum(l.assets)} assets · {l.members == null ? "unlimited" : fmtNum(l.members)} members · {l.connectors == null ? "unlimited" : fmtNum(l.connectors)} integrations ·{" "}
                {l.max_asset_ha == null ? "any asset size" : `assets up to ${fmtNum(l.max_asset_ha)} ha`}
              </div>
            </div>
          );
        })}
        {!meta?.billing_enabled && <div className="small muted">To change plans, contact your Firealerts administrator.</div>}
        {meta?.billing_enabled && !can("owner") && <div className="small muted">Ask an organisation owner to upgrade.</div>}
      </div>
    </Modal>
  );
}
