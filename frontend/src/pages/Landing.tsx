import { useMemo } from "react";
import { Link } from "react-router-dom";
import { system } from "../api/endpoints";
import type { PlanLimits } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  FlameLogo, IconArrowRight, IconBell, IconCheck, IconClock, IconLeaf, IconMap, IconPlug, IconSatellite, IconShield, IconTarget, IconTrendingUp, IconWind,
} from "../components/Icons";
import { useCheckout } from "../components/PlanLimitNotice";
import { fmtCompact, fmtNum, timeAgo } from "../lib/format";
import { useAsync, useDocumentTitle } from "../lib/useAsync";
import { isGeoSource } from "../lib/constants";
import { LanguageSelect } from "../components/LanguageSwitcher";
import { t, useT } from "../i18n";
import type { MsgKey } from "../i18n";
import "../styles/landing.css";

function planCopy(key: string): { price: string; blurb: string; highlight?: boolean; extras: string[] } | null {
  if (key === "free") return { price: "$0", blurb: t("landing.plan.free.blurb"), extras: [t("landing.plan.free.x1"), t("landing.plan.free.x2"), t("landing.plan.free.x3")] };
  if (key === "pro") return { price: "", blurb: t("landing.plan.pro.blurb"), highlight: true, extras: [t("landing.plan.pro.x1"), t("landing.plan.pro.x2"), t("landing.plan.pro.x3"), t("landing.plan.pro.x4")] };
  if (key === "enterprise") return { price: t("landing.plan.enterprise.price"), blurb: t("landing.plan.enterprise.blurb"), extras: [t("landing.plan.enterprise.x1"), t("landing.plan.enterprise.x2"), t("landing.plan.enterprise.x3"), t("landing.plan.enterprise.x4")] };
  return null;
}

function limit(v: number | null, unlimitedKey: MsgKey, countKey: MsgKey) {
  return v == null ? t(unlimitedKey) : t(countKey, { count: v });
}

/** Channels the landing grid always lists, even against an older server's meta. */
const EXTRA_INTEGRATIONS: { key: string; labelKey: MsgKey; mark: string }[] = [
  { key: "twilio_voice", labelKey: "landing.integ.voice", mark: "☎" },
  { key: "push", labelKey: "landing.integ.push", mark: "📱" },
];

function HeroVisual() {
  // A stylised console preview: works offline (no tiles) and on any screen.
  const fires = useMemo(
    () => [
      [118, 92, 7], [128, 98, 4], [112, 104, 5], [124, 110, 3], [300, 160, 6], [308, 152, 4], [296, 170, 3], [220, 230, 5], [228, 238, 3], [380, 80, 4], [70, 210, 3], [410, 220, 5], [402, 228, 3],
    ],
    [],
  );
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="hv-bar">
        <span className="hv-dot" style={{ background: "#ff5f57" }} />
        <span className="hv-dot" style={{ background: "#febc2e" }} />
        <span className="hv-dot" style={{ background: "#28c840" }} />
        <span className="hv-url">app.firealerts · {t("nav.map")}</span>
      </div>
      <div className="hv-body">
        <div className="hv-side">
          {[95, 90, 86, 71].map((p, i) => (
            <div key={p} className={`hv-inc ${i === 0 ? "sel" : ""}`}>
              <span className="hv-prio" style={{ color: p >= 80 ? "#ff4d5e" : "#ff9a3c", background: p >= 80 ? "rgba(255,77,94,.15)" : "rgba(255,154,60,.15)" }}>{p}</span>
              <span>
                <span className="hv-line" style={{ width: 90 - i * 8 }} />
                <span className="hv-line faint" style={{ width: 60 + i * 6 }} />
              </span>
            </div>
          ))}
        </div>
        <svg className="hv-map" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice">
          <defs>
            <radialGradient id="hvglow">
              <stop offset="0" stopColor="#ffb02b" stopOpacity="0.9" />
              <stop offset="1" stopColor="#ff6a2b" stopOpacity="0" />
            </radialGradient>
            <pattern id="hvgrid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M24 0H0V24" fill="none" stroke="rgba(255,255,255,.04)" />
            </pattern>
          </defs>
          <rect width="480" height="300" fill="#0f131b" />
          <rect width="480" height="300" fill="url(#hvgrid)" />
          <path d="M-10 190 C 60 150, 120 210, 190 180 S 320 120, 490 150" fill="none" stroke="#1d2533" strokeWidth="18" />
          <path d="M40 40 C 90 60, 150 30, 200 60 S 300 80, 330 40" fill="none" stroke="#18202c" strokeWidth="10" />
          <polygon points="60,60 170,52 190,130 150,150 70,138" fill="rgba(90,169,255,.08)" stroke="#5aa9ff" strokeWidth="1.5" strokeDasharray="4 3" />
          <text x="66" y="74" fill="#5aa9ff" fontSize="9" fontFamily="Inter, sans-serif">{t("landing.hv.asset", { ha: "4,120" })}</text>
          {[["#6a0d47", 70], ["#a1124a", 54], ["#e0244a", 40], ["#ff6a2b", 28], ["#ffd166", 16]].map(([c, r], i) => (
            <ellipse key={i} cx={306 + i * 2} cy={158 - i * 1.5} rx={Number(r) * 1.35} ry={Number(r) * 0.8} fill={i === 4 ? "rgba(255,209,102,.18)" : "none"} stroke={String(c)} strokeWidth={i === 0 ? 1.2 : 1.8} strokeDasharray={i === 0 ? "3 3" : undefined} transform={`rotate(-18 306 158)`} />
          ))}
          {fires.map(([x, y, r], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={Number(r) * 3} fill="url(#hvglow)" opacity="0.55" />
              <circle cx={x} cy={y} r={Number(r) * 0.75} fill={i % 3 === 0 ? "#fff3b0" : i % 3 === 1 ? "#ffb02b" : "#ff6a2b"} stroke="rgba(0,0,0,.5)" strokeWidth="0.5" />
            </g>
          ))}
          <g transform="translate(232 54)">
            <rect width="150" height="44" rx="7" fill="rgba(18,21,28,.95)" stroke="#323949" />
            <circle cx="14" cy="15" r="4" fill="#ff4d5e" />
            <text x="24" y="18" fill="#e7e9ee" fontSize="9" fontWeight="600" fontFamily="Inter, sans-serif">{t("landing.hv.threat")}</text>
            <text x="12" y="34" fill="#8b93a7" fontSize="8" fontFamily="Inter, sans-serif">{t("landing.hv.threatSub")}</text>
          </g>
        </svg>
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: IconSatellite, id: "f1" },
  { icon: IconWind, id: "f2" },
  { icon: IconTrendingUp, id: "f3" },
  { icon: IconLeaf, id: "f4" },
] as const;

