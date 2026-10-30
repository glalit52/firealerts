# Deployment

## Docker Compose (recommended)

```bash
cp .env.example .env
# set at least: SECRET_KEY (openssl rand -hex 32), POSTGRES_PASSWORD, APP_URL, SMTP_* or SENDGRID_API_KEY
docker compose up --build -d
docker compose exec api python -m firealerts.cli create-user you@example.com --superuser --org "Your org"
open http://localhost:8080
```

Services: `db` (PostgreSQL 16), `api` (FastAPI, stateless, scale with `--scale api=N` behind the web proxy),
`worker` (exactly one: ingestion, alerting, risk, Sentinel-2, digests) and `web` (nginx serving the SPA and proxying `/api`).
Migrations run automatically when the API or worker starts (`python -m firealerts.cli migrate` runs them explicitly).

## Without Docker

```bash
cd backend && pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://user:pass@host/db SECRET_KEY=... SCHEDULER_ENABLED=false
uvicorn firealerts.main:app --host 0.0.0.0 --port 8000     # API
python -m firealerts.worker                                  # worker (separate process)
cd ../frontend && npm ci && npm run build                    # static files in frontend/dist
```

Serve `frontend/dist` with any static server and route `/api` to the API (see `frontend/nginx.conf`).

## Production checklist

- `SECRET_KEY` set and backed up: changing it makes stored connector secrets unreadable.
- `AUTH_REQUIRED=true`, `APP_URL` set to the public HTTPS origin (used in e-mails, alert links and CORS).
- E-mail transport configured (verification, password reset, invites, alerts, digests). Consider `REQUIRE_EMAIL_VERIFICATION=true`.
- `FIRMS_MAP_KEY` and optionally `REGION_BBOX` to focus ingestion; JAXA/LSA SAF accounts for global geostationary coverage.
- TLS termination in front of `web` (Caddy, Traefik, a cloud load balancer…).
- Back up the PostgreSQL volume; `RETENTION_HOURS` controls how long detections are archived (default 400 days).
- Train the ignition model for your region: `docker compose exec worker python -m firealerts.ml.train --bbox … --start … --end … --map-key …`.
- Plans: `DEFAULT_PLAN` for new sign-ups; superusers change plans in Admin or with `python -m firealerts.cli set-plan`.
