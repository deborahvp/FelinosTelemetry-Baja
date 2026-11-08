"""The meta.yaml downloaded from the dashboard run log must validate as RunMeta."""

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from felinos_telemetry.models import RunMeta, TestType

SCRIPT = Path(__file__).parent / "dashboard" / "emit_meta.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_dashboard_meta_yaml_is_valid_runmeta() -> None:
    out = subprocess.run(
        ["node", str(SCRIPT)], capture_output=True, text=True, encoding="utf-8", check=True
    ).stdout
    docs = list(yaml.safe_load_all(out))
    assert len(docs) == len(TestType)
    metas = [RunMeta.model_validate(d) for d in docs]
    assert {m.test_type for m in metas} == set(TestType)
    accel = next(m for m in metas if m.test_type is TestType.ACCELERATION)
    assert accel.requirement_ids == ["VG-04"]
    assert accel.driver == 'Ana "Turbo" Pérez'
    assert accel.session_id == "2026-11-08_la-salle-bajio"
    assert accel.device.axis_map.resolve()["longitudinal"] == ("x", -1)
    # run IDs auto-increment across recordings
    assert [m.run_id for m in metas] == [f"R{i:02d}" for i in range(1, len(metas) + 1)]
