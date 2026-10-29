import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage, useToast } from "../../components/Toast";
import { Button, Input, Notice, Segmented, Spinner } from "../../components/ui";
import { useAsync } from "../../lib/useAsync";
import { AuthLayout } from "./AuthLayout";

export default function Invite() {
  const { token = "" } = useParams();
  const { me, signIn, switchOrg, refresh } = useAuth();
  const toast = useToast();
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
    toast.success(`You joined ${info.data?.org_name}`);
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
        toast.success(`Welcome! You joined ${info.data?.org_name}`);
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

  if (info.loading) return <AuthLayout docTitle="Invitation" title="Invitation"><div className="row"><Spinner /> Loading invitation…</div></AuthLayout>;
  if (info.error || !info.data)
    return (
      <AuthLayout docTitle="Invitation" title="Invitation">
        <Notice kind="bad" title="This invitation can't be used">{info.error?.message ?? "Not found"}. Ask the sender for a new invite.</Notice>
      </AuthLayout>
    );

  const inv = info.data;
  return (
    <AuthLayout docTitle="Invitation" title={`Join ${inv.org_name}`} lead={<>You've been invited as <b>{inv.role}</b> ({inv.email}).</>}>
      {me?.authenticated && me.user ? (
        <div className="stack">
          {me.user.email.toLowerCase() !== inv.email.toLowerCase() && (
            <Notice kind="warn">You're signed in as {me.user.email}, but this invite was sent to {inv.email}. Sign out and use that address, or ask for a new invite.</Notice>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button variant="primary" size="lg" block loading={busy} onClick={accept}>Accept invitation</Button>
        </div>
      ) : (
        <div className="stack">
          <Segmented value={mode} onChange={setMode} options={[{ value: "register", label: "I'm new" }, { value: "login", label: "I have an account" }]} label="Account" />
          <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
            {mode === "register" && <Input label="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
            <Input label="E-mail" type="email" required value={email || inv.email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" hint={mode === "register" ? "Must match the invited address." : undefined} />
            <Input label="Password" type="password" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} />
            {error && <div className="form-error" role="alert">{error}</div>}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>{mode === "register" ? "Create account & join" : "Sign in & join"}</Button>
          </form>
        </div>
      )}
    </AuthLayout>
  );
}
