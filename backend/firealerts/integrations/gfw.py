"""Global Forest Watch Data API (requires a free API key)."""

from __future__ import annotations

import httpx

API = "https://data-api.globalforestwatch.org"


async def _query(client: httpx.AsyncClient, api_key: str, dataset: str, sql: str, geometry: dict) -> list[dict]:
    resp = await client.post(f"{API}/dataset/{dataset}/latest/query/json", headers={"x-api-key": api_key}, json={"sql": sql, "geometry": geometry}, timeout=60)
    resp.raise_for_status()
    return resp.json().get("data", [])


async def tree_cover_loss(client: httpx.AsyncClient, api_key: str, geometry: dict, canopy: int = 30) -> list[dict]:
    rows = await _query(
        client,
        api_key,
        "umd_tree_cover_loss",
        f"SELECT umd_tree_cover_loss__year, SUM(area__ha) AS loss_ha FROM results WHERE umd_tree_cover_density_2000__threshold >= {int(canopy)} GROUP BY umd_tree_cover_loss__year ORDER BY umd_tree_cover_loss__year",
        geometry,
    )
    return [{"year": int(r["umd_tree_cover_loss__year"]), "loss_ha": round(float(r["loss_ha"]), 2)} for r in rows if r.get("umd_tree_cover_loss__year")]


async def integrated_alerts(client: httpx.AsyncClient, api_key: str, geometry: dict, since: str) -> dict:
    rows = await _query(
        client,
        api_key,
        "gfw_integrated_alerts",
        f"SELECT COUNT(*) AS alerts, SUM(area__ha) AS area_ha FROM results WHERE gfw_integrated_alerts__date >= '{since}'",
        geometry,
    )
    r = rows[0] if rows else {}
    return {"since": since, "alerts": int(r.get("alerts") or 0), "area_ha": round(float(r.get("area_ha") or 0), 2)}


async def test(client: httpx.AsyncClient, api_key: str) -> str:
    resp = await client.get(f"{API}/datasets", headers={"x-api-key": api_key}, timeout=30)
    resp.raise_for_status()
    return f"{len(resp.json().get('data', []))} datasets"
