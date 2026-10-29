import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import type { Verification } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage } from "../../components/Toast";
import { Button, ButtonLink, Input, Notice } from "../../components/ui";
import { AuthLayout, safeNext } from "./AuthLayout";

export default function Register() {
  const { me, signIn } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const [form, setForm] = useState({ name: "", email: "", password: "", org_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await auth.register(form);
      await signIn(r);
      if (r.verification?.dev_link) setVerification(r.verification);
      else navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (verification) {
    return (
      <AuthLayout docTitle="Account created" title="Welcome to Firealerts" lead="Your account and organisation are ready.">
        <div className="stack">
          <Notice kind="info" title="Confirm your e-mail">
            {verification.emailed ? "We sent you a confirmation link." : "E-mail delivery isn't configured on this server."} Development link:{" "}
            <a href={verification.dev_link} style={{ wordBreak: "break-all" }}>{verification.dev_link}</a>
          </Notice>
          <ButtonLink to={next} variant="primary" size="lg">
            Open the app
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }

  const closed = me?.registration_open === false;
  return (
    <AuthLayout
      docTitle="Create account"
      title="Create your account"
      lead="You'll get your own organisation and can invite your team afterwards."
      footer={
        <>
          Already have an account? <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign in</Link>
        </>
      }
    >
      {closed ? (
        <Notice kind="warn" title="Registration is by invitation">Ask an administrator of your organisation to invite you.</Notice>
      ) : (
        <form onSubmit={submit}>
          <Input label="Your name" autoComplete="name" value={form.name} onChange={set("name")} autoFocus />
          <Input label="Work e-mail" type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
          <Input label="Password" type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set("password")} hint="At least 8 characters." />
          <Input label="Organisation name" value={form.org_name} onChange={set("org_name")} placeholder="e.g. Sierra Forestry Co." />
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Create account
          </Button>
          <p className="tiny muted" style={{ textAlign: "center" }}>Free plan · no credit card required</p>
        </form>
      )}
    </AuthLayout>
  );
}
