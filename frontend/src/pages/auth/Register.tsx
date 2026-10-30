import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import type { Verification } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage } from "../../components/Toast";
import { Button, ButtonLink, Input, Notice } from "../../components/ui";
import { AuthLayout, safeNext } from "./AuthLayout";
import { useT } from "../../i18n";

export default function Register() {
  const { me, signIn } = useAuth();
  const { t } = useT();
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
      setError(t("auth.register.pwShort"));
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
      <AuthLayout docTitle={t("auth.register.createdDoc")} title={t("auth.register.welcome")} lead={t("auth.register.ready")}>
        <div className="stack">
          <Notice kind="info" title={t("auth.register.confirm")}>
            {verification.emailed ? t("auth.register.sentLink") : t("auth.register.noEmail")} {t("common.devLink")}{" "}
            <a href={verification.dev_link} style={{ wordBreak: "break-all" }}>{verification.dev_link}</a>
          </Notice>
          <ButtonLink to={next} variant="primary" size="lg">
            {t("common.openApp")}
          </ButtonLink>
        </div>
      </AuthLayout>
    );
  }

  const closed = me?.registration_open === false;
  return (
    <AuthLayout
      docTitle={t("common.createAccount")}
      title={t("auth.register.title")}
      lead={t("auth.register.lead")}
      footer={
        <>
          {t("auth.register.haveAccount")} <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>{t("common.signIn")}</Link>
        </>
      }
    >
      {closed ? (
        <Notice kind="warn" title={t("auth.register.closedTitle")}>{t("auth.register.closedBody")}</Notice>
      ) : (
        <form onSubmit={submit}>
          <Input label={t("common.yourName")} autoComplete="name" value={form.name} onChange={set("name")} autoFocus />
          <Input label={t("auth.register.workEmail")} type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
          <Input label={t("common.password")} type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set("password")} hint={t("auth.register.pwHint")} />
          <Input label={t("auth.register.orgName")} value={form.org_name} onChange={set("org_name")} placeholder={t("auth.register.orgPlaceholder")} />
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {t("common.createAccount")}
          </Button>
          <p className="tiny muted" style={{ textAlign: "center" }}>{t("auth.register.free")}</p>
        </form>
      )}
    </AuthLayout>
  );
}
