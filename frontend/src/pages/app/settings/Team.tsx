import { useState } from "react";
import type { FormEvent } from "react";
import { orgs } from "../../../api/endpoints";
import type { InviteCreated, Member, Role } from "../../../api/types";
import { useAuth } from "../../../auth/AuthContext";
import { IconTrash } from "../../../components/Icons";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, CopyButton, ErrorState, Input, Loading, Notice, Select, useConfirm } from "../../../components/ui";
import { fmtDateTime, initials, timeAgo } from "../../../lib/format";
import { useAsync, useDocumentTitle } from "../../../lib/useAsync";
import { tEnum, useT } from "../../../i18n";

export default function Team() {
  const { t } = useT();
  useDocumentTitle(t("nav.team"));
  const { me, can, refresh } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const team = useAsync(() => orgs.members(), []);
  const audit = useAsync(() => orgs.audit(100), [], { enabled: can("admin") });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<InviteCreated | null>(null);
  const roles: Role[] = ["viewer", "member", "admin", "owner"];
  const owner = can("owner");
  const admin = can("admin");
  const myId = me?.user?.id;
  const owners = (team.data?.members ?? []).filter((m) => m.role === "owner").length;

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await orgs.invite(email.trim(), role);
      setInvite(r);
      setEmail("");
      void team.reload();
      void audit.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (m: Member, r: Role) => {
    try {
      await orgs.setRole(m.user_id, r);
      toast.success(t("team.roleSet", { name: m.name || m.email, role: tEnum("role", r) }));
      void team.reload();
      if (m.user_id === myId) void refresh();
    } catch (err) {
      toast.error(err);
      void team.reload();
    }
  };

  const removeMember = async (m: Member) => {
    const self = m.user_id === myId;
    if (!(await confirm({ title: self ? t("team.leaveTitle", { org: me?.org?.name ?? "" }) : t("team.removeTitle", { name: m.name || m.email }), body: self ? t("team.leaveBody") : t("team.removeBody"), confirmLabel: self ? t("team.leave") : t("common.remove"), danger: true }))) return;
    try {
      await orgs.removeMember(m.user_id);
      if (self) {
        window.location.assign("/app");
        return;
      }
      void team.reload();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.team")}</h1>
          <p>{t("team.lead", { org: me?.org?.name ?? "" })}</p>
        </div>
      </div>
      <div className="settings-layout">
        {admin && me?.authenticated && (
          <Card title={t("team.invite")} sub={t("team.inviteSub")}>
            <form onSubmit={sendInvite} className="row wrap" style={{ alignItems: "flex-end" }}>
              <Input fieldClassName="grow" label={t("common.email")} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("team.emailPh")} />
              <Select label={t("team.role")} value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: 150 }}>
                {roles
                  .filter((r) => owner || r !== "owner")
                  .map((r) => (
                    <option key={r} value={r}>
                      {tEnum("roleName", r)}
                    </option>
                  ))}
              </Select>
              <Button type="submit" variant="primary" loading={busy}>
                {t("team.createInvite")}
              </Button>
            </form>
            <div className="tiny muted mt-8">{t(`team.help.${role}`)}.</div>
            {invite && (
              <div className="stack tight mt-16">
                <Notice kind="ok" title={invite.emailed ? t("team.emailed", { email: invite.email }) : t("team.createdFor", { email: invite.email })}>
                  {invite.emailed ? t("team.shareToo") : t("team.shareOnly")}
                </Notice>
                <div className="row">
                  <div className="secret-box grow">{invite.invite_url}</div>
                  <CopyButton text={invite.invite_url} />
                </div>
              </div>
            )}
          </Card>
        )}
        {admin && !me?.authenticated && <Notice kind="info">{t("team.signInToInvite")}</Notice>}

        <Card title={t("admin.members")} flush>
          {team.error ? (
            <div className="card-body"><ErrorState error={team.error} onRetry={team.reload} /></div>
          ) : !team.data ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("roleName.member")}</th>
                    <th>{t("team.role")}</th>
                    <th>{t("team.joined")}</th>
                    <th>{t("admin.lastSignIn")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {team.data.members.map((m) => {
                    const lastOwner = m.role === "owner" && owners <= 1;
                    return (
                      <tr key={m.user_id}>
                        <td>
                          <div className="row">
                            <span className="avatar">{initials(m.name || m.email)}</span>
                            <div style={{ minWidth: 0 }}>
                              <div className="strong truncate">
                                {m.name || m.email} {m.user_id === myId && <Badge>{t("common.you")}</Badge>}
                              </div>
                              <div className="tiny muted truncate">{m.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          {owner && !lastOwner ? (
                            <Select inputSize="sm" value={m.role} onChange={(e) => changeRole(m, e.target.value as Role)} aria-label={t("team.roleOf", { email: m.email })} style={{ width: 120 }}>
                              {roles.map((r) => (
                                <option key={r} value={r}>
                                  {tEnum("roleName", r)}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <Badge kind={m.role === "owner" ? "accent" : undefined}>{tEnum("role", m.role)}</Badge>
                          )}
                        </td>
                        <td className="small">{fmtDateTime(m.joined_at)}</td>
                        <td className="small muted">{m.last_login_at ? timeAgo(m.last_login_at) : t("common.never")}</td>
                        <td className="actions">
                          {(admin || m.user_id === myId) && !lastOwner && !(m.role === "owner" && !owner) && (
                            <Button size="sm" variant="ghost" onClick={() => removeMember(m)}>
                              {m.user_id === myId ? t("team.leave") : t("common.remove")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {team.data && team.data.pending_invites.length > 0 && (
          <Card title={t("team.pending")} flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("common.email")}</th>
                    <th>{t("team.role")}</th>
                    <th>{t("team.sent")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {team.data.pending_invites.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td>
                      <td><Badge>{tEnum("role", i.role)}</Badge></td>
                      <td className="small muted">{timeAgo(i.created_at)}</td>
                      <td className="actions">
                        {admin && (
                          <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={async () => {
                            try {
                              await orgs.revokeInvite(i.id);
                              void team.reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}>
                            {t("keys.revoke")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {admin && (
          <Card title={t("team.audit")} sub={t("team.auditSub")} flush>
            {audit.error ? (
              <div className="card-body"><ErrorState error={audit.error} onRetry={audit.reload} /></div>
            ) : !audit.data ? (
              <Loading />
            ) : audit.data.length === 0 ? (
              <div className="card-body small muted">{t("team.noActivity")}</div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>{t("team.when")}</th>
                      <th>{t("team.who")}</th>
                      <th>{t("team.action")}</th>
                      <th>{t("team.target")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.map((e) => (
                      <tr key={e.id}>
                        <td className="small nowrap" title={fmtDateTime(e.created_at)}>{timeAgo(e.created_at)}</td>
                        <td className="small">{e.user_email ?? (e.user_id ? `#${e.user_id}` : t("common.system"))}</td>
                        <td><span className="mono tiny">{e.action}</span></td>
                        <td className="small truncate" style={{ maxWidth: 260 }}>
                          {e.target}
                          {Object.keys(e.data ?? {}).length > 0 && <span className="tiny muted"> {Object.entries(e.data).map(([k, v]) => `${k}=${String(v)}`).join(" ")}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
      {dialog}
    </div>
  );
}
