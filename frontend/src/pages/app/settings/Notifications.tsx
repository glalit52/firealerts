/* Settings → Notifications: Web Push on this device, test notifications, subscribed devices,
 * and the organisation's "Mobile push" connector. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { connectors as connApi, push as pushApi } from "../../../api/endpoints";
import type { PushDevice } from "../../../api/types";
import { useAuth } from "../../../auth/AuthContext";
import { IconBell, IconSend, IconSmartphone, IconTrash } from "../../../components/Icons";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Notice, Switch, useConfirm } from "../../../components/ui";
import { useT } from "../../../i18n";
import type { MsgKey } from "../../../i18n";
import { fmtDateTime } from "../../../lib/format";
import { PushError, currentSubscription, disablePush, enablePush, pushSupport } from "../../../lib/push";
import { useInstallPrompt } from "../../../lib/pwa";
import { useAsync, useDocumentTitle } from "../../../lib/useAsync";

/** "Chrome on Android" style summary of a user agent. */
export function deviceName(ua: string | null | undefined): string {
  if (!ua) return "–";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

const ERRORS: Record<PushError["code"], MsgKey> = {
  denied: "push.err.denied",
  disabled: "push.err.disabled",
  unsupported: "push.err.unsupported",
  "service-worker": "push.err.sw",
  subscribe: "push.err.subscribe",
};

export default function Notifications() {
  const { t } = useT();
  useDocumentTitle(t("nav.notifications"));
  const { me, meta, can } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const support = pushSupport();
  const install = useInstallPrompt();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const vapid = useAsync(() => pushApi.vapidKey(), [], { enabled: !!me?.authenticated });
  const devices = useAsync(() => pushApi.list(), [], { enabled: !!me?.authenticated });
  const conns = useAsync(() => connApi.list(), [], { enabled: !!me?.authenticated });
  const pushConnector = conns.data?.find((c) => c.type === "push");
  const serverEnabled = vapid.data ? vapid.data.enabled && !!vapid.data.key : meta?.push_enabled;

  useEffect(() => {
    let alive = true;
    currentSubscription()
      .then((s) => {
        if (!alive) return;
        setSubscribed(!!s);
        setEndpoint(s?.endpoint ?? null);
      })
      .catch(() => alive && setSubscribed(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!me?.authenticated)
    return (
      <div className="page">
        <Card>
          <EmptyState icon={<IconBell size={20} />} title={t("push.signIn")}>
            {t("push.signInBody")}
          </EmptyState>
        </Card>
      </div>
    );

  const toggle = async (on: boolean) => {
    setBusy("toggle");
    try {
      if (on) {
        const sub = await enablePush();
        setSubscribed(true);
        setEndpoint(sub.endpoint);
        toast.success(t("push.enabled"));
      } else {
        await disablePush();
        setSubscribed(false);
        setEndpoint(null);
        toast.success(t("push.disabled"));
      }
      void devices.reload();
    } catch (err) {
      if (err instanceof PushError) toast.show(t(ERRORS[err.code]), "warning");
      else toast.error(err);
    } finally {
      if (typeof Notification !== "undefined") setPermission(Notification.permission);
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await pushApi.test();
      if (r.sent > 0) toast.success(t("push.testSent", { count: r.sent }));
      else toast.show(t("push.testNone"), "warning");
      if (r.failed > 0) toast.show(t("push.testFailed", { count: r.failed }), "warning");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const removeDevice = async (d: PushDevice) => {
    if (!(await confirm({ title: t("push.removeTitle"), body: t("push.removeBody", { device: deviceName(d.user_agent) }), confirmLabel: t("common.remove"), danger: true }))) return;
    try {
      await pushApi.remove(d.id);
      devices.setData((xs) => (xs ?? []).filter((x) => x.id !== d.id));
      // If it was this browser, also drop the local subscription.
      if (endpoint && d.endpoint_host && endpoint.includes(d.endpoint_host) && (devices.data ?? []).filter((x) => endpoint.includes(x.endpoint_host)).length <= 1) {
        const sub = await currentSubscription();
        await sub?.unsubscribe().catch(() => undefined);
        setSubscribed(false);
        setEndpoint(null);
      }
    } catch (err) {
      toast.error(err);
    }
  };

  const enableOrgPush = async () => {
    setBusy("connector");
    try {
      const c = await connApi.create({ type: "push", name: t("landing.integ.push"), config: {} });
      conns.setData((xs) => [...(xs ?? []), c]);
      toast.success(t("push.orgEnabled"));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const thisHost = endpoint ? new URL(endpoint).host : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.notifications")}</h1>
          <p>{t("push.lead")}</p>
        </div>
      </div>
      <div className="settings-layout">
        <Card title={t("push.device")} sub={t("push.deviceSub")}>
          <div className="stack">
            {support === "insecure" && <Notice kind="warn">{t("push.insecure")}</Notice>}
            {support === "unsupported" && <Notice kind="warn">{t("push.unsupported")}</Notice>}
            {support === "supported" && serverEnabled === false && <Notice kind="warn">{t("push.err.disabled")}</Notice>}
            {permission === "denied" && <Notice kind="bad">{t("push.err.denied")}</Notice>}
            <div className="row between wrap">
              <Switch
                checked={!!subscribed}
                disabled={support !== "supported" || serverEnabled === false || busy === "toggle" || subscribed === null}
                onChange={toggle}
                label={t("push.toggle")}
              />
              <div className="row">
                {subscribed && <Badge kind="ok" dot>{t("push.active")}</Badge>}
                <Button size="sm" icon={<IconSend />} loading={busy === "test"} disabled={!devices.data?.length} onClick={test}>
                  {t("push.test")}
                </Button>
              </div>
            </div>
            <div className="tiny muted">{t("push.toggleHint")}</div>
            {install && (
              <div className="row between wrap card inset" style={{ padding: 12 }}>
                <span className="small">{t("push.installHint")}</span>
                <Button size="sm" icon={<IconSmartphone />} onClick={() => void install()}>
                  {t("shell.installApp")}
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card title={t("push.devices")} sub={t("push.devicesSub")} flush>
          {devices.error ? (
            <div className="card-body">
              <ErrorState error={devices.error} onRetry={devices.reload} />
            </div>
          ) : !devices.data ? (
            <Loading />
          ) : devices.data.length === 0 ? (
            <div className="card-body small muted">{t("push.noDevices")}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("push.col.device")}</th>
                    <th>{t("push.col.service")}</th>
                    <th>{t("alert.created")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {devices.data.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <span className="row" style={{ gap: 8 }}>
                          <IconSmartphone />
                          <span className="strong">{deviceName(d.user_agent)}</span>
                          {thisHost && d.endpoint_host === thisHost && <Badge kind="info">{t("push.thisDevice")}</Badge>}
                        </span>
                      </td>
                      <td className="small muted mono">{d.endpoint_host}</td>
                      <td className="small">{fmtDateTime(d.created_at)}</td>
                      <td className="actions">
                        <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => removeDevice(d)}>
                          {t("common.remove")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={t("push.org")} sub={t("push.orgSub")}>
          <div className="stack">
            <p className="small muted">{t("push.orgExplain")}</p>
            {conns.error ? (
              <ErrorState error={conns.error} onRetry={conns.reload} />
            ) : !conns.data ? (
              <Loading />
            ) : pushConnector ? (
              <div className="row between wrap">
                <span className="row small">
                  <span className={`status-dot ${pushConnector.enabled ? "ok" : "idle"}`} />
                  {pushConnector.enabled ? t("push.orgOn", { name: pushConnector.name }) : t("push.orgOff", { name: pushConnector.name })}
                </span>
                <Link className="btn sm" to="/app/integrations">
                  {t("push.manage")}
                </Link>
              </div>
            ) : can("admin") ? (
              <div>
                <Button variant="primary" icon={<IconSmartphone />} loading={busy === "connector"} onClick={enableOrgPush}>
                  {t("push.orgEnable")}
                </Button>
              </div>
            ) : (
              <Notice kind="info">{t("push.orgAskAdmin")}</Notice>
            )}
          </div>
        </Card>
      </div>
      {dialog}
    </div>
  );
}
