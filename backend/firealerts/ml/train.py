"""Train the ignition-risk model.

    python -m firealerts.ml.train --demo
    python -m firealerts.ml.train --bbox -66,-34,-62,-29 --start 2024-01-01 --end 2025-12-31 --map-key KEY
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import date

import httpx

from ..config import settings
from . import dataset, model


def main(argv=None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="train on the synthetic data set (offline)")
    ap.add_argument("--bbox", help="west,south,east,north")
    ap.add_argument("--start", type=date.fromisoformat)
    ap.add_argument("--end", type=date.fromisoformat)
    ap.add_argument("--cell", type=float, default=0.25, help="grid cell size in degrees")
    ap.add_argument("--map-key", default=settings.firms_map_key, help="NASA FIRMS MAP_KEY (archive access)")
    ap.add_argument("--out", default=settings.model_path)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.demo:
        X, y, order = dataset.synthetic_dataset()
        region = "synthetic demo"
    else:
        if not (args.bbox and args.start and args.end and args.map_key):
            ap.error("--bbox, --start, --end and a FIRMS --map-key are required (or use --demo)")
        bbox = tuple(float(v) for v in args.bbox.split(","))

        async def build():
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                return await dataset.live_dataset(client, args.map_key, bbox, args.start, args.end, args.cell)

        X, y, order = asyncio.run(build())
        region = args.bbox
    if y.sum() < 20:
        raise SystemExit(f"only {int(y.sum())} fire cell-days in the data set; widen the area or period")
    m = model.train(X, y, order, region=region)
    model.save(m, args.out)
    print(json.dumps(m.meta, indent=2))
    return m.meta


if __name__ == "__main__":
    main()
