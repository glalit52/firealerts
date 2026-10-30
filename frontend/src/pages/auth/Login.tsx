import { useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage } from "../../components/Toast";
import { Button, Input } from "../../components/ui";
import { AuthLayout, safeNext } from "./AuthLayout";
import { useT } from "../../i18n";

export default function Login() {
  const { me, signIn, loading } = useAuth();
  const { t } = useT();
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
      docTitle={t("common.signIn")}
      title={t("auth.login.title")}
      lead={t("auth.login.lead")}
      footer={
        <>
          {me?.registration_open !== false ? (
            <>
              {t("auth.login.newHere")} <Link to={`/register${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>{t("auth.login.createAccount")}</Link>
            </>
          ) : (
            t("auth.login.byInvitation")
          )}
          {me && !me.auth_required && (
            <div className="mt-8">
              {t("auth.login.or")} <Link to="/app">{t("auth.login.continue")}</Link>
            </div>
          )}
          {me?.auth_required !== false && (
            <div className="mt-8">
              <Link to="/live">{t("auth.login.publicMap")}</Link>
            </div>
          )}
        </>
      }
    >
      <form onSubmit={submit} noValidate={false}>
        <Input label={t("common.email")} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Input
          label={
            <span className="row between" style={{ width: "100%" }}>
              {t("common.password")} <Link to="/forgot-password" className="small" style={{ fontWeight: 500 }}>{t("auth.login.forgot")}</Link>
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
          {t("common.signIn")}
        </Button>
      </form>
    </AuthLayout>
  );
}
