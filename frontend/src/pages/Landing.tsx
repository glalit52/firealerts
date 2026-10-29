import { useMemo } from "react";
import { Link } from "react-router-dom";
import { system } from "../api/endpoints";
import type { PlanLimits } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  FlameLogo, IconArrowRight, IconBell, IconCheck, IconClock, IconLeaf, IconPlug, IconSatellite, IconShield, IconTarget, IconTrendingUp, IconWind,
} from "../components/Icons";
import { useCheckout } from "../components/PlanLimitNotice";
import { fmtCompact, fmtNum, timeAgo } from "../lib/format";
import { useAsync, useDocumentTitle } from "../lib/useAsync";
import { isGeoSource } from "../lib/constants";
import "../styles/landing.css";

const PLAN_COPY: Record<string, { price: string; blurb: string; highlight?: boolean; extras: string[] }> = {
  free: { price: "$0", blurb: "For a single property or a pilot.", extras: ["Detection & threat alerts", "7-day fire-danger outlook", "E-mail, Slack & webhook alerts"] },
  pro: { price: "", blurb: "For forestry companies and fire brigades.", highlight: true, extras: ["Everything in Free", "Sentinel-2 vegetation & burn severity", "SMS, WhatsApp & PagerDuty", "API access & exports"] },
  enterprise: { price: "Custom", blurb: "For agencies and large landholders.", extras: ["Everything in Pro", "Unlimited assets & seats", "Earth Engine & GFW integrations", "SSO & dedicated support"] },
};

function limit(v: number | null, unit: string) {
  return v == null ? `Unlimited ${unit}` : `${fmtNum(v)} ${unit}`;
}

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
        <span className="hv-url">app.firealerts · Live map</span>
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
          <text x="66" y="74" fill="#5aa9ff" fontSize="9" fontFamily="Inter, sans-serif">Sierra Norte forest · 4,120 ha</text>
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
            <text x="24" y="18" fill="#e7e9ee" fontSize="9" fontWeight="600" fontFamily="Inter, sans-serif">Fire may reach forest in ~5 h</text>
            <text x="12" y="34" fill="#8b93a7" fontSize="8" fontFamily="Inter, sans-serif">Threat · 6.8 km W · P90 ETA 3.2 h</text>
          </g>
        </svg>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: IconSatellite,
    title: "Multi-satellite detection",
    body: "Geostationary GOES, Himawari and Meteosat every 10–15 minutes, fused with VIIRS 375 m and MODIS passes. Hotspots are clustered into incidents and ranked by a 0–100 priority score.",
    points: ["Detection-to-alert in minutes", "Per-sensor provenance", "Global coverage"],
  },
  {
    icon: IconWind,
    title: "Predictive spread & threat ETA",
    body: "A terrain-aware ensemble model (Canadian FBP, ESA WorldCover fuels, slope, hourly wind) forecasts P50/P90 perimeters for 1–72 h, and alerts you before the fire reaches your forest.",
    points: ["P50 / P90 perimeters", "Arrival-time & burn-probability maps", "What-if ignitions anywhere"],
  },
  {
    icon: IconTrendingUp,
    title: "Fire danger & ignition forecast",
    body: "The full Canadian Fire Weather Index System run 7 days ahead for every asset, plus a gradient-boosted ignition-probability model trained on the FIRMS archive.",
    points: ["Daily FWI & danger class", "ML ignition probability", "Risk alerts before bad days"],
  },
  {
    icon: IconLeaf,
    title: "Sentinel-2 vegetation & burn severity",
    body: "NDVI, NBR and NDMI time series for each forest from Copernicus Sentinel-2, index overlays on the map, and dNBR burn-severity mapping between any two scenes.",
    points: ["10–20 m resolution", "Burned-area history", "Forest-loss analytics (GFW / Earth Engine)"],
  },
];

