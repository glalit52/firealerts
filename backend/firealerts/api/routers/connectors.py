from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import plans
from ...auth import Principal, require
from ...db import get_session
from ...integrations import notify, registry
from ...models import ALERT_TYPES, SEVERITIES, Asset, Connector, NotificationRule, Organization
from ...security import encrypt_json
from ...services import alerting, audit, i18n
from ...services import connectors as conn_svc
from ..deps import client

router = APIRouter(prefix="/api", tags=["integrations"])


class ConnectorIn(BaseModel):
    type: str
    name: str = Field(min_length=1, max_length=120)
    config: dict = Field(default_factory=dict)
    enabled: bool = True


class ConnectorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    config: dict | None = None
    enabled: bool | None = None


def view(c: Connector) -> dict:
    spec = registry.CONNECTOR_TYPES.get(c.type, {})
    return {
        "id": c.id,
        "type": c.type,
        "category": spec.get("category"),
        "label": spec.get("label", c.type),
        "name": c.name,
        "enabled": c.enabled,
        "config": registry.redact(c.type, conn_svc.config(c)),
        "last_status": c.last_status,
        "last_error": c.last_error,
        "last_used_at": c.last_used_at.isoformat() if c.last_used_at else None,
        "created_at": c.created_at.isoformat(),
    }


def _own(session: Session, cid: int, p: Principal) -> Connector:
    c = session.get(Connector, cid)
    if not c or c.org_id != p.org_id:
        raise HTTPException(404, "connector not found")
    return c


@router.get("/connectors/types")
def types():
    return registry.CONNECTOR_TYPES


@router.get("/connectors")
def list_connectors(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    return [view(c) for c in session.scalars(select(Connector).where(Connector.org_id == p.org_id).order_by(Connector.id))]


@router.post("/connectors", status_code=201)
def create_connector(body: ConnectorIn, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    plans.check(session, session.get(Organization, p.org_id), "connectors")
    try:
        cfg = registry.validate(body.type, body.config)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    c = Connector(org_id=p.org_id, type=body.type, name=body.name.strip(), config_enc=encrypt_json(cfg), enabled=body.enabled)
    session.add(c)
    session.flush()
    audit.record(session, p, "connector.create", f"{c.type}:{c.name}")
    session.commit()
    return view(c)


@router.patch("/connectors/{cid}")
def update_connector(cid: int, body: ConnectorPatch, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    c = _own(session, cid, p)
    if body.name is not None:
        c.name = body.name.strip()
    if body.enabled is not None:
        c.enabled = body.enabled
    if body.config is not None:
        merged = registry.merge_update(c.type, conn_svc.config(c), body.config)
        try:
            c.config_enc = encrypt_json(registry.validate(c.type, merged))
        except ValueError as exc:
            raise HTTPException(422, str(exc))
    audit.record(session, p, "connector.update", f"{c.type}:{c.name}")
    session.commit()
    return view(c)


@router.delete("/connectors/{cid}", status_code=204)
def delete_connector(cid: int, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    c = _own(session, cid, p)
    for r in session.scalars(select(NotificationRule).where(NotificationRule.org_id == p.org_id)):
        if cid in (r.connector_ids or []):
            r.connector_ids = [x for x in r.connector_ids if x != cid]
    audit.record(session, p, "connector.delete", f"{c.type}:{c.name}")
    session.delete(c)
    session.commit()


@router.post("/connectors/{cid}/test")
async def test_connector(cid: int, p: Principal = Depends(require("admin")), session: Session = Depends(get_session), http: httpx.AsyncClient = Depends(client)):
    c = _own(session, cid, p)
    org = session.get(Organization, p.org_id)
    lang = alerting.org_language(org)
    sample = notify.Message(
        title=i18n.t(lang, "test.title"),
        text=i18n.t(lang, "test.text", name=c.name, org=org.name),
        severity="info",
        type="system",
        org_name=org.name,
        recipients=[p.user.email] if p.user else [],
        push_subscriptions=alerting.member_push_subscriptions(session, org.id),
        language=lang,
    )
    try:
        msg = await registry.test(http, c.type, conn_svc.config(c), sample)
        c.last_status, c.last_error = "ok", ""
        ok = True
    except Exception as exc:
        msg = str(exc)[:500]
        c.last_status, c.last_error = "error", msg
        ok = False
    session.commit()
    return {"ok": ok, "message": msg}


# ----------------------------------------------------------------------------- notification rules


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    asset_ids: list[int] | None = None
    alert_types: list[str] = Field(default_factory=lambda: list(ALERT_TYPES))
    min_severity: str = "low"
    connector_ids: list[int] = Field(default_factory=list)
    enabled: bool = True

    @field_validator("alert_types")
    @classmethod
    def _types(cls, v):
        bad = [t for t in v if t not in ALERT_TYPES]
        if bad:
            raise ValueError(f"unknown alert types: {bad}")
        return v

    @field_validator("min_severity")
    @classmethod
    def _sev(cls, v):
        if v not in SEVERITIES:
            raise ValueError(f"min_severity must be one of {SEVERITIES}")
        return v


def _check_refs(session: Session, p: Principal, body: RuleIn) -> None:
    ids = set(session.scalars(select(Connector.id).where(Connector.org_id == p.org_id)))
    if not set(body.connector_ids) <= ids:
        raise HTTPException(422, "unknown connector in connector_ids")
    if body.asset_ids:
        aids = set(session.scalars(select(Asset.id).where(Asset.org_id == p.org_id)))
        if not set(body.asset_ids) <= aids:
            raise HTTPException(422, "unknown asset in asset_ids")


@router.get("/notification-rules")
def list_rules(p: Principal = Depends(require("viewer")), session: Session = Depends(get_session)):
    return [r.as_dict() for r in session.scalars(select(NotificationRule).where(NotificationRule.org_id == p.org_id).order_by(NotificationRule.id))]


@router.post("/notification-rules", status_code=201)
def create_rule(body: RuleIn, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    _check_refs(session, p, body)
    r = NotificationRule(org_id=p.org_id, **body.model_dump())
    session.add(r)
    session.commit()
    return r.as_dict()


@router.put("/notification-rules/{rid}")
def update_rule(rid: int, body: RuleIn, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    r = session.get(NotificationRule, rid)
    if not r or r.org_id != p.org_id:
        raise HTTPException(404, "rule not found")
    _check_refs(session, p, body)
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    session.commit()
    return r.as_dict()


@router.delete("/notification-rules/{rid}", status_code=204)
def delete_rule(rid: int, p: Principal = Depends(require("admin")), session: Session = Depends(get_session)):
    r = session.get(NotificationRule, rid)
    if not r or r.org_id != p.org_id:
        raise HTTPException(404, "rule not found")
    session.delete(r)
    session.commit()
