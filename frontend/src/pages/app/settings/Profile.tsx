import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../../../api/endpoints";
import { useAuth } from "../../../auth/AuthContext";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, EmptyState, Input, Modal, Notice, Select } from "../../../components/ui";
import { fmtDate, initials } from "../../../lib/format";
import { useDocumentTitle } from "../../../lib/useAsync";
import { LOCALES, LOCALE_NAMES, isLocale, useT } from "../../../i18n";

export default function Profile() {
  const { t, locale } = useT();
  useDocumentTitle(t("nav.profile"));
  const { me, refresh, signOut, setLanguage } = useAuth();
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
          <EmptyState title={t("profile.notSignedIn")} action={<Button variant="primary" onClick={() => navigate("/login?next=/app/settings/profile")}>{t("common.signIn")}</Button>}>
            {t("profile.singleUser")}
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
      toast.success(t("profile.saved"));
    } catch (err) {
      toast.error(err);
    } finally {
      setSavingName(false);
    }
  };

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.next.length < 8) return setPwErr(t("auth.pwMin"));
    if (pw.next !== pw.repeat) return setPwErr(t("profile.pwMismatch"));
    setSavingPw(true);
    setPwErr(null);
    try {
      await auth.changePassword(pw.current, pw.next);
      setPw({ current: "", next: "", repeat: "" });
      toast.success(t("profile.pwChanged"));
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
      toast.success(t("profile.deleted"));
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
          <h1>{t("nav.profile")}</h1>
          <p>{t("profile.lead")}</p>
        </div>
      </div>
      <div className="settings-layout">
        <Card title={t("auth.invite.account")}>
          <div className="row mb-16">
            <span className="avatar lg">{initials(user.name || user.email)}</span>
            <div>
              <div className="strong">{user.email}</div>
              <div className="small muted row wrap" style={{ gap: 6 }}>
                {t("profile.since", { date: fmtDate(user.created_at) })}
                {user.email_verified ? <Badge kind="ok">{t("profile.verified")}</Badge> : <Badge kind="warn">{t("profile.unverified")}</Badge>}
                {user.is_superuser && <Badge kind="accent">{t("profile.superuser")}</Badge>}
              </div>
            </div>
          </div>
          <form onSubmit={saveName} className="row top wrap" style={{ alignItems: "flex-end" }}>
            <Input fieldClassName="grow" label={t("profile.displayName")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Button type="submit" variant="primary" loading={savingName} disabled={name === user.name}>
              {t("common.save")}
            </Button>
          </form>
          <div className="mt-16" style={{ maxWidth: 320 }}>
            <Select
              label={t("profile.language")}
              hint={t("profile.languageHint")}
              value={locale}
              onChange={(e) => isLocale(e.target.value) && void setLanguage(e.target.value)}
              options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
            />
          </div>
        </Card>
        <Card title={t("profile.changePw")} sub={t("profile.changePwSub")}>
          <form onSubmit={changePw} className="form-grid">
            <Input fieldClassName="full" label={t("profile.currentPw")} type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <Input label={t("auth.newPassword")} type="password" autoComplete="new-password" required minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <Input label={t("profile.repeatPw")} type="password" autoComplete="new-password" required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
            {pwErr && <div className="form-error full">{pwErr}</div>}
            <div className="full">
              <Button type="submit" variant="primary" loading={savingPw}>
                {t("profile.changePw")}
              </Button>
            </div>
          </form>
        </Card>
        <Card title={t("profile.danger")}>
          <div className="row between wrap">
            <div className="small muted" style={{ maxWidth: 520 }}>
              {t("profile.deleteLead")}
            </div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t("profile.deleteAccount")}
            </Button>
          </div>
        </Card>
      </div>
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t("profile.deleteTitle")}
        description={t("profile.cantUndo")}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={delBusy} disabled={confirmText !== user.email} onClick={deleteAccount}>
              {t("profile.deleteMine")}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Notice kind="bad">{t("profile.deleteWarn")}</Notice>
          <Input label={<>{t("confirm.typePre")} <b>{user.email}</b> {t("confirm.typePost")}</>} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
      </Modal>
    </div>
  );
}
