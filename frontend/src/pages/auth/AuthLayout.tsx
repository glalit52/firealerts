import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FlameLogo, IconCheck } from "../../components/Icons";
import { useDocumentTitle } from "../../lib/useAsync";

export function AuthLayout({ title, lead, children, footer, docTitle }: { title: ReactNode; lead?: ReactNode; children: ReactNode; footer?: ReactNode; docTitle: string }) {
  useDocumentTitle(docTitle);
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
          <div className="quote">Know about a fire near your forest minutes after a satellite sees it — and where it will be in six hours.</div>
          <ul>
            <li><IconCheck /> Geostationary detection every 10 minutes, plus VIIRS &amp; MODIS passes</li>
            <li><IconCheck /> Terrain-aware spread forecasts with threat ETAs for your assets</li>
            <li><IconCheck /> 7-day fire-danger and machine-learned ignition outlook</li>
            <li><IconCheck /> Sentinel-2 vegetation health and burn severity per forest</li>
          </ul>
        </div>
        <div className="small muted" style={{ position: "relative" }}>Data: NASA FIRMS · NOAA GOES · JAXA Himawari · EUMETSAT · Copernicus Sentinel-2</div>
      </aside>
      <main className="auth-main">
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
