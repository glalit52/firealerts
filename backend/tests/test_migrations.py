from alembic.script import ScriptDirectory
from sqlalchemy import inspect

from firealerts import migrations
from firealerts.db import Base, make_engine
from firealerts import models  # noqa: F401


def test_single_head_and_fresh_upgrade_matches_models(tmp_path):
    script = ScriptDirectory.from_config(migrations.config())
    assert len(script.get_heads()) == 1
    eng = make_engine(f"sqlite:///{tmp_path}/m.db")
    migrations.upgrade(eng)
    migrations.upgrade(eng)  # idempotent
    tables = set(inspect(eng).get_table_names()) - {"alembic_version"}
    assert tables == set(Base.metadata.tables)
    for name, table in Base.metadata.tables.items():
        cols = {c["name"] for c in inspect(eng).get_columns(name)}
        assert cols == {c.name for c in table.columns}, name