export default function Landing() {
  const { t } = useT();
  useDocumentTitle("");
  const { me, meta } = useAuth();
  const status = useAsync(() => system.status(), []);
  const sources = useAsync(() => system.sources(), []);
  const { start, busy } = useCheckout();

  const geo = status.data ? Object.entries(status.data.by_source_24h).filter(([k]) => isGeoSource(k)).reduce((a, [, v]) => a + v, 0) : null;
  const sensors = status.data ? Object.keys(status.data.by_source_24h).length : null;
  const signedIn = !!me?.authenticated;
  const openDirect = !!me && !me.auth_required;
  const plans = Object.entries(meta?.plans ?? {}) as [string, PlanLimits][];
  const integrations: { key: string; label: string; mark: string; data: boolean }[] = Object.entries(meta?.connector_types ?? {}).map(([key, c]) => ({
    key,
    label: key === "push" ? t("landing.integ.push") : key === "twilio_voice" ? t("landing.integ.voice") : c.label,
    mark: key === "push" ? "📱" : key === "twilio_voice" ? "☎" : c.label.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase(),
    data: c.category === "data",
  }));
  if (meta) for (const x of EXTRA_INTEGRATIONS) if (!integrations.some((i) => i.key === x.key)) integrations.push({ key: x.key, label: t(x.labelKey), mark: x.mark, data: false });
  const publicMap = meta?.public_map !== false;

  return (
    <div className="landing">
      <header className="lp-nav">
        <div className="lp-wrap row between">
          <Link to="/" className="brand">
            <span className="logo">
              <FlameLogo size={22} />
            </span>
            Firealerts
          </Link>
          <nav className="lp-links hide-sm" aria-label={t("landing.sections")}>
            <a href="#features">{t("landing.nav.product")}</a>
            <a href="#sources">{t("landing.nav.data")}</a>
            <a href="#integrations">{t("landing.nav.integrations")}</a>
            <a href="#pricing">{t("landing.nav.pricing")}</a>
            {publicMap && <Link to="/live">{t("landing.nav.liveMap")}</Link>}
          </nav>
          <div className="row lp-actions">
            <LanguageSelect compact />
            {signedIn ? (
              <Link className="btn primary" to="/app">
                {t("common.openApp")} <IconArrowRight />
              </Link>
            ) : (
              <>
                <Link className="btn ghost" to="/login">
                  {t("common.signIn")}
                </Link>
                {openDirect ? (
                  <Link className="btn primary" to="/app">
                    {t("common.openApp")}
                  </Link>
                ) : (
                  <Link className="btn primary hide-xs" to="/register">
                    {t("landing.startFree")}
                  </Link>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-glow" />
        <div className="lp-wrap hero-grid">
          <div>
            <div className="eyebrow">
              <span className="pulse-dot" /> {status.data?.detections_24h ? t("landing.eyebrowCount", { count: status.data.detections_24h }) : t("landing.eyebrow")}
            </div>
            <h1>
              {t("landing.h1a")} <span className="grad">{t("landing.h1b")}</span> {t("landing.h1c")}
            </h1>
            <p className="lp-lead">{t("landing.lead")}</p>
            <div className="row wrap" style={{ gap: 10 }}>
              {signedIn || openDirect ? (
                <Link className="btn primary lg" to="/app">
                  {t("common.openApp")} <IconArrowRight />
                </Link>
              ) : null}
              {!signedIn && (
                <Link className={`btn lg ${openDirect ? "" : "primary"}`} to="/register">
                  {t("landing.startMonitoring")}
                </Link>
              )}
              {publicMap ? (
                <Link className="btn lg" to="/live">
                  <IconMap /> {t("landing.openFreeMap")}
                </Link>
              ) : (
                <a className="btn lg ghost" href="#features">
                  {t("landing.seeHow")}
                </a>
              )}
            </div>
            <dl className="hero-stats">
              <div>
                <dt>{t("landing.stat.detections")}</dt>
                <dd>{status.data ? fmtCompact(status.data.detections_24h) : "—"}</dd>
              </div>
              <div>
                <dt>{t("sensor.geo")}</dt>
                <dd>{geo != null ? fmtCompact(geo) : "—"}</dd>
              </div>
              <div>
                <dt>{t("landing.stat.sensors")}</dt>
                <dd>{sensors ?? "—"}</dd>
              </div>
              <div>
                <dt>{t("landing.stat.latest")}</dt>
                <dd>{status.data?.latest_detection ? timeAgo(status.data.latest_detection) : "—"}</dd>
              </div>
            </dl>
          </div>
          <HeroVisual />
        </div>
      </section>

      <section className="lp-strip">
        <div className="lp-wrap strip-grid">
          {[
            [IconClock, t("landing.strip.a1"), t("landing.strip.b1")],
            [IconTarget, "375 m", t("landing.strip.b2")],
            [IconShield, "72 h", t("landing.strip.b3")],
            [IconBell, t("landing.strip.a4"), t("landing.strip.b4")],
          ].map(([I, a, b]) => {
            const Icon = I as typeof IconClock;
            return (
              <div key={String(a)} className="strip-item">
                <Icon size={18} />
                <div>
                  <b>{String(a)}</b>
                  <span>{String(b)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section id="features" className="lp-section">
        <div className="lp-wrap">
          <div className="section-head">
            <div className="kicker">{t("landing.nav.product")}</div>
            <h2>{t("landing.features.title")}</h2>
            <p>{t("landing.features.lead")}</p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <article key={f.id} className="feature">
                <div className="feature-icon">
                  <f.icon size={20} />
                </div>
                <h3>{t(`landing.${f.id}.title`)}</h3>
                <p>{t(`landing.${f.id}.body`)}</p>
                <ul>
                  {(["p1", "p2", "p3"] as const).map((p) => (
                    <li key={p}>
                      <IconCheck size={14} /> {t(`landing.${f.id}.${p}`)}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div className="how">
            {[
              ["1", t("landing.how1.title"), t("landing.how1.body")],
              ["2", t("landing.how2.title"), t("landing.how2.body")],
              ["3", t("landing.how3.title"), t("landing.how3.body")],
            ].map(([n, t, b]) => (
              <div key={n} className="how-step">
                <span className="how-n">{n}</span>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="sources" className="lp-section alt">
        <div className="lp-wrap">
          <div className="section-head">
            <div className="kicker">{t("landing.sources.kicker")}</div>
            <h2>{t("landing.sources.title")}</h2>
            <p>{t("landing.sources.lead")}</p>
          </div>
          <div className="source-grid">
            {(sources.data?.sources ?? []).map((s) => (
              <a key={s.id} className="source-card" href={s.url} target="_blank" rel="noreferrer">
                <div className="row between">
                  <span className="chip">{s.kind}</span>
                  <span className={`status-dot ${s.status === "ok" ? "ok" : s.status === "error" ? "bad" : s.status === "available" ? "ok" : "idle"}`} title={s.status} />
                </div>
                <h3>{s.name}</h3>
                <div className="small muted">
                  {s.coverage} · {s.cadence}
                </div>
                {s.last_count ? <div className="tiny muted mt-4">{t("landing.sources.lastSync", { count: s.last_count })}</div> : null}
              </a>
            ))}
            {sources.loading && Array.from({ length: 6 }, (_, i) => <div key={i} className="source-card skeleton" style={{ height: 120 }} />)}
          </div>
        </div>
      </section>

      <section id="integrations" className="lp-section">
        <div className="lp-wrap integ">
          <div>
            <div className="kicker">{t("landing.nav.integrations")}</div>
            <h2>{t("landing.integ.title")}</h2>
            <p className="muted mt-8">{t("landing.integ.lead")}</p>
            <Link to={signedIn || openDirect ? "/app/integrations" : "/register"} className="btn mt-16">
              <IconPlug /> {t("landing.integ.connect")}
            </Link>
          </div>
          <div className="integ-grid">
            {integrations.map((c) => (
              <div key={c.key} className="integ-item">
                <span className="integ-logo">{c.mark}</span>
                <span>
                  <b>{c.label}</b>
                  <span className="tiny muted" style={{ display: "block" }}>
                    {c.data ? t("landing.integ.dataSource") : t("landing.integ.notifications")}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="lp-section alt">
        <div className="lp-wrap">
          <div className="section-head">
            <div className="kicker">{t("landing.nav.pricing")}</div>
            <h2>{t("landing.pricing.title")}</h2>
          </div>
          <div className="pricing-grid">
            {plans.map(([key, p]) => {
              const copy = planCopy(key) ?? { price: p.label, blurb: "", extras: [] };
              const canBuy = meta?.billing_enabled && signedIn && key !== "free" && me?.role === "owner" && me.org?.plan !== key;
              return (
                <div key={key} className={`price-card ${copy.highlight ? "hl" : ""}`}>
                  {copy.highlight && <span className="badge accent" style={{ alignSelf: "flex-start" }}>{t("landing.pricing.popular")}</span>}
                  <h3>{p.label}</h3>
                  {copy.price && <div className="price">{copy.price}</div>}
                  <p className="muted small">{copy.blurb}</p>
                  <ul>
                    <li><IconCheck size={14} /> {limit(p.assets, "landing.pricing.assetsUnlimited", "landing.pricing.assets")}</li>
                    <li><IconCheck size={14} /> {p.max_asset_ha == null ? t("landing.pricing.anySize") : t("landing.pricing.maxSize", { ha: fmtNum(p.max_asset_ha) })}</li>
                    <li><IconCheck size={14} /> {limit(p.members, "landing.pricing.membersUnlimited", "landing.pricing.members")}</li>
                    <li><IconCheck size={14} /> {limit(p.connectors, "landing.pricing.integrationsUnlimited", "landing.pricing.integrations")}</li>
                    <li><IconCheck size={14} /> {t("landing.pricing.ensemble", { n: p.forecast_members ?? 16 })}</li>
                    {copy.extras.map((x) => (
                      <li key={x}><IconCheck size={14} /> {x}</li>
                    ))}
                  </ul>
                  {canBuy ? (
                    <button className={`btn ${copy.highlight ? "primary" : ""} block`} disabled={busy === key} onClick={() => start(key)}>
                      {t("plan.upgradeTo", { plan: p.label })}
                    </button>
                  ) : signedIn ? (
                    <Link className={`btn ${copy.highlight ? "primary" : ""} block`} to="/app/settings/organization">
                      {me?.org?.plan === key ? t("landing.pricing.current") : t("landing.pricing.manage")}
                    </Link>
                  ) : (
                    <Link className={`btn ${copy.highlight ? "primary" : ""} block`} to="/register">
                      {key === "enterprise" ? t("landing.pricing.getStarted") : key === "free" ? t("landing.startFree") : t("landing.pricing.startWith", { plan: p.label })}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="lp-cta">
        <div className="lp-wrap cta-box">
          <div>
            <h2>{t("landing.cta.title")}</h2>
            <p className="muted">{t("landing.cta.lead")}</p>
          </div>
          <div className="row wrap">
            {!signedIn && (
              <Link className="btn primary lg" to="/register">
                {t("landing.cta.create")}
              </Link>
            )}
            {publicMap && (
              <Link className="btn lg" to="/live">
                {t("landing.openFreeMap")}
              </Link>
            )}
            {(signedIn || openDirect) && (
              <Link className="btn lg" to="/app">
                {t("common.openApp")}
              </Link>
            )}
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-wrap row between wrap">
          <span className="brand small">
            <span className="logo">
              <FlameLogo size={16} />
            </span>
            Firealerts {meta?.version && <span className="faint tiny">v{meta.version}</span>}
          </span>
          <span className="tiny muted">{t("landing.footer")}</span>
        </div>
      </footer>
    </div>
  );
}
