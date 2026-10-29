import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../../../api/endpoints";
import { useAuth } from "../../../auth/AuthContext";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, EmptyState, Input, Modal, Notice } from "../../../components/ui";
import { fmtDate, initials } from "../../../lib/format";
import { useDocumentTitle } from "../../../lib/useAsync";

export default function Profile() {
  useDocumentTitle("Profile");
  const { me, refresh, signOut } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const user = me?.user;
  const [name, setName] = useState(user?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", repeat: "" });
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [delBusy, setDelBusy] = useState(false);

  if (!user)
    return (
      <div className="page">
        <Card>
          <EmptyState title="You're not signed in" action={<Button variant="primary" onClick={() => navigate("/login?next=/app/settings/profile")}>Sign in</Button>}>
            This server runs in single-user mode. Sign in or create an account to manage a personal profile.
          </EmptyState>
        </Card>
      </div>
    );

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setSavingName(true);
    try {
      await auth.updateMe({ name });
      await refresh();
      toast.success("Profile saved.");
    } catch (err) {
      toast.error(err);
    } finally {
      setSavingName(false);
    }
  };

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.next.length < 8) return setPwErr("Use at least 8 characters.");
    if (pw.next !== pw.repeat) return setPwErr("The new passwords don't match.");
    setSavingPw(true);
    setPwErr(null);
    try {
      await auth.changePassword(pw.current, pw.next);
      setPw({ current: "", next: "", repeat: "" });
      toast.success("Password changed. Your other sessions were signed out.");
    } catch (err) {
      setPwErr((err as Error).message);
    } finally {
      setSavingPw(false);
    }
  };

  const deleteAccount = async () => {
    setDelBusy(true);
    try {
      await auth.deleteMe();
      await signOut();
      toast.success("Your account was deleted.");
      navigate("/");
    } catch (err) {
      toast.error(err);
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>Your personal account. Organisation settings are separate.</p>
        </div>
      </div>
      <div className="settings-layout">
        <Card title="Account">
          <div className="row mb-16">
            <span className="avatar lg">{initials(user.name || user.email)}</span>
            <div>
              <div className="strong">{user.email}</div>
              <div className="small muted row wrap" style={{ gap: 6 }}>
                Member since {fmtDate(user.created_at)}
                {user.email_verified ? <Badge kind="ok">Verified</Badge> : <Badge kind="warn">Unverified</Badge>}
                {user.is_superuser && <Badge kind="accent">Superuser</Badge>}
              </div>
            </div>
          </div>
          <form onSubmit={saveName} className="row top wrap" style={{ alignItems: "flex-end" }}>
            <Input fieldClassName="grow" label="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Button type="submit" variant="primary" loading={savingName} disabled={name === user.name}>
              Save
            </Button>
          </form>
        </Card>
        <Card title="Change password" sub="Other sessions are signed out when you change it.">
          <form onSubmit={changePw} className="form-grid">
            <Input fieldClassName="full" label="Current password" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <Input label="New password" type="password" autoComplete="new-password" required minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <Input label="Repeat new password" type="password" autoComplete="new-password" required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
            {pwErr && <div className="form-error full">{pwErr}</div>}
            <div className="full">
              <Button type="submit" variant="primary" loading={savingPw}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Danger zone">
          <div className="row between wrap">
            <div className="small muted" style={{ maxWidth: 520 }}>
              Delete your account and personal API keys. Organisations where you're the only member are deleted too; if you're the only owner of a shared organisation, transfer ownership first.
            </div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete account
            </Button>
          </div>
        </Card>
      </div>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete your account?"
        description="This can't be undone."
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="danger" loading={delBusy} disabled={confirmText !== user.email} onClick={deleteAccount}>
              Delete my account
            </Button>
          </>
        }
      >
        <div className="stack">
          <Notice kind="bad">All organisations where you are the only member, with their assets and alerts, will be permanently deleted.</Notice>
          <Input label={<>Type <b>{user.email}</b> to confirm</>} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
      </Modal>
    </div>
  );
}
