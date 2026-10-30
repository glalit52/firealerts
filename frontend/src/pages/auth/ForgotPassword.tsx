import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { errorMessage } from "../../components/Toast";
import { Button, Input, Notice } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";
import { useT } from "../../i18n";

export default function ForgotPassword() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ dev_link?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await auth.forgotPassword(email));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout docTitle={t("auth.forgot.doc")} title={t("auth.forgot.title")} lead={t("auth.forgot.lead")} footer={<Link to="/login">{t("auth.backToSignIn")}</Link>}>
      {done ? (
        <Notice kind="ok" title={t("auth.forgot.checkInbox")}>
          {t("auth.forgot.sent", { email })}
          {done.dev_link && (
            <div className="mt-8">
              {t("common.devLink")} <a href={done.dev_link} style={{ wordBreak: "break-all" }}>{done.dev_link}</a>
            </div>
          )}
        </Notice>
      ) : (
        <form onSubmit={submit}>
          <Input label={t("common.email")} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>{t("auth.forgot.send")}</Button>
        </form>
      )}
    </AuthLayout>
  );
}
