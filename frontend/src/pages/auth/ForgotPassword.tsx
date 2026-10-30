import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { auth } from "../../api/endpoints";
import { errorMessage } from "../../components/Toast";
import { Button, Input, Notice } from "../../components/ui";
import { AuthLayout } from "./AuthLayout";

export default function ForgotPassword() {
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
    <AuthLayout docTitle="Reset password" title="Reset your password" lead="Enter your e-mail and we'll send you a link to choose a new password." footer={<Link to="/login">Back to sign in</Link>}>
      {done ? (
        <Notice kind="ok" title="Check your inbox">
          If an account exists for {email}, a reset link is on its way. It's valid for 2 hours.
          {done.dev_link && (
            <div className="mt-8">
              Development link: <a href={done.dev_link} style={{ wordBreak: "break-all" }}>{done.dev_link}</a>
            </div>
          )}
        </Notice>
      ) : (
        <form onSubmit={submit}>
          <Input label="E-mail" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          {error && <div className="form-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}
