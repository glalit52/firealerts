import numpy as np
import pytest

from firealerts.ml import dataset, features, model


def test_feature_row_order_and_values():
    day = {"date": "2026-07-01", "fwi": 30.0, "ffmc": 92.0, "dmc": 50.0, "dc": 400.0, "isi": 12.0, "bui": 80.0, "temp": 30.0, "rh": 20.0, "wind": 20.0, "rain": 0.0}
    static = {"frac_tree": 0.2, "frac_shrub": 0.1, "frac_grass": 0.5, "frac_crop": 0.1, "frac_nonfuel": 0.1, "elev_m": 500.0, "slope_pct": 8.0}
    r = features.row(day, static, -31.0, recent_fires=3)
    assert len(r) == len(features.FEATURES)
    f = dict(zip(features.FEATURES, r))
    assert f["fwi"] == 30 and f["abs_lat"] == 31 and f["recent_fires"] == pytest.approx(np.log1p(3))


def test_landcover_fractions_sum_to_one():
    fr = features.landcover_fractions(np.array([10, 10, 20, 30, 40, 80, 50, 95]))
    assert sum(fr.values()) == pytest.approx(1.0)
    assert fr["frac_tree"] == pytest.approx(3 / 8)


def test_baseline_increases_with_fwi():
    X = np.zeros((2, len(features.FEATURES)))
    i = features.FEATURES.index("fwi")
    X[:, features.FEATURES.index("frac_grass")] = 1
    X[0, i], X[1, i] = 2, 60
    p = model.BaselineModel().predict_proba(X)
    assert 0 < p[0] < p[1] < 1


def test_train_save_load_roundtrip(tmp_path):
    pytest.importorskip("sklearn")
    X, y, order = dataset.synthetic_dataset(n_cells=30, n_days=150)
    assert 0.01 < y.mean() < 0.2  # realistic base rate
    m = model.train(X, y, order, region="test")
    assert m.meta["test"]["roc_auc"] > 0.75
    assert m.meta["test"]["brier"] < m.meta["test_baseline"]["brier"]  # calibrated beats heuristic
    path = str(tmp_path / "m.joblib")
    model.save(m, path)
    loaded = model.load(path)
    assert loaded.kind == "trained" and np.allclose(loaded.predict_proba(X[:5]), m.predict_proba(X[:5]))


def test_load_missing_or_corrupt_falls_back(tmp_path):
    assert model.load(str(tmp_path / "missing.joblib")).kind == "baseline"
    bad = tmp_path / "bad.joblib"
    bad.write_bytes(b"not a model")
    m = model.load(str(bad))
    assert m.kind == "baseline" and "warning" in m.meta
