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
`worker` (exactly one: ingestion, alerting, risk, Sentinel-2, static heat-source learning, digests) and `web`
(nginx serving the SPA and PWA files and proxying `/api`). Migrations run automatically when the API or worker
starts; concurrent starts are serialised with a PostgreSQL advisory lock (`python -m firealerts.cli migrate`
runs them explicitly).

## HTTPS

`deploy/docker-compose.tls.yml` puts Caddy in front of `web` and obtains Let's Encrypt certificates automatically
(Compose v2.24 or newer):

```bash
# DNS A/AAAA record for the domain -> this host; ports 80 and 443 open
# in .env: DOMAIN=fire.example.com  ACME_EMAIL=ops@example.com  APP_URL=https://fire.example.com
docker compose -f docker-compose.yml -f deploy/docker-compose.tls.yml up -d --build
```

HTTPS is required for installing the app on phones and for push notifications (browsers only allow service
workers on secure origins). Behind another proxy or load balancer, keep it on a private network: nginx trusts
`X-Forwarded-For` only from private addresses and passes the resolved client address to the API in
`X-Real-IP` (used for login throttling and the public map's rate limit).

## Backups and restore

```bash
deploy/backup.sh                 # gzip'd pg_dump in ./backups, keeps the newest 14 (BACKUP_KEEP)
deploy/restore.sh backups/firealerts-20260101T000000Z.sql.gz   # stops api+worker, restores, starts them
```

Schedule the backup, e.g. `15 3 * * * cd /srv/firealerts && deploy/backup.sh` in cron, and copy the files off
the host. Back up `.env` too: without the same `SECRET_KEY`, stored connector secrets cannot be decrypted and
push subscriptions stop working (the VAPID key is derived from it unless `VAPID_PRIVATE_KEY` is set).

## Upgrades

```bash
deploy/backup.sh
git pull
docker compose up --build -d     # migrations apply on start
```

## Without Docker

```bash
cd backend && pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://user:pass@host/db SECRET_KEY=... SCHEDULER_ENABLED=false
uvicorn firealerts.main:app --host 127.0.0.1 --port 8000 --workers 2 --proxy-headers --forwarded-allow-ips=127.0.0.1   # API
python -m firealerts.worker                                  # worker (separate process, exactly one)
cd ../frontend && npm ci && npm run build                    # static files in frontend/dist
```

Serve `frontend/dist` with nginx using `frontend/nginx.conf` (change `root` and the `api:8000` upstream). With
`SCHEDULER_ENABLED=true` (the default) the API runs the jobs itself, which is fine for a single API process.

## Production checklist

- `SECRET_KEY` set and backed up: changing it makes stored connector secrets unreadable and invalidates push subscriptions.
- `AUTH_REQUIRED=true`, `APP_URL` set to the public HTTPS origin (used in e-mails, alert links and CORS).
- E-mail transport configured (verification, password reset, invites, alerts, digests). Consider `REQUIRE_EMAIL_VERIFICATION=true`.
- `FIRMS_MAP_KEY` and optionally `REGION_BBOX` to focus ingestion; JAXA/LSA SAF accounts for global geostationary coverage.
- `PUBLIC_MAP=false` if you do not want the anonymous map at `/live`. Its limit of 120 requests per minute per
  client applies per API process.
- `VAPID_SUBJECT=mailto:you@example.com` (push services use it to contact you).
- Daily backups (above); `RETENTION_HOURS` controls how long detections are archived (default 400 days).
- Train the ignition model for your region: `docker compose exec worker python -m firealerts.ml.train --bbox … --start … --end … --map-key …`.
- Plans: `DEFAULT_PLAN` for new sign-ups; superusers change plans in Admin or with `python -m firealerts.cli set-plan`.
- Run **Send test** on each notification connector once with the real credentials.

## Verification record

Checked in the development environment without containers, using the same configuration the containers use:
PostgreSQL 16, the API with two processes, a separate worker and nginx with `frontend/nginx.conf` serving the
production build.

- Three processes started against an empty database at once; migrations ran once, serialised by the advisory lock.
- The worker ran every job (ingest, threats, risk, vegetation, digest, static sources, cleanup) for about two hours with no errors.
- 34 end-to-end browser flows passed through nginx.
- Caching was correct: hashed assets are immutable, while the app shell, `sw.js` and the manifest revalidate.
- The public map's rate limit returned 429 as expected.
- The pg_dump/psql commands used by the backup scripts restored to an identical database.

The Docker images themselves could not be built there (registry pulls were blocked), so run
`docker compose up --build` once on the target host before going live.
