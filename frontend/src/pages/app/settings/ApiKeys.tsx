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

export default function ApiKeys() {
  useDocumentTitle("API keys");
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
          <EmptyState icon={<IconKey size={20} />} title="Sign in to manage API keys">API keys belong to a user account and act with that user's permissions.</EmptyState>
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
          <h1>API keys</h1>
          <p>Personal keys for scripts and integrations. They act with your permissions in each organisation you belong to.</p>
        </div>
      </div>
      <div className="settings-layout">
        <Card title="Create a key">
          <form onSubmit={create} className="row wrap" style={{ alignItems: "flex-end" }}>
            <Input fieldClassName="grow" label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. dispatch integration" maxLength={120} />
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              Create key
            </Button>
          </form>
          {created && (
            <div className="stack tight mt-16">
              <Notice kind="warn" title={`Key “${created.name}” created`}>
                {created.note}
              </Notice>
              <div className="row">
                <div className="secret-box grow">{created.key}</div>
                <CopyButton text={created.key} />
              </div>
            </div>
          )}
        </Card>
        <Card title="Your keys" flush>
          {list.error ? (
            <div className="card-body"><ErrorState error={list.error} onRetry={list.reload} /></div>
          ) : !list.data ? (
            <Loading />
          ) : list.data.length === 0 ? (
            <div className="card-body small muted">No keys yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Key</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((k) => (
                    <tr key={k.id}>
                      <td className="strong">{k.name}</td>
                      <td className="mono tiny">{k.prefix}…</td>
                      <td className="small">{fmtDateTime(k.created_at)}</td>
                      <td className="small muted">{k.last_used_at ? timeAgo(k.last_used_at) : "never"}</td>
                      <td className="actions">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (!(await confirm({ title: `Revoke “${k.name}”?`, body: "Anything using this key stops working immediately.", confirmLabel: "Revoke", danger: true }))) return;
                            try {
                              await keys.remove(k.id);
                              void list.reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Using the API" actions={<CopyButton text={curl.replace(/\\\n\s+/g, "")} label="Copy curl" />}>
          <pre className="code">{curl}</pre>
          <p className="small muted mt-12">
            Send <code>Authorization: Bearer &lt;key&gt;</code> on every request. <code>X-Org-Id</code> selects the organisation (default: your first membership). Interactive docs are at{" "}
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
