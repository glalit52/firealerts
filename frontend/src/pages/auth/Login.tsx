import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage } from "../../components/Toast";
import { Button, Input } from "../../components/ui";
import { AuthLayout, safeNext } from "./AuthLayout";

export default function Login() {
  const { me, signIn, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && me?.authenticated) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await auth.login({ email, password });
      await signIn(r);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      docTitle="Sign in"
      title="Sign in to Firealerts"
      lead="Monitor fires, forecasts and alerts for your organisation."
      footer={
        <>
          {me?.registration_open !== false ? (
            <>
              New here? <Link to={`/register${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link>
            </>
          ) : (
            "Registration is by invitation."
          )}
          {me && !me.auth_required && (
            <div className="mt-8">
              Or <Link to="/app">continue without signing in</Link>
            </div>
          )}
        </>
      }
    >
      <form onSubmit={submit} noValidate={false}>
        <Input label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Input
          label={
            <span className="row between" style={{ width: "100%" }}>
              Password <Link to="/forgot-password" className="small" style={{ fontWeight: 500 }}>Forgot password?</Link>
            </span>
          }
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="form-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
