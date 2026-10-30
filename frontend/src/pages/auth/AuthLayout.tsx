import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FlameLogo, IconCheck } from "../../components/Icons";
import { useDocumentTitle } from "../../lib/useAsync";
import { LanguageSelect } from "../../components/LanguageSwitcher";
import { useT } from "../../i18n";

export function AuthLayout({ title, lead, children, footer, docTitle }: { title: ReactNode; lead?: ReactNode; children: ReactNode; footer?: ReactNode; docTitle: string }) {
  useDocumentTitle(docTitle);
  const { t } = useT();
  return (
    <div className="auth-page">
      <aside className="auth-side">
        <div className="dot-grid" />
        <Link to="/" className="brand" style={{ position: "relative" }}>
          <span className="logo">
            <FlameLogo size={22} />
          </span>
          Firealerts
        </Link>
        <div style={{ position: "relative" }}>
          <div className="quote">{t("auth.quote")}</div>
          <ul>
            <li><IconCheck /> {t("auth.point1")}</li>
            <li><IconCheck /> {t("auth.point2")}</li>
            <li><IconCheck /> {t("auth.point3")}</li>
            <li><IconCheck /> {t("auth.point4")}</li>
          </ul>
        </div>
        <div className="small muted" style={{ position: "relative" }}>{t("auth.data")}</div>
      </aside>
      <main className="auth-main">
        <div className="auth-lang">
          <LanguageSelect />
        </div>
        <div className="auth-card">
          <Link to="/" className="brand show-sm" style={{ marginBottom: 28 }}>
            <span className="logo"><FlameLogo size={22} /></span>
            Firealerts
          </Link>
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
          {children}
          {footer && <div className="auth-foot">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** Only allow same-site relative redirect targets. */
export function safeNext(next: string | null, fallback = "/app"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
