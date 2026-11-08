"""The dashboard's live thresholds and requirements must match config/*.yaml."""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

from felinos_telemetry.models import load_requirements

ROOT = Path(__file__).resolve().parents[1]
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def _camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


def _to_camel(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {_camel(k): _to_camel(v) for k, v in obj.items()}
    return obj


def _dashboard() -> dict[str, Any]:
    out = subprocess.run(
        ["node", str(ROOT / "tests" / "dashboard" / "emit_defaults.mjs")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    data: dict[str, Any] = json.loads(out)
    return data


@needs_node
def test_dashboard_thresholds_match_config() -> None:
    cfg = yaml.safe_load((ROOT / "config" / "analysis.yaml").read_text(encoding="utf-8"))
    expected = _to_camel(cfg)
    # Offline-only settings are not needed live.
    for key in ("rainflowChannel", "wohlerM", "referenceDamagePerHour"):
        expected["durability"].pop(key)
    assert _dashboard()["analysis"] == expected


@needs_node
def test_dashboard_requirements_match_config() -> None:
    reqs = {r.id: r for r in load_requirements(ROOT / "config" / "requirements.yaml")}
    js = _dashboard()["requirements"]
    assert [r["id"] for r in js] == list(reqs)
    for r in js:
        cfg = reqs[r["id"]]
        assert (r["test"], r["metric"], r["op"], r["value"], r["minRuns"]) == (
            cfg.method,
            cfg.metric,
            cfg.criterion.op,
            cfg.criterion.value,
            cfg.min_runs,
        )
