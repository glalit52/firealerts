"""Runtime settings, read from environment variables (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _list(name: str, default: str) -> list[str]:
    return [p.strip() for p in os.getenv(name, default).split(",") if p.strip()]


@dataclass
class Settings:
    # "live" uses real satellite/weather feeds, "demo" uses synthetic data, "auto"
    # tries live and falls back to demo when the feeds are unreachable.
    data_mode: str = field(default_factory=lambda: os.getenv("DATA_MODE", "auto").lower())
    database_url: str = field(
        default_factory=lambda: os.getenv("DATABASE_URL", "sqlite:///./data/firealerts.db")
    )
    poll_minutes: float = field(default_factory=lambda: float(os.getenv("POLL_MINUTES", "10")))
    retention_hours: int = field(default_factory=lambda: int(os.getenv("RETENTION_HOURS", "72")))
    scheduler_enabled: bool = field(default_factory=lambda: _bool("SCHEDULER_ENABLED", True))

    # NASA FIRMS. Without a MAP_KEY the public global 24h CSV files are used.
    firms_map_key: str = field(default_factory=lambda: os.getenv("FIRMS_MAP_KEY", ""))
    firms_sources: list[str] = field(
        default_factory=lambda: _list("FIRMS_SOURCES", "VIIRS_NOAA20,VIIRS_NOAA21,VIIRS_SNPP,MODIS")
    )
    # Optional "west,south,east,north" to restrict ingestion to a region.
    region_bbox: str = field(default_factory=lambda: os.getenv("REGION_BBOX", ""))

    # Geostationary (GOES ABI Fire Detection & Characterization, every 10 minutes).
    goes_satellites: list[str] = field(
        default_factory=lambda: _list("GOES_SATELLITES", "goes19,goes18")
    )
    goes_enabled: bool = field(default_factory=lambda: _bool("GOES_ENABLED", True))

    # Notifications
    alert_webhook_url: str = field(default_factory=lambda: os.getenv("ALERT_WEBHOOK_URL", ""))
    telegram_bot_token: str = field(default_factory=lambda: os.getenv("TELEGRAM_BOT_TOKEN", ""))
    smtp_host: str = field(default_factory=lambda: os.getenv("SMTP_HOST", ""))
    smtp_port: int = field(default_factory=lambda: int(os.getenv("SMTP_PORT", "587")))
    smtp_user: str = field(default_factory=lambda: os.getenv("SMTP_USER", ""))
    smtp_password: str = field(default_factory=lambda: os.getenv("SMTP_PASSWORD", ""))
    smtp_from: str = field(default_factory=lambda: os.getenv("SMTP_FROM", "alerts@firealerts.local"))
    public_url: str = field(default_factory=lambda: os.getenv("PUBLIC_URL", "http://localhost:8000"))

    http_timeout: float = field(default_factory=lambda: float(os.getenv("HTTP_TIMEOUT", "60")))

    @property
    def bbox(self) -> tuple[float, float, float, float] | None:
        if not self.region_bbox:
            return None
        w, s, e, n = (float(v) for v in self.region_bbox.split(","))
        return w, s, e, n


settings = Settings()
