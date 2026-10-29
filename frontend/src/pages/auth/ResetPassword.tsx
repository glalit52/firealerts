import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage, useToast } from "../../components/Toast";
import { Button, Input, Notice } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { signIn } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return setError("Use at least 8 characters.");
    if (pw !== pw2) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const r = await auth.resetPassword(token, pw);
      await signIn(r);
      toast.success("Password changed. You're signed in; other sessions were signed out.");
      navigate("/app", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout docTitle="Choose a new password" title="Choose a new password" footer={<Link to="/login">Back to sign in</Link>}>
      {!token ? (
        <Notice kind="bad" title="Missing token">This link is incomplete. <Link to="/forgot-password">Request a new one</Link>.</Notice>
      ) : (
        <form onSubmit={submit}>
          <Input label="New password" type="password" autoComplete="new-password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <Input label="Repeat password" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>Set password &amp; sign in</Button>
        </form>
      )}
    </AuthLayout>
  );
}
