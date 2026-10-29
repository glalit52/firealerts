import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { errorMessage } from "../../components/Toast";
import { ButtonLink, Notice, Spinner } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { refresh, canUseApp } = useAuth();
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setState({ error: "This link is missing its token." });
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
    <AuthLayout docTitle="Confirm e-mail" title="Confirm your e-mail">
      {!state.ok && !state.error && (
        <div className="row"><Spinner /> Confirming…</div>
      )}
      {state.ok && (
        <div className="stack">
          <Notice kind="ok" title="E-mail confirmed">{state.ok} is verified. You'll now receive alerts and can invite your team.</Notice>
          <ButtonLink to={canUseApp ? "/app" : "/login"} variant="primary" size="lg">{canUseApp ? "Open the app" : "Sign in"}</ButtonLink>
        </div>
      )}
      {state.error && (
        <Notice kind="bad" title="We couldn't confirm this link">
          {state.error}. Sign in and use “Resend e-mail” to get a fresh link. <Link to="/login">Sign in</Link>
        </Notice>
      )}
    </AuthLayout>
  );
}
