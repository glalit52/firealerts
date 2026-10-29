from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AuditLog


def record(session: Session, principal, action: str, target: str = "", **data) -> None:
    session.add(
        AuditLog(
            org_id=getattr(principal, "org_id", None),
            user_id=principal.user.id if getattr(principal, "user", None) else None,
            action=action,
            target=target,
            data=data,
        )
    )
