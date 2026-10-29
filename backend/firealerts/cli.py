"""Operations CLI.

    python -m firealerts.cli migrate
    python -m firealerts.cli create-user admin@example.com --superuser --org "Fire Ops"
    python -m firealerts.cli set-plan 3 pro
    python -m firealerts.cli run-job ingest|risk|threats|vegetation|digest|cleanup
    python -m firealerts.cli stats
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import sys

from sqlalchemy import func, select

from . import auth, worker
from .db import SessionLocal, init_db, utcnow
from .models import Asset, Detection, Membership, Organization, User
from .plans import PLANS
from .security import hash_password


def cmd_migrate(_):
    init_db()
    print("database is at the latest revision")


def cmd_create_user(a):
    init_db()
    password = a.password or getpass.getpass("Password: ")
    if len(password) < 8:
        sys.exit("password must be at least 8 characters")
    with SessionLocal() as s:
        if s.scalar(select(User).where(func.lower(User.email) == a.email.lower())):
            sys.exit("user already exists")
        u = User(email=a.email.lower(), name=a.name or "", password_hash=hash_password(password), is_superuser=a.superuser)
        u.email_verified_at = utcnow()
        s.add(u)
        s.flush()
        org = Organization(name=a.org or f"{a.email.split('@')[0]}'s organisation", plan=a.plan)
        s.add(org)
        s.flush()
        s.add(Membership(user_id=u.id, org_id=org.id, role="owner"))
        s.commit()
        print(f"created user {u.email} (id {u.id}) owning organisation '{org.name}' (id {org.id}, plan {org.plan})")


def cmd_set_plan(a):
    if a.plan not in PLANS:
        sys.exit(f"plan must be one of {', '.join(PLANS)}")
    with SessionLocal() as s:
        org = s.get(Organization, a.org_id)
        if not org:
            sys.exit("organisation not found")
        org.plan = a.plan
        s.commit()
        print(f"{org.name}: plan {org.plan}")


def cmd_run_job(a):
    init_db()
    with SessionLocal() as s:
        auth.bootstrap(s)
    fn = {"ingest": worker.job_ingest, "risk": worker.job_risk, "threats": worker.job_threats, "vegetation": worker.job_vegetation, "digest": worker.job_digest, "cleanup": worker.job_cleanup}[a.job]

    async def run():
        import httpx

        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
            return await fn(c)

    print(asyncio.run(run()))


def cmd_stats(_):
    with SessionLocal() as s:
        print(json.dumps({
            "organizations": s.scalar(select(func.count()).select_from(Organization)),
            "users": s.scalar(select(func.count()).select_from(User)),
            "assets": s.scalar(select(func.count()).select_from(Asset)),
            "detections": s.scalar(select(func.count()).select_from(Detection)),
        }, indent=2))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="firealerts", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate").set_defaults(fn=cmd_migrate)
    p = sub.add_parser("create-user")
    p.add_argument("email")
    p.add_argument("--password")
    p.add_argument("--name")
    p.add_argument("--org")
    p.add_argument("--plan", default="enterprise", choices=list(PLANS))
    p.add_argument("--superuser", action="store_true")
    p.set_defaults(fn=cmd_create_user)
    p = sub.add_parser("set-plan")
    p.add_argument("org_id", type=int)
    p.add_argument("plan")
    p.set_defaults(fn=cmd_set_plan)
    p = sub.add_parser("run-job")
    p.add_argument("job", choices=["ingest", "risk", "threats", "vegetation", "digest", "cleanup"])
    p.set_defaults(fn=cmd_run_job)
    sub.add_parser("stats").set_defaults(fn=cmd_stats)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
