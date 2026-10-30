"""ORM models for the whole product."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, UTCDateTime, utcnow


def _iso(v):
    return v.isoformat() if v else None


# ----------------------------------------------------------------------------- fire data


class Detection(Base):
    __tablename__ = "detections"
    __table_args__ = (Index("ix_detections_time_lat_lon", "acq_time", "lat", "lon"),)

    id: Mapped[str] = mapped_column(String(96), primary_key=True)
    source: Mapped[str] = mapped_column(String(32), index=True)
    satellite: Mapped[str] = mapped_column(String(32), default="")
    lat: Mapped[float] = mapped_column(Float, index=True)
    lon: Mapped[float] = mapped_column(Float, index=True)
    acq_time: Mapped[datetime] = mapped_column(UTCDateTime(), index=True)
    frp: Mapped[float | None] = mapped_column(Float, nullable=True)
    brightness: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[str] = mapped_column(String(1), default="n")
    daynight: Mapped[str] = mapped_column(String(1), default="")
    pixel_m: Mapped[float] = mapped_column(Float, default=375.0)
    ingested_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)

    def as_feature(self) -> dict:
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [self.lon, self.lat]},
            "properties": {
                "id": self.id,
                "source": self.source,
                "satellite": self.satellite,
                "acq_time": self.acq_time.isoformat(),
                "frp": self.frp,
                "brightness": self.brightness,
                "confidence": self.confidence,
                "daynight": self.daynight,
                "pixel_m": self.pixel_m,
            },
        }


class IngestRun(Base):
    __tablename__ = "ingest_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    mode: Mapped[str] = mapped_column(String(8))
    fetched: Mapped[int] = mapped_column(Integer, default=0)
    inserted: Mapped[int] = mapped_column(Integer, default=0)
    alerts: Mapped[int] = mapped_column(Integer, default=0)
    per_source: Mapped[dict] = mapped_column(JSON, default=dict)
    errors: Mapped[list] = mapped_column(JSON, default=list)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "mode": self.mode,
            "fetched": self.fetched,
            "inserted": self.inserted,
            "alerts": self.alerts,
            "per_source": self.per_source,
            "errors": self.errors,
        }


# ----------------------------------------------------------------------------- accounts


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120))
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    plan: Mapped[str] = mapped_column(String(16), default="free")
    settings: Mapped[dict] = mapped_column(JSON, default=dict)  # timezone, digest_hour, units ...
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "plan": self.plan, "settings": self.settings or {}, "created_at": _iso(self.created_at)}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    language: Mapped[str | None] = mapped_column(String(8), nullable=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "is_superuser": self.is_superuser,
            "language": self.language,
            "email_verified": self.email_verified_at is not None,
            "created_at": _iso(self.created_at),
        }


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "org_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default="member")  # viewer / member / admin / owner
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(8), default="session")  # session / api
    name: Mapped[str] = mapped_column(String(120), default="")
    prefix: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class EmailToken(Base):
    """One-time tokens for e-mail verification and password reset."""

    __tablename__ = "email_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(16))  # verify / reset
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="member")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    invited_by: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(120), default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)

    def as_dict(self) -> dict:
        return {"id": self.id, "user_id": self.user_id, "action": self.action, "target": self.target, "data": self.data, "created_at": _iso(self.created_at)}


# ----------------------------------------------------------------------------- monitored assets (forests, farms, ...)

ASSET_KINDS = ["forest", "plantation", "protected_area", "farm", "grassland", "infrastructure", "community", "other"]


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(24), default="forest")
    description: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    geometry: Mapped[dict] = mapped_column(JSON)  # GeoJSON Polygon or MultiPolygon (WGS84)
    area_ha: Mapped[float] = mapped_column(Float, default=0.0)
    centroid_lat: Mapped[float] = mapped_column(Float, default=0.0)
    centroid_lon: Mapped[float] = mapped_column(Float, default=0.0)
    bbox: Mapped[list] = mapped_column(JSON, default=list)  # [w, s, e, n]
    # Monitoring settings
    buffer_km: Mapped[float] = mapped_column(Float, default=2.0)
    min_confidence: Mapped[str] = mapped_column(String(1), default="n")
    threat_radius_km: Mapped[float] = mapped_column(Float, default=30.0)
    risk_alerts: Mapped[bool] = mapped_column(Boolean, default=True)
    risk_min_danger: Mapped[str] = mapped_column(String(16), default="high")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    properties: Mapped[dict] = mapped_column(JSON, default=dict)  # imported attributes
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    def as_dict(self, geometry: bool = True) -> dict:
        d = {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "tags": self.tags or [],
            "area_ha": round(self.area_ha, 2),
            "centroid": [self.centroid_lon, self.centroid_lat],
            "bbox": self.bbox,
            "buffer_km": self.buffer_km,
            "min_confidence": self.min_confidence,
            "threat_radius_km": self.threat_radius_km,
            "risk_alerts": self.risk_alerts,
            "risk_min_danger": self.risk_min_danger,
            "active": self.active,
            "properties": self.properties or {},
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }
        if geometry:
            d["geometry"] = self.geometry
        return d


class AssetObservation(Base):
    """Satellite-derived vegetation statistics for an asset (one row per scene)."""

    __tablename__ = "asset_observations"
    __table_args__ = (UniqueConstraint("asset_id", "source", "scene_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(32), default="sentinel-2")
    scene_id: Mapped[str] = mapped_column(String(96))
    date: Mapped[date] = mapped_column(Date, index=True)
    cloud_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    valid_frac: Mapped[float] = mapped_column(Float, default=0.0)
    ndvi: Mapped[float | None] = mapped_column(Float, nullable=True)
    nbr: Mapped[float | None] = mapped_column(Float, nullable=True)
    ndmi: Mapped[float | None] = mapped_column(Float, nullable=True)
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {
            "date": self.date.isoformat(),
            "source": self.source,
            "scene_id": self.scene_id,
            "cloud_pct": self.cloud_pct,
            "valid_frac": round(self.valid_frac, 3),
            "ndvi": self.ndvi,
            "nbr": self.nbr,
            "ndmi": self.ndmi,
            "stats": self.stats,
        }


class AssetRisk(Base):
    """Daily fire-danger and ignition-probability snapshot for an asset."""

    __tablename__ = "asset_risk"
    __table_args__ = (UniqueConstraint("asset_id", "date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    fwi: Mapped[float] = mapped_column(Float)
    danger: Mapped[str] = mapped_column(String(16))
    ignition_p: Mapped[float | None] = mapped_column(Float, nullable=True)
    forecast: Mapped[bool] = mapped_column(Boolean, default=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    computed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {
            "date": self.date.isoformat(),
            "fwi": self.fwi,
            "danger": self.danger,
            "ignition_p": self.ignition_p,
            "forecast": self.forecast,
            "data": self.data,
            "computed_at": _iso(self.computed_at),
        }


# ----------------------------------------------------------------------------- alerting

ALERT_TYPES = ["detection", "threat", "risk", "system"]
SEVERITIES = ["info", "low", "moderate", "high", "critical"]


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (Index("ix_alerts_org_status", "org_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="SET NULL"), index=True, nullable=True)
    type: Mapped[str] = mapped_column(String(16), default="detection")
    severity: Mapped[str] = mapped_column(String(16), default="moderate")
    title: Mapped[str] = mapped_column(String(240))
    message: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    dedupe_key: Mapped[str] = mapped_column(String(160), index=True)
    status: Mapped[str] = mapped_column(String(16), default="open")  # open / acknowledged / resolved
    acknowledged_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    deliveries: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "asset_id": self.asset_id,
            "type": self.type,
            "severity": self.severity,
            "title": self.title,
            "message": self.message,
            "data": self.data,
            "lat": self.lat,
            "lon": self.lon,
            "status": self.status,
            "acknowledged_by": self.acknowledged_by,
            "acknowledged_at": _iso(self.acknowledged_at),
            "resolved_at": _iso(self.resolved_at),
            "deliveries": self.deliveries or [],
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }


class Connector(Base):
    """An integration configured by an organisation (notification channel or data source)."""

    __tablename__ = "connectors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(120))
    config_enc: Mapped[str] = mapped_column(Text, default="")  # Fernet-encrypted JSON
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_status: Mapped[str] = mapped_column(String(16), default="")
    last_error: Mapped[str] = mapped_column(Text, default="")
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class NotificationRule(Base):
    __tablename__ = "notification_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    asset_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)  # None = all assets
    alert_types: Mapped[list] = mapped_column(JSON, default=lambda: list(ALERT_TYPES))
    min_severity: Mapped[str] = mapped_column(String(16), default="low")
    connector_ids: Mapped[list] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "asset_ids": self.asset_ids,
            "alert_types": self.alert_types,
            "min_severity": self.min_severity,
            "connector_ids": self.connector_ids,
            "enabled": self.enabled,
            "created_at": _iso(self.created_at),
        }


class AssetAnalysis(Base):
    """Cached results of external analyses (burned-area history, forest loss, exposure, burn severity)."""

    __tablename__ = "asset_analyses"
    __table_args__ = (Index("ix_asset_analyses_lookup", "asset_id", "kind", "params_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # burn_history / forest_loss / exposure / burn_severity / deforestation
    params_key: Mapped[str] = mapped_column(String(160), default="")
    source: Mapped[str] = mapped_column(String(64), default="")
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {"kind": self.kind, "source": self.source, "params": self.params_key, "result": self.result, "created_at": _iso(self.created_at)}


class PushSubscription(Base):
    """A browser/device Web Push subscription of a user (PWA notifications)."""

    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    endpoint: Mapped[str] = mapped_column(Text)
    endpoint_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(64))
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    def as_dict(self) -> dict:
        from urllib.parse import urlparse

        return {"id": self.id, "endpoint_host": urlparse(self.endpoint).hostname, "user_agent": self.user_agent, "created_at": _iso(self.created_at), "last_used_at": _iso(self.last_used_at)}


class StaticSource(Base):
    """Known or learned persistent heat sources (volcanoes, gas flares, industry) used to filter false positives."""

    __tablename__ = "static_sources"
    __table_args__ = (Index("ix_static_sources_cell", "kind", "lat", "lon"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(16))  # volcano / flare / industrial / persistent
    name: Mapped[str] = mapped_column(String(160), default="")
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    radius_km: Mapped[float] = mapped_column(Float, default=2.0)
    days_detected: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(32), default="learned")  # curated / catalog / learned / manual
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    def as_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name, "lat": self.lat, "lon": self.lon, "radius_km": self.radius_km, "days_detected": self.days_detected, "source": self.source, "active": self.active}