export default function Landing() {
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
  const integrations = Object.values(meta?.connector_types ?? {});

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
          <nav className="lp-links hide-sm" aria-label="Sections">
            <a href="#features">Product</a>
            <a href="#sources">Data</a>
            <a href="#integrations">Integrations</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="row">
            {signedIn ? (
              <Link className="btn primary" to="/app">
                Open the app <IconArrowRight />
              </Link>
            ) : (
              <>
                <Link className="btn ghost" to="/login">
                  Sign in
                </Link>
                {openDirect ? (
                  <Link className="btn primary" to="/app">
                    Open the app
                  </Link>
                ) : (
                  <Link className="btn primary hide-xs" to="/register">
                    Start free
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
              <span className="pulse-dot" /> {status.data?.detections_24h ? `${fmtNum(status.data.detections_24h)} fire detections in the last 24 h` : "Live satellite fire monitoring"}
            </div>
            <h1>
              Satellite wildfire intelligence <span className="grad">for forests</span> and the people who protect them.
            </h1>
            <p className="lp-lead">
              Firealerts watches your land from orbit around the clock, forecasts where each fire will spread, and alerts your team — with an ETA — before it reaches what matters.
            </p>
            <div className="row wrap" style={{ gap: 10 }}>
              {signedIn || openDirect ? (
                <Link className="btn primary lg" to="/app">
                  Open the app <IconArrowRight />
                </Link>
              ) : null}
              {!signedIn && (
                <Link className={`btn lg ${openDirect ? "" : "primary"}`} to="/register">
                  Start monitoring free
                </Link>
              )}
              <a className="btn lg ghost" href="#features">
                See how it works
              </a>
            </div>
            <dl className="hero-stats">
              <div>
                <dt>Detections · 24 h</dt>
                <dd>{status.data ? fmtCompact(status.data.detections_24h) : "—"}</dd>
              </div>
              <div>
                <dt>Geostationary</dt>
                <dd>{geo != null ? fmtCompact(geo) : "—"}</dd>
              </div>
              <div>
                <dt>Active sensors</dt>
                <dd>{sensors ?? "—"}</dd>
              </div>
              <div>
                <dt>Latest pixel</dt>
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
            [IconClock, "10-minute revisit", "from geostationary satellites"],
            [IconTarget, "375 m", "VIIRS fire pixels"],
            [IconShield, "72 h", "probabilistic spread horizon"],
            [IconBell, "Minutes", "from detection to your phone"],
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
            <div className="kicker">Product</div>
            <h2>From first hotspot to burn-severity report</h2>
            <p>One platform for the whole fire season: detect, forecast, alert and assess — for every forest, plantation and protected area you manage.</p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <article key={f.title} className="feature">
                <div className="feature-icon">
                  <f.icon size={20} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
                <ul>
                  {f.points.map((p) => (
                    <li key={p}>
                      <IconCheck size={14} /> {p}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div className="how">
            {[
              ["1", "Draw or upload your forests", "Polygons, KML/KMZ, GeoJSON or zipped Shapefiles. Set a buffer, threat radius and alert thresholds."],
              ["2", "We watch them from orbit", "Every new detection is checked against your assets; nearby fires get a spread forecast and an ETA."],
              ["3", "Your team gets the call", "Severity-routed alerts by e-mail, SMS, WhatsApp, Slack, Teams, PagerDuty or webhook — with a link to the live map."],
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
            <div className="kicker">Open data, fused</div>
            <h2>Built on the best public Earth-observation data</h2>
            <p>Every number in Firealerts is traceable to a public source. Live status below comes straight from our ingest pipeline.</p>
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
                {s.last_count ? <div className="tiny muted mt-4">{fmtNum(s.last_count)} detections in the last sync</div> : null}
              </a>
            ))}
            {sources.loading && Array.from({ length: 6 }, (_, i) => <div key={i} className="source-card skeleton" style={{ height: 120 }} />)}
          </div>
        </div>
      </section>

      <section id="integrations" className="lp-section">
        <div className="lp-wrap integ">
          <div>
            <div className="kicker">Integrations</div>
            <h2>Alerts where your crews already are</h2>
            <p className="muted mt-8">Route alerts by asset, type and severity. Sign webhooks with HMAC, open incidents in PagerDuty, or pull everything over the REST API with an API key.</p>
            <Link to={signedIn || openDirect ? "/app/integrations" : "/register"} className="btn mt-16">
              <IconPlug /> Connect your channels
            </Link>
          </div>
          <div className="integ-grid">
            {integrations.map((c) => (
              <div key={c.label} className="integ-item">
                <span className="integ-logo">{c.label.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase()}</span>
                <span>
                  <b>{c.label}</b>
                  <span className="tiny muted" style={{ display: "block" }}>
                    {c.category === "data" ? "Data source" : "Notifications"}
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
            <div className="kicker">Pricing</div>
            <h2>Start free. Scale to a whole landscape.</h2>
          </div>
          <div className="pricing-grid">
            {plans.map(([key, p]) => {
              const copy = PLAN_COPY[key] ?? { price: p.label, blurb: "", extras: [] };
              const canBuy = meta?.billing_enabled && signedIn && key !== "free" && me?.role === "owner" && me.org?.plan !== key;
              return (
                <div key={key} className={`price-card ${copy.highlight ? "hl" : ""}`}>
                  {copy.highlight && <span className="badge accent" style={{ alignSelf: "flex-start" }}>Most popular</span>}
                  <h3>{p.label}</h3>
                  {copy.price && <div className="price">{copy.price}</div>}
                  <p className="muted small">{copy.blurb}</p>
                  <ul>
                    <li><IconCheck size={14} /> {limit(p.assets, "monitored assets")}</li>
                    <li><IconCheck size={14} /> {p.max_asset_ha == null ? "Any asset size" : `Assets up to ${fmtNum(p.max_asset_ha)} ha`}</li>
                    <li><IconCheck size={14} /> {limit(p.members, "team members")}</li>
                    <li><IconCheck size={14} /> {limit(p.connectors, "integrations")}</li>
                    <li><IconCheck size={14} /> {p.forecast_members ?? 16}-member spread ensembles</li>
                    {copy.extras.map((x) => (
                      <li key={x}><IconCheck size={14} /> {x}</li>
                    ))}
                  </ul>
                  {canBuy ? (
                    <button className={`btn ${copy.highlight ? "primary" : ""} block`} disabled={busy === key} onClick={() => start(key)}>
                      Upgrade to {p.label}
                    </button>
                  ) : signedIn ? (
                    <Link className={`btn ${copy.highlight ? "primary" : ""} block`} to="/app/settings/organization">
                      {me?.org?.plan === key ? "Your current plan" : "Manage plan"}
                    </Link>
                  ) : (
                    <Link className={`btn ${copy.highlight ? "primary" : ""} block`} to="/register">
                      {key === "enterprise" ? "Get started" : key === "free" ? "Start free" : `Start with ${p.label}`}
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
            <h2>Protect your forests this fire season.</h2>
            <p className="muted">Set up your first asset in under five minutes. No credit card required.</p>
          </div>
          <div className="row wrap">
            {!signedIn && (
              <Link className="btn primary lg" to="/register">
                Create free account
              </Link>
            )}
            {(signedIn || openDirect) && (
              <Link className="btn lg" to="/app">
                Open the app
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
          <span className="tiny muted">Forecasts are decision support, not operational fire-behaviour analyses. Data © NASA, NOAA, JAXA, EUMETSAT, ESA/Copernicus, OpenStreetMap.</span>
        </div>
      </footer>
    </div>
  );
}
