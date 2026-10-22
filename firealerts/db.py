"""Persistence (SQLAlchemy; SQLite by default, any SQLAlchemy URL works)."""

from __future__ import annotations

import os
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text, TypeDecorator, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class UTCDateTime(TypeDecorator):
    """SQLite drops tzinfo; store naive UTC and hand back aware UTC datetimes."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


class Detection(Base):
    __tablename__ = "detections"

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


class AreaOfInterest(Base):
    __tablename__ = "aois"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120))
    geometry: Mapped[dict] = mapped_column(JSON)  # GeoJSON Polygon
    buffer_km: Mapped[float] = mapped_column(Float, default=0.0)
    min_confidence: Mapped[str] = mapped_column(String(1), default="n")  # l / n / h
    email: Mapped[str] = mapped_column(String(255), default="")
    webhook_url: Mapped[str] = mapped_column(Text, default="")
    telegram_chat_id: Mapped[str] = mapped_column(String(64), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "geometry": self.geometry,
            "buffer_km": self.buffer_km,
            "min_confidence": self.min_confidence,
            "email": self.email,
            "webhook_url": self.webhook_url,
            "telegram_chat_id": self.telegram_chat_id,
            "active": self.active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    aoi_id: Mapped[int] = mapped_column(Integer, index=True)
    aoi_name: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    detection_ids: Mapped[list] = mapped_column(JSON)
    count: Mapped[int] = mapped_column(Integer)
    max_frp: Mapped[float | None] = mapped_column(Float, nullable=True)
    nearest_km: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    delivered: Mapped[dict] = mapped_column(JSON, default=dict)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "aoi_id": self.aoi_id,
            "aoi_name": self.aoi_name,
            "created_at": self.created_at.isoformat(),
            "count": self.count,
            "max_frp": self.max_frp,
            "nearest_km": self.nearest_km,
            "lat": self.lat,
            "lon": self.lon,
            "delivered": self.delivered,
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
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "mode": self.mode,
            "fetched": self.fetched,
            "inserted": self.inserted,
            "alerts": self.alerts,
            "per_source": self.per_source,
            "errors": self.errors,
        }


def make_engine(url: str):
    if url.startswith("sqlite:///"):
        path = url.removeprefix("sqlite:///")
        if path and path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    kwargs = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {}
    eng = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(eng, "connect")
        def _pragmas(conn, _):
            cur = conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

    return eng


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db(eng=None) -> None:
    Base.metadata.create_all(eng or engine)
