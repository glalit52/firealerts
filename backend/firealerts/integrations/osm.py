"""Exposure from OpenStreetMap (Overpass API): settlements, buildings and roads near an asset."""

from __future__ import annotations

import httpx

from ..config import settings

PLACES = "city|town|village|hamlet|isolated_dwelling"
ROADS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|track"


def query(lat: float, lon: float, radius_m: int) -> str:
    around = f"(around:{int(radius_m)},{lat:.6f},{lon:.6f})"
    return (
        f"[out:json][timeout:25];"
        f'node["place"~"{PLACES}"]{around};out count;'
        f'way["building"]{around};out count;'
        f'way["highway"~"{ROADS}"]{around};out count;'
        f'node["place"~"{PLACES}"]{around};out tags center 25;'
    )


def parse(data: dict) -> dict:
    counts, places = [], []
    for el in data.get("elements", []):
        if el.get("type") == "count":
            counts.append(int(el.get("tags", {}).get("total", 0)))
        elif el.get("type") == "node":
            t = el.get("tags", {})
            places.append({"name": t.get("name", ""), "place": t.get("place", ""), "population": t.get("population"), "lat": el.get("lat"), "lon": el.get("lon")})
    counts += [0] * (3 - len(counts))
    return {"settlements": counts[0], "buildings": counts[1], "road_segments": counts[2], "places": places}


async def exposure(client: httpx.AsyncClient, lat: float, lon: float, radius_m: int = 10000) -> dict:
    resp = await client.post(settings.overpass_url, data={"data": query(lat, lon, radius_m)}, timeout=40)
    resp.raise_for_status()
    return {"radius_m": radius_m, **parse(resp.json())}
