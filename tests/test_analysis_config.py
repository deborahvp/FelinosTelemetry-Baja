"""config/analysis.yaml and the dashboard's live thresholds must stay identical."""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


def _camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.title() if not p[0].isdigit() else p for p in parts[1:])


def _to_camel(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {_camel(k): _to_camel(v) for k, v in obj.items()}
    return obj


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_dashboard_thresholds_match_config() -> None:
    cfg = yaml.safe_load((ROOT / "config" / "analysis.yaml").read_text(encoding="utf-8"))
    out = subprocess.run(
        ["node", str(ROOT / "tests" / "dashboard" / "emit_defaults.mjs")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    js = json.loads(out)
    expected = _to_camel(cfg)
    # Offline-only settings are not needed live.
    for key in ("rainflowChannel", "wohlerM", "referenceDamagePerHour"):
        expected["durability"].pop(key)
    assert js == expected
