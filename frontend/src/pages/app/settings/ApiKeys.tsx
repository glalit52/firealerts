import { useState } from "react";
import type { FormEvent } from "react";
import { API_BASE } from "../../../api/client";
import { keys } from "../../../api/endpoints";
import type { ApiKeyCreated } from "../../../api/types";
import { useAuth } from "../../../auth/AuthContext";
import { IconKey } from "../../../components/Icons";
import { useToast } from "../../../components/Toast";
import { Button, Card, CopyButton, EmptyState, ErrorState, Input, Loading, Notice, useConfirm } from "../../../components/ui";
import { fmtDateTime, timeAgo } from "../../../lib/format";
import { useAsync, useDocumentTitle } from "../../../lib/useAsync";
import { useT } from "../../../i18n";

export default function ApiKeys() {
  const { t } = useT();
  useDocumentTitle(t("nav.apiKeys"));
  const { me } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const list = useAsync(() => keys.list(), [], { enabled: !!me?.authenticated });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const base = API_BASE || window.location.origin;
  const sample = created?.key ?? "fa_YOUR_API_KEY";
  const curl = `curl -H "Authorization: Bearer ${sample}" \\\n     -H "X-Org-Id: ${me?.org?.id ?? 1}" \\\n     "${base}/api/alerts?status=open&limit=10"`;

  if (!me?.authenticated)
    return (
      <div className="page">
        <Card>
          <EmptyState icon={<IconKey size={20} />} title={t("keys.signIn")}>{t("keys.signInBody")}</EmptyState>
        </Card>
      </div>
    );

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await keys.create(name.trim());
      setCreated(r);
      setName("");
      void list.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("nav.apiKeys")}</h1>
          <p>{t("keys.lead")}</p>
        </div>
      </div>
      <div className="settings-layout">
        <Card title={t("keys.create")}>
          <form onSubmit={create} className="row wrap" style={{ alignItems: "flex-end" }}>
            <Input fieldClassName="grow" label={t("common.name")} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("keys.namePh")} maxLength={120} />
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              {t("keys.createBtn")}
            </Button>
          </form>
          {created && (
            <div className="stack tight mt-16">
              <Notice kind="warn" title={t("keys.created", { name: created.name })}>
                {created.note}
              </Notice>
              <div className="row">
                <div className="secret-box grow">{created.key}</div>
                <CopyButton text={created.key} />
              </div>
            </div>
          )}
        </Card>
        <Card title={t("keys.yours")} flush>
          {list.error ? (
            <div className="card-body"><ErrorState error={list.error} onRetry={list.reload} /></div>
          ) : !list.data ? (
            <Loading />
          ) : list.data.length === 0 ? (
            <div className="card-body small muted">{t("keys.none")}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("common.name")}</th>
                    <th>{t("keys.key")}</th>
                    <th>{t("alert.created")}</th>
                    <th>{t("keys.lastUsed")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((k) => (
                    <tr key={k.id}>
                      <td className="strong">{k.name}</td>
                      <td className="mono tiny">{k.prefix}…</td>
                      <td className="small">{fmtDateTime(k.created_at)}</td>
                      <td className="small muted">{k.last_used_at ? timeAgo(k.last_used_at) : t("common.never")}</td>
                      <td className="actions">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (!(await confirm({ title: t("keys.revokeTitle", { name: k.name }), body: t("keys.revokeBody"), confirmLabel: t("keys.revoke"), danger: true }))) return;
                            try {
                              await keys.remove(k.id);
                              void list.reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          {t("keys.revoke")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={t("keys.using")} actions={<CopyButton text={curl.replace(/\\\n\s+/g, "")} label={t("keys.copyCurl")} />}>
          <pre className="code">{curl}</pre>
          <p className="small muted mt-12">
            {t("keys.send")} <code>Authorization: Bearer &lt;key&gt;</code> {t("keys.everyRequest")} <code>X-Org-Id</code> {t("keys.orgHeader")}{" "}
            <a href={`${base}/docs`} target="_blank" rel="noreferrer">
              {base}/docs
            </a>
            .
          </p>
        </Card>
      </div>
      {dialog}
    </div>
  );
}
