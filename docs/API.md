# API guide

Base URL: `https://<your-host>/api` · interactive reference at `/docs` (Swagger) · machine-readable spec in [`openapi.json`](openapi.json).

## Authentication

Create an API key in **Settings → API keys** (or `POST /api/keys`) and send it as a bearer token. Keys act with your
permissions; add `X-Org-Id` to pick an organisation when you belong to several.

```bash
export FA=https://fire.example.com/api
export KEY=fa_...
curl -H "Authorization: Bearer $KEY" $FA/me
```

## Common calls

```bash
# Monitor a forest (GeoJSON polygon or centre + radius)
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" $FA/assets -d '{
  "name": "Pine Ridge", "kind": "forest", "buffer_km": 2, "threat_radius_km": 30,
  "geometry": {"type": "Polygon", "coordinates": [[[-64.40,-31.36],[-64.35,-31.36],[-64.35,-31.33],[-64.40,-31.33],[-64.40,-31.36]]]}
}'

# Bulk import stands from a file (GeoJSON, KML, KMZ or zipped Shapefile)
curl -X POST -H "Authorization: Bearer $KEY" -F file=@stands.zip "$FA/assets/import?kind=plantation"

# Situation, risk forecast and vegetation for an asset
curl -H "Authorization: Bearer $KEY" $FA/assets/12/summary
curl -H "Authorization: Bearer $KEY" "$FA/assets/12/risk?refresh=true"
curl -X POST -H "Authorization: Bearer $KEY" $FA/assets/12/vegetation/refresh
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" $FA/assets/12/burn-severity -d '{"pre_date":"2026-08-01","post_date":"2026-10-25"}'

# Open alerts, acknowledge one
curl -H "Authorization: Bearer $KEY" "$FA/alerts?status=open&type=threat,detection"
curl -X POST -H "Authorization: Bearer $KEY" $FA/alerts/345/ack

# Fire data
curl -H "Authorization: Bearer $KEY" "$FA/incidents?bbox=-66,-34,-62,-29&min_count=3"
curl -H "Authorization: Bearer $KEY" "$FA/forecast/spread?lat=-31.35&lon=-64.4&hours=24"
curl -H "Authorization: Bearer $KEY" -o fires.geojson "$FA/export/detections.geojson?hours=48&bbox=-66,-34,-62,-29"
```

Python:

```python
import httpx

fa = httpx.Client(base_url="https://fire.example.com/api", headers={"Authorization": "Bearer fa_..."})
for alert in fa.get("/alerts", params={"status": "open"}).json()["items"]:
    print(alert["severity"], alert["title"])
```

## Receiving alerts by webhook

Add a **Webhook** connector with a signing secret. Each alert is POSTed as JSON:

```json
{"event": "alert", "sent_at": 1767225600, "alert": {"title": "Fire may reach Pine Ridge within ~6 h", "severity": "critical",
 "type": "threat", "url": "https://fire.example.com/app/alerts/345", "lat": -31.34, "lon": -64.41, "alert_id": 345,
 "asset_name": "Pine Ridge", "data": {"eta_likely_h": 6, "distance_km": 4.2}}}
```

Verify `X-Firealerts-Signature` (HMAC-SHA256 of `"<X-Firealerts-Timestamp>.<raw body>"`) and reject old timestamps:

```python
import hashlib, hmac, time

def verify(secret: str, body: bytes, timestamp: str, signature: str, tolerance=300) -> bool:
    if abs(time.time() - int(timestamp)) > tolerance:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

```js
import crypto from "node:crypto";
export function verify(secret, rawBody, timestamp, signature) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

## Errors

| Status | Meaning |
|---|---|
| 400 / 422 | Invalid input (`detail` explains) |
| 401 | Missing or expired token |
| 402 | Plan limit reached (`detail` names the limit) |
| 403 | Your role or organisation does not allow this |
| 404 | Not found in your organisation |
| 429 | Too many attempts (sign-in, reset, verification) |
| 502 | An upstream data provider failed (weather, Sentinel-2, Earth Engine…) |
