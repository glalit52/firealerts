import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage, useToast } from "../../components/Toast";
import { Button, Input, Notice, Segmented, Spinner } from "../../components/ui";
import { useAsync } from "../../lib/useAsync";
import { AuthLayout } from "./AuthLayout";
import { tEnum, useT } from "../../i18n";

export default function Invite() {
  const { token = "" } = useParams();
  const { me, signIn, switchOrg, refresh } = useAuth();
  const toast = useToast();
  const { t } = useT();
  const navigate = useNavigate();
  const info = useAsync(() => auth.inviteInfo(token), [token]);
  const [mode, setMode] = useState<"register" | "login">("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (orgId: number) => {
    await refresh();
    await switchOrg(orgId);
    toast.success(t("auth.invite.joined", { org: info.data?.org_name ?? "" }));
    navigate("/app", { replace: true });
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await auth.acceptInvite(token);
      await finish(r.org_id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const addr = email || info.data?.email || "";
    try {
      if (mode === "register") {
        const r = await auth.register({ email: addr, password, name, invite_token: token });
        const target = r.memberships.find((m) => m.org_name === info.data?.org_name) ?? r.memberships[0];
        await signIn(r, target?.org_id);
        toast.success(t("auth.invite.welcome", { org: info.data?.org_name ?? "" }));
        navigate("/app", { replace: true });
      } else {
        const r = await auth.login({ email: addr, password });
        await signIn(r);
        const a = await auth.acceptInvite(token);
        await finish(a.org_id);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (info.loading) return <AuthLayout docTitle={t("auth.invite.doc")} title={t("auth.invite.doc")}><div className="row"><Spinner /> {t("auth.invite.loading")}</div></AuthLayout>;
  if (info.error || !info.data)
    return (
      <AuthLayout docTitle={t("auth.invite.doc")} title={t("auth.invite.doc")}>
        <Notice kind="bad" title={t("auth.invite.unusable")}>{info.error?.message ?? t("api.notFound")}. {t("auth.invite.askNew")}</Notice>
      </AuthLayout>
    );

  const inv = info.data;
  return (
    <AuthLayout docTitle={t("auth.invite.doc")} title={t("auth.invite.join", { org: inv.org_name })} lead={<>{t("auth.invite.invitedAs")} <b>{tEnum("role", inv.role)}</b> ({inv.email}).</>}>
      {me?.authenticated && me.user ? (
        <div className="stack">
          {me.user.email.toLowerCase() !== inv.email.toLowerCase() && (
            <Notice kind="warn">{t("auth.invite.mismatch", { me: me.user.email, email: inv.email })}</Notice>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button variant="primary" size="lg" block loading={busy} onClick={accept}>{t("auth.invite.accept")}</Button>
        </div>
      ) : (
        <div className="stack">
          <Segmented value={mode} onChange={setMode} options={[{ value: "register", label: t("auth.invite.new") }, { value: "login", label: t("auth.invite.have") }]} label={t("auth.invite.account")} />
          <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
            {mode === "register" && <Input label={t("common.yourName")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
            <Input label={t("common.email")} type="email" required value={email || inv.email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" hint={mode === "register" ? t("auth.invite.match") : undefined} />
            <Input label={t("common.password")} type="password" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} />
            {error && <div className="form-error" role="alert">{error}</div>}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>{mode === "register" ? t("auth.invite.createJoin") : t("auth.invite.signInJoin")}</Button>
          </form>
        </div>
      )}
    </AuthLayout>
  );
}
