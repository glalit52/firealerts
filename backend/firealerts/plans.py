"""Subscription plans and their limits (None = unlimited)."""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Asset, AuthToken, Connector, Membership, Organization

PLANS: dict[str, dict] = {
    "free": {"label": "Free", "assets": 3, "members": 3, "connectors": 3, "api_keys": 2, "forecast_members": 16, "max_asset_ha": 50_000},
    "pro": {"label": "Pro", "assets": 50, "members": 25, "connectors": 25, "api_keys": 10, "forecast_members": 32, "max_asset_ha": 1_000_000},
    "enterprise": {"label": "Enterprise", "assets": None, "members": None, "connectors": None, "api_keys": None, "forecast_members": 64, "max_asset_ha": None},
}


def limits(org: Organization) -> dict:
    return PLANS.get(org.plan, PLANS["free"])


def usage(session: Session, org: Organization) -> dict:
    return {
        "assets": session.scalar(select(func.count()).select_from(Asset).where(Asset.org_id == org.id)) or 0,
        "members": session.scalar(select(func.count()).select_from(Membership).where(Membership.org_id == org.id)) or 0,
        "connectors": session.scalar(select(func.count()).select_from(Connector).where(Connector.org_id == org.id)) or 0,
    }


def check(session: Session, org: Organization, resource: str, adding: int = 1, user_id: int | None = None) -> None:
    limit = limits(org).get(resource)
    if limit is None:
        return
    if resource == "api_keys":
        current = session.scalar(select(func.count()).select_from(AuthToken).where(AuthToken.user_id == user_id, AuthToken.kind == "api")) or 0
    else:
        current = usage(session, org)[resource]
    if current + adding > limit:
        raise HTTPException(402, f"Your {limits(org)['label']} plan allows {limit} {resource.replace('_', ' ')}. Upgrade to add more.")
