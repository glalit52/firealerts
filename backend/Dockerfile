FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    DATABASE_URL=sqlite:////data/firealerts.db \
    MODEL_PATH=/data/ignition_model.joblib
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY alembic.ini .
COPY firealerts ./firealerts
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app /data
USER app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
# API process. The background worker uses the same image: `python -m firealerts.worker`.
CMD ["uvicorn", "firealerts.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
