"""Stored connector configs and per-organisation data-source credentials."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Connector
from ..security import decrypt_json


def config(c: Connector) -> dict:
    return decrypt_json(c.config_enc)


def data_credentials(session: Session, org_id: int, type_: str) -> dict | None:
    """Org connector first, then the server-wide setting."""
    c = session.scalar(select(Connector).where(Connector.org_id == org_id, Connector.type == type_, Connector.enabled.is_(True)).order_by(Connector.id))
    if c:
        return config(c)
    if type_ == "gee" and settings.gee_service_account_json:
        return {"service_account_json": settings.gee_service_account_json, "project": settings.gee_project}
    if type_ == "gfw" and settings.gfw_api_key:
        return {"api_key": settings.gfw_api_key}
    if type_ == "firms" and settings.firms_map_key:
        return {"map_key": settings.firms_map_key}
    return None
