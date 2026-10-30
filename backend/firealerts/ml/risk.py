"""Serve gridded ignition probabilities for today and the 7-day forecast."""

from __future__ import annotations

import asyncio
from typing import Callable

import httpx
import numpy as np

from ..sources import weather
from . import features, model


async def ignition_grid(
    client: httpx.AsyncClient | None,
    bbox: tuple[float, float, float, float],
    n: int,
    mode: str,
    model_path: str,
    recent_fires: Callable[[float, float, float, float], int],
) -> dict:
    g = await weather.grid_series(client, bbox, n, mode)
    cell_deg = max(g["dx"], g["dy"])
    statics = await asyncio.gather(*[features.cell_static(client, la, lo, cell_deg, mode) for la, lo in g["centres"]])
    m = model.load(model_path)
    feats = []
    for (la, lo), ser, st in zip(g["centres"], g["series"], statics):
        # Detections per cell-day are not comparable across cell sizes; normalise to 0.25° cells.
        recent = recent_fires(lo - g["dx"] / 2, la - g["dy"] / 2, lo + g["dx"] / 2, la + g["dy"] / 2) * (0.25 / cell_deg) ** 2
        X = np.asarray([features.row(day, st, la, recent / 7.0 if k else recent) for k, day in enumerate(ser)])
        p = m.predict_proba(X)
        feats.append(
            {
                "type": "Feature",
                "properties": {"p": [round(float(v), 4) for v in p], "fwi": [d["fwi"] for d in ser], "fuel_frac": round(1 - st["frac_nonfuel"], 2)},
                "geometry": weather.cell_polygon(la, lo, g["dx"], g["dy"]),
            }
        )
    return {"type": "FeatureCollection", "features": feats, "dates": g["dates"], "weather_source": g["source"], "model": m.meta}
