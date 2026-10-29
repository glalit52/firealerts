"""Ignition-probability model: gradient-boosted trees with a transparent fallback."""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone

import numpy as np

from .features import FEATURES


class BaselineModel:
    """Hand-set logistic model on FWI, fuel type and recent activity (used until a model is trained)."""

    kind = "baseline"

    def __init__(self):
        self.meta = {
            "kind": "baseline",
            "description": "Heuristic logistic model on FWI, land cover and recent fires. Not trained or calibrated.",
            "features": FEATURES,
        }

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        f = {k: X[:, i] for i, k in enumerate(FEATURES)}
        z = (
            -5.5
            + 1.1 * np.log1p(np.maximum(f["fwi"], 0))
            + 1.2 * (f["frac_grass"] + f["frac_crop"])
            + 0.8 * f["frac_shrub"]
            + 0.4 * f["frac_tree"]
            - 4.0 * f["frac_nonfuel"]
            + 0.6 * f["recent_fires"]
            - 0.3 * np.minimum(f["rain"], 10)
        )
        return 1 / (1 + np.exp(-z))


class TrainedModel:
    kind = "trained"

    def __init__(self, estimator, meta: dict):
        self.estimator = estimator
        self.meta = meta

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.estimator.predict_proba(X)[:, 1]


def _day(ordinal) -> str:
    from datetime import date

    return date.fromordinal(int(ordinal)).isoformat()


def _metrics(y: np.ndarray, p: np.ndarray) -> dict:
    from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

    out = {"n": int(len(y)), "positive_rate": round(float(y.mean()), 4), "brier": round(float(brier_score_loss(y, p)), 4)}
    if 0 < y.sum() < len(y):
        out["roc_auc"] = round(float(roc_auc_score(y, p)), 4)
        out["avg_precision"] = round(float(average_precision_score(y, p)), 4)
    return out


def train(X: np.ndarray, y: np.ndarray, order: np.ndarray, region: str = "", test_frac: float = 0.25, random_state: int = 0) -> TrainedModel:
    """Fit on the earliest (1 - test_frac) of the data by `order` (dates) and evaluate on the rest.

    A time-ordered split is used deliberately: random splits leak weather and
    persistent fires between train and test days and overstate skill.
    """
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.ensemble import HistGradientBoostingClassifier

    idx = np.argsort(order, kind="stable")
    cut = int(len(idx) * (1 - test_frac))
    tr, te = idx[:cut], idx[cut:]
    base = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=1.0, random_state=random_state)
    est = CalibratedClassifierCV(base, method="isotonic", cv=3)
    est.fit(X[tr], y[tr])
    p_te = est.predict_proba(X[te])[:, 1]
    meta = {
        "kind": "trained",
        "description": "Gradient-boosted trees (scikit-learn HistGradientBoosting) with isotonic calibration.",
        "features": FEATURES,
        "region": region,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "train_rows": int(len(tr)),
        "test": _metrics(y[te], p_te),
        "test_baseline": _metrics(y[te], BaselineModel().predict_proba(X[te])),
        "test_period": [_day(order[te].min()), _day(order[te].max())] if len(te) else None,
    }
    return TrainedModel(est, meta)


def save(model: TrainedModel, path: str) -> None:
    import joblib

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    joblib.dump({"estimator": model.estimator, "meta": model.meta}, path)
    with open(path + ".json", "w") as f:
        json.dump(model.meta, f, indent=2)


_loaded: dict = {}


def load(path: str):
    """The trained model at path, or the baseline when none exists (cached by mtime)."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return BaselineModel()
    if _loaded.get("key") != (path, mtime):
        try:
            import joblib

            blob = joblib.load(path)
            if blob["meta"].get("features") != FEATURES:
                raise ValueError("model was trained on a different feature set")
            _loaded.update(key=(path, mtime), model=TrainedModel(blob["estimator"], blob["meta"]))
        except Exception as exc:  # corrupt file, missing sklearn, feature mismatch
            m = BaselineModel()
            m.meta["warning"] = f"could not load {path}: {exc}"
            return m
    return _loaded["model"]


def sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z))
