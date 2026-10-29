import bz2
import io

import numpy as np
import pytest

from firealerts.sources import himawari, meteosat

WLF_CSV = """# Himawari-9 wildfire product
Time,Lat,Lon,Area,Volcano,Level,Reliability,FRP,QF
2026-10-22 03:00,-2.25,113.91,0.4,0,3,5,85.2,0
2026-10-22 03:00,-37.40,147.20,0.2,0,2,2,12.0,0
bad,row,,,
"""


def test_himawari_csv_by_header_name():
    rows = himawari.parse_csv(WLF_CSV, "H09_20261022_0300_L2WLF010_FLDK.06001_06001.csv")
    assert len(rows) == 2
    a, b = rows
    assert a["source"] == "HIMAWARI9" and a["frp"] == 85.2 and a["confidence"] == "h"
    assert b["confidence"] == "n"
    assert a["acq_time"].hour == 3 and a["acq_time"].day == 22


def test_himawari_alternate_headers():
    text = "latitude,longitude,fire radiative power,confidence\n10.5,120.1,30,90\n"
    r = himawari.parse_csv(text, "x_20261022_0310_y.csv")[0]
    assert (r["lat"], r["lon"], r["frp"], r["confidence"]) == (10.5, 120.1, 30.0, "h")
    assert himawari.parse_csv("no,header,here\n1,2,3\n", "f.csv") == []


def _frp_pixel_file(compress=False) -> bytes:
    h5py = pytest.importorskip("h5py")
    buf = io.BytesIO()
    with h5py.File(buf, "w") as f:
        for name, vals, sf in (("LATITUDE", [3725, -1930], 100), ("LONGITUDE", [-845, 2280], 100), ("FRP", [452, 98], 10), ("FIRE_CONFIDENCE", [95, 40], 100), ("PIXEL_SIZE", [900, 1600], 100)):
            ds = f.create_dataset(name, data=np.array(vals, dtype="int32"))
            ds.attrs["SCALING_FACTOR"] = sf
    blob = buf.getvalue()
    return bz2.compress(blob) if compress else blob


@pytest.mark.parametrize("compress", [False, True])
def test_meteosat_frp_pixel_list_product(compress):
    rows = meteosat.parse_hdf5(_frp_pixel_file(compress), "HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_202610221215")
    assert len(rows) == 2
    a, b = rows
    assert a["lat"] == pytest.approx(37.25) and a["lon"] == pytest.approx(-8.45)
    assert a["frp"] == pytest.approx(45.2) and a["confidence"] == "h" and a["pixel_m"] == pytest.approx(3000)
    assert b["confidence"] == "n" and b["source"] == "METEOSAT"
    assert a["acq_time"].hour == 12 and a["acq_time"].minute == 15
