# Firealerts backend

FastAPI API + background worker for satellite fire detection, forecasting, asset (forest) monitoring and alerting.

```bash
pip install -r requirements-dev.txt
DATA_MODE=demo uvicorn firealerts.main:app --reload       # API on :8000, docs at /docs (runs jobs in-process)
python -m firealerts.worker                               # separate worker (set SCHEDULER_ENABLED=false on the API)
python -m firealerts.cli --help                           # operations CLI
pytest -q                                                 # SQLite
DATABASE_URL=postgresql+psycopg://… pytest -q             # PostgreSQL
```

New schema changes: edit `firealerts/models.py`, then
`alembic -c alembic.ini revision --autogenerate -m "describe change"` and review the generated file in `firealerts/migrations/versions/`.

See `../docs/ARCHITECTURE.md`, `../docs/INTEGRATIONS.md`, `../docs/DEPLOYMENT.md` and the OpenAPI spec in `../docs/openapi.json`.
