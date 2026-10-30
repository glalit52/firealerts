import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage } from "../../components/Toast";
import { ButtonLink, Notice, Spinner } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";
import { t as tr, useT } from "../../i18n";

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { refresh, canUseApp } = useAuth();
  const { t } = useT();
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setState({ error: tr("auth.verify.noToken") });
      return;
    }
    auth
      .verifyEmail(token)
      .then((r) => {
        setState({ ok: r.email });
        void refresh();
      })
      .catch((err) => setState({ error: errorMessage(err) }));
  }, [token, refresh]);
  return (
    <AuthLayout docTitle={t("auth.verify.doc")} title={t("auth.verify.title")}>
      {!state.ok && !state.error && (
        <div className="row"><Spinner /> {t("auth.verify.confirming")}</div>
      )}
      {state.ok && (
        <div className="stack">
          <Notice kind="ok" title={t("auth.verify.ok")}>{t("auth.verify.okBody", { email: state.ok })}</Notice>
          <ButtonLink to={canUseApp ? "/app" : "/login"} variant="primary" size="lg">{canUseApp ? t("common.openApp") : t("common.signIn")}</ButtonLink>
        </div>
      )}
      {state.error && (
        <Notice kind="bad" title={t("auth.verify.failed")}>
          {state.error}. {t("auth.verify.failedBody")} <Link to="/login">{t("common.signIn")}</Link>
        </Notice>
      )}
    </AuthLayout>
  );
}
