import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage, useToast } from "../../components/Toast";
import { Button, Input, Notice } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";
import { useT } from "../../i18n";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { signIn } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return setError(t("auth.pwMin"));
    if (pw !== pw2) return setError(t("auth.pwMismatch"));
    setBusy(true);
    setError(null);
    try {
      const r = await auth.resetPassword(token, pw);
      await signIn(r);
      toast.success(t("auth.reset.done"));
      navigate("/app", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout docTitle={t("auth.reset.title")} title={t("auth.reset.title")} footer={<Link to="/login">{t("auth.backToSignIn")}</Link>}>
      {!token ? (
        <Notice kind="bad" title={t("auth.reset.missing")}>{t("auth.reset.incomplete")} <Link to="/forgot-password">{t("auth.reset.requestNew")}</Link>.</Notice>
      ) : (
        <form onSubmit={submit}>
          <Input label={t("auth.newPassword")} type="password" autoComplete="new-password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <Input label={t("auth.reset.repeat")} type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>{t("auth.reset.submit")}</Button>
        </form>
      )}
    </AuthLayout>
  );
}
