import { Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { auth as authApi, alerts as alertsApi, orgs, system } from "../../api/endpoints";
import type { Status } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  FlameLogo, IconBell, IconBuilding, IconChevronDown, IconDashboard, IconDatabase, IconKey, IconLogout, IconMap, IconMenu, IconPlug, IconPlus,
  IconShield, IconTree, IconUser, IconUsers, IconX, IconCheck,
} from "../../components/Icons";
import { useToast } from "../../components/Toast";
import { Badge, Button, Input, Modal, Spinner } from "../../components/ui";
import { initials, timeAgo } from "../../lib/format";

const NAV = [
  { to: "/app", label: "Overview", icon: IconDashboard, end: true },
  { to: "/app/map", label: "Live map", icon: IconMap },
  { to: "/app/assets", label: "Forests & assets", icon: IconTree },
  { to: "/app/alerts", label: "Alerts", icon: IconBell },
  { to: "/app/integrations", label: "Integrations", icon: IconPlug },
  { to: "/app/data", label: "Data", icon: IconDatabase },
];
const SETTINGS = [
  { to: "/app/settings/profile", label: "Profile", icon: IconUser, needsUser: true },
  { to: "/app/settings/organization", label: "Organisation", icon: IconBuilding },
  { to: "/app/settings/team", label: "Team", icon: IconUsers },
  { to: "/app/settings/api-keys", label: "API keys", icon: IconKey, needsUser: true },
];

function useClickOutside(open: boolean, close: () => void, cls: string) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(`.${cls}`)) close();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open, close, cls]);
}

