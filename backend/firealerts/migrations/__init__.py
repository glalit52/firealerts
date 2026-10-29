"""Alembic migrations, runnable programmatically (``init_db``) or via ``alembic -c backend/alembic.ini``."""

from __future__ import annotations

import os

from alembic import command
from alembic.config import Config

HERE = os.path.dirname(os.path.abspath(__file__))


def config(url: str | None = None) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", HERE)
    if url:
        cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


def upgrade(engine, revision: str = "head") -> None:
    cfg = config(str(engine.url.render_as_string(hide_password=False)))
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, revision)
