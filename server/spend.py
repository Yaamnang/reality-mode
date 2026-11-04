"""Estimates how much Meta credit is left, since the API has no balance endpoint.

Starts from the balance shown on the dev.meta.ai dashboard (`balance_at_start` in spend.json,
edit it to re-sync) and subtracts the cost of every paid call this server makes, using the
prices in Meta's docs. The dashboard is the real number; this is an estimate between checks.
"""

import json
import threading
from datetime import datetime
from pathlib import Path

FILE = Path(__file__).resolve().parent / "spend.json"

# Prices per Meta's pricing page (USD).
SPARK_INPUT_PER_M = 1.25
SPARK_CACHED_PER_M = 0.15
SPARK_OUTPUT_PER_M = 4.25  # reasoning tokens are billed as output
IMAGE_EACH = 0.01
SAM_IMAGE_EACH = 0.0025  # $2.50 per 1,000 images
VOICE_PER_HOUR = 0.18  # metered in whole seconds

# Dashboard balance on 2026-10-31, as reported by the user.
DEFAULT_START = 149.94795

_lock = threading.Lock()
_this_run = 0.0  # spent since this server started


def _load() -> dict:
    if FILE.exists():
        return json.loads(FILE.read_text(encoding="utf-8"))
    return {"balance_at_start": DEFAULT_START, "since": datetime.now().isoformat(timespec="seconds"), "spent": 0.0, "calls": 0}


def add(cost: float, what: str) -> None:
    """Records one paid call."""
    global _this_run
    with _lock:
        _this_run += cost
        data = _load()
        data["spent"] = round(data["spent"] + cost, 6)
        data["calls"] += 1
        FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"[spend] {what}: ${cost:.5f}, estimated balance ${data['balance_at_start'] - data['spent']:.4f}", flush=True)


def this_run() -> float:
    """Estimated spend since this server started."""
    with _lock:
        return _this_run


def spark_cost(usage) -> float:
    """Cost of one Muse Spark call from the `usage` Meta returns with it."""
    if usage is None:
        return 0.0
    cached = getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", 0) or 0
    fresh = (usage.input_tokens or 0) - cached
    return (fresh * SPARK_INPUT_PER_M + cached * SPARK_CACHED_PER_M + (usage.output_tokens or 0) * SPARK_OUTPUT_PER_M) / 1e6


def summary() -> dict:
    with _lock:
        data = _load()
    return {
        "balance": round(data["balance_at_start"] - data["spent"], 5),
        "spent": round(data["spent"], 5),
        "calls": data["calls"],
        "since": data["since"],
    }