function OrgSwitcher() {
  const { me, switchOrg } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useClickOutside(open, () => setOpen(false), "org-switch");
  if (!me?.org) return null;
  const canSwitch = me.authenticated && me.memberships.length > 0;
  return (
    <div className="org-switch">
      <button className="org-btn" onClick={() => canSwitch && setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} disabled={!canSwitch}>
        <span className="org-mark">{initials(me.org.name)}</span>
        <span className="truncate">
          <span className="org-name truncate">{me.org.name}</span>
          <span className="org-plan">{me.org.limits?.label ?? me.org.plan} plan</span>
        </span>
        {canSwitch && <IconChevronDown />}
      </button>
      {open && (
        <div className="menu" role="menu" style={{ left: 0, right: "auto", minWidth: 260 }}>
          <div className="menu-label">Organisations</div>
          {me.memberships.map((m) => (
            <button
              key={m.org_id}
              role="menuitem"
              className="menu-item"
              onClick={async () => {
                setOpen(false);
                if (m.org_id !== me.org!.id) {
                  await switchOrg(m.org_id);
                  toast.success(`Switched to ${m.org_name}`);
                  navigate("/app");
                }
              }}
            >
              <span className="org-mark sm">{initials(m.org_name)}</span>
              <span className="grow truncate">{m.org_name}</span>
              <span className="tiny muted">{m.role}</span>
              {m.org_id === me.org!.id && <IconCheck size={14} className="ok-text" />}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            <IconPlus /> New organisation
          </button>
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New organisation"
        description="Organisations keep assets, alerts, integrations and team members separate. You'll be its owner."
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const o = await orgs.create(name.trim());
                  setCreating(false);
                  setName("");
                  await switchOrg(o.id);
                  toast.success(`Created ${o.name}`);
                  navigate("/app");
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create organisation
            </Button>
          </>
        }
      >
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sierra Fire Brigade" autoFocus />
      </Modal>
    </div>
  );
}

function UserMenu() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useClickOutside(open, () => setOpen(false), "user-menu");
  if (!me?.authenticated || !me.user) {
    return (
      <div className="row">
        <Link className="btn sm ghost" to="/login">
          Sign in
        </Link>
        {me?.registration_open && (
          <Link className="btn sm primary hide-sm" to="/register">
            Create account
          </Link>
        )}
      </div>
    );
  }
  const u = me.user;
  return (
    <div className="user-menu">
      <button className="user-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        <span className="avatar">{initials(u.name || u.email)}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ padding: "8px 10px" }}>
            <div className="strong truncate">{u.name || u.email}</div>
            <div className="small muted truncate">{u.email}</div>
            <div className="mt-4">
              <Badge>{me.role}</Badge> {u.is_superuser && <Badge kind="accent">superuser</Badge>}
            </div>
          </div>
          <div className="menu-sep" />
          {SETTINGS.map((s) => (
            <button key={s.to} role="menuitem" className="menu-item" onClick={() => (setOpen(false), navigate(s.to))}>
              <s.icon /> {s.label}
            </button>
          ))}
          {u.is_superuser && (
            <button role="menuitem" className="menu-item" onClick={() => (setOpen(false), navigate("/app/admin"))}>
              <IconShield /> Platform admin
            </button>
          )}
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={async () => {
              setOpen(false);
              await signOut();
              navigate(me.auth_required ? "/login" : "/app");
            }}
          >
            <IconLogout /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function VerifyBanner() {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  if (!me?.authenticated || !me.user || me.user.email_verified || hidden) return null;
  return (
    <div className="banner warn" role="status">
      <span className="grow">
        Please confirm your e-mail address <b>{me.user.email}</b>
        {me.require_email_verification ? " to receive alerts and invite your team." : "."}{" "}
        {link && (
          <>
            Dev link: <a href={link}>{link}</a>
          </>
        )}
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await authApi.resendVerification();
            if (r.already_verified) toast.success("Your e-mail is already confirmed.");
            else toast.success(r.emailed ? "Confirmation e-mail sent." : "Confirmation link created (e-mail is not configured on this server).");
            if (r.dev_link) setLink(r.dev_link);
          } catch (err) {
            toast.error(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        Resend e-mail
      </Button>
      <button className="close-btn" aria-label="Dismiss" onClick={() => setHidden(true)}>
        <IconX size={14} />
      </button>
    </div>
  );
}

export default function Shell() {
  const { me, epoch, sessionExpired, meta } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [openAlerts, setOpenAlerts] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const toast = useToast();

  useEffect(() => setNavOpen(false), [loc.pathname]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      alertsApi
        .stats(30)
        .then((s) => alive && setOpenAlerts(s.open))
        .catch(() => undefined);
      system
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener("fa:alerts-changed", onFocus);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("fa:alerts-changed", onFocus);
    };
  }, [epoch]);

  useEffect(() => {
    const p = new URLSearchParams(loc.search).get("billing");
    if (p === "success") toast.success("Thanks! Your plan is being updated; it can take a few seconds to show.");
    if (p === "cancelled") toast.show("Checkout cancelled. Your plan hasn't changed.", "info");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mode = status?.active_mode || status?.data_mode || meta?.data_mode;
  const isMap = loc.pathname === "/app/map";

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand">
          <Link to="/app" className="brand">
            <span className="logo">
              <FlameLogo size={20} />
            </span>
            Firealerts
          </Link>
          <button className="close-btn show-sm" onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <IconX />
          </button>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <n.icon />
              <span className="grow">{n.label}</span>
              {n.to === "/app/alerts" && openAlerts ? <span className="nav-count">{openAlerts > 99 ? "99+" : openAlerts}</span> : null}
            </NavLink>
          ))}
          <div className="nav-section">Settings</div>
          {SETTINGS.filter((s) => !s.needsUser || me?.authenticated).map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <n.icon />
              <span className="grow">{n.label}</span>
            </NavLink>
          ))}
          {me?.user?.is_superuser && (
            <NavLink to="/app/admin" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <IconShield />
              <span className="grow">Platform admin</span>
            </NavLink>
          )}
        </nav>
        <div className="sidebar-foot">
          {status && (
            <div className="feed-status">
              <span className={`status-dot ${status.runs[0]?.errors?.length ? "warn" : "ok"}`} />
              <span className="grow">
                <span className="small">{mode === "live" ? "Live feeds" : mode === "demo" ? "Demo data" : "Feeds"}</span>
                <span className="tiny muted" style={{ display: "block" }}>
                  Synced {timeAgo(status.runs[0]?.finished_at)}
                </span>
              </span>
            </div>
          )}
          {!me?.authenticated && !me?.auth_required && <div className="tiny muted" style={{ padding: "8px 12px 0" }}>Single-user mode: no sign-in required.</div>}
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="main-col">
        <header className="topbar">
          <button className="btn icon ghost show-sm" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <IconMenu />
          </button>
          <OrgSwitcher />
          <div className="grow" />
          {mode && (
            <Badge kind={mode === "live" ? "live" : "warn"} title={mode === "demo" ? "Synthetic demo fires (DATA_MODE=demo or feeds unreachable)" : "Live satellite feeds"} dot>
              {mode === "live" ? "LIVE" : mode.toUpperCase()}
            </Badge>
          )}
          <Link to="/app/alerts?status=open" className="bell" aria-label={`Alerts${openAlerts ? `: ${openAlerts} open` : ""}`} title="Open alerts">
            <IconBell size={18} />
            {openAlerts ? <span className="bell-count">{openAlerts > 99 ? "99+" : openAlerts}</span> : null}
          </Link>
          <UserMenu />
        </header>
        {sessionExpired && !me?.authenticated && (
          <div className="banner bad">
            <span className="grow">Your session has expired.</span>
            <Link className="btn sm" to={`/login?next=${encodeURIComponent(loc.pathname)}`}>
              Sign in again
            </Link>
          </div>
        )}
        <VerifyBanner />
        <main ref={mainRef} className={`main ${isMap ? "main-map" : ""}`} id="main">
          <Suspense
            fallback={
              <div className="page-loading">
                <Spinner size="lg" />
              </div>
            }
          >
            <Outlet key={epoch} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
