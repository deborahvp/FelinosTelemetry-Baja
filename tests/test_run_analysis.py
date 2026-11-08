import json
import math
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml
from typer.testing import CliRunner

from felinos_telemetry.analysis.run import FT_PER_M, analyze
from felinos_telemetry.cli import app
from felinos_telemetry.io.sensorlogger import read_export
from felinos_telemetry.models import (
    RunMeta,
    VehicleConfig,
    load_requirements,
)
from felinos_telemetry.processing.frames import G0
from felinos_telemetry.reporting.run_report import write_results
from felinos_telemetry.reporting.usage import collect

ROOT = Path(__file__).resolve().parents[1]
REQS = load_requirements(ROOT / "config" / "requirements.yaml")


def _meta(test_type: str, axis_map: dict[str, str] | None = None) -> RunMeta:
    return RunMeta.model_validate(
        {
            "vehicle_id": "felinos-2027",
            "date": "2026-11-08",
            "session_id": "s",
            "run_id": "R01",
            "test_type": test_type,
            "device": {
                "axis_map": axis_map or {"x": "lateral", "y": "longitudinal", "z": "vertical"}
            },
        }
    )


def _sensor(name: str, t: np.ndarray, **fields: np.ndarray) -> pd.DataFrame:
    return pd.concat(
        [
            pd.DataFrame({"time_ns": t, "sensor": name, "field": k, "value": v})
            for k, v in fields.items()
        ],
        ignore_index=True,
    )


def synthetic_run(
    seconds: float, a_long_g: np.ndarray, yaw_deg_s: np.ndarray, speed_kmh_at: np.ndarray
) -> pd.DataFrame:
    """Flat phone (Android convention) at 100 Hz plus 1 Hz GPS heading north."""
    n = int(seconds * 100)
    t_ns = (1.8e18 + np.arange(n) * 1e7).astype("int64")
    zeros = np.zeros(n)
    long_df = [
        _sensor("gravity", t_ns, x=zeros, y=zeros, z=np.full(n, G0)),
        _sensor("accelerometer", t_ns, x=zeros, y=a_long_g * G0, z=zeros),
        _sensor("gyroscope", t_ns, x=zeros, y=zeros, z=np.radians(yaw_deg_s)),
    ]
    tg = np.arange(0, int(seconds))
    tg_ns = (1.8e18 + tg * 1e9).astype("int64")
    speed = speed_kmh_at[tg * 100]
    north = np.concatenate([[0], np.cumsum(speed[1:] / 3.6)]) / 111_195
    long_df.append(
        _sensor(
            "location",
            tg_ns,
            latitude=21.0894 + north,
            longitude=np.full(tg.size, -101.6987),
            speed=speed / 3.6,
            horizontalAccuracy=np.full(tg.size, 3.0),
        )
    )
    return pd.concat(long_df, ignore_index=True)


def test_vg04_launch_from_synthetic_recording() -> None:
    t = np.arange(0, 15, 0.01)
    a = np.where((t >= 8) & (t < 13), 0.5, 0.0)  # 8 s rest (level + bias), then 0.5 g
    speed = np.where(t < 8, 0.0, np.minimum(0.5 * G0 * (t - 8), 0.5 * G0 * 5) * 3.6)
    s = analyze(
        synthetic_run(15, a, np.zeros_like(t), speed), meta=_meta("acceleration"), requirements=REQS
    )
    assert len(s["attempts"]) == 1
    goal = s["goals"][0]
    assert goal["id"] == "VG-04"
    assert goal["value"] == pytest.approx(math.sqrt(2 * 30.48 / (0.5 * G0)), abs=0.05)
    assert goal["pass"] is True  # 3.53 s <= 4.3 s
    assert goal["uncertainty"] < 0.2
    assert s["frame"]["platform_convention"] == "android"


def test_vg05_inner_radius_needs_track_width() -> None:
    t = np.arange(0, 20, 0.01)
    v, r = 8.0, 2.5
    yaw = np.where((t >= 8) & (t < 18), math.degrees((v / 3.6) / r), 0.0)
    speed = np.full_like(t, v)
    long = synthetic_run(20, np.zeros_like(t), yaw, speed)
    no_track = analyze(long, meta=_meta("turning"), requirements=REQS)["goals"][0]
    assert no_track["value"] is None
    assert no_track["radius_cg_m"] == pytest.approx(r, abs=0.02)
    assert "track_width_m" in no_track["note"]
    vehicle = VehicleConfig(vehicle_id="felinos-2027", track_width_m=1.4)
    goal = analyze(long, meta=_meta("turning"), vehicle=vehicle, requirements=REQS)["goals"][0]
    assert goal["value"] == pytest.approx((r - 0.7) * FT_PER_M, abs=0.1)  # 5.9 ft
    assert goal["pass"] is True


def test_real_export_summary_and_results_files(export_dir: Path, tmp_path: Path) -> None:
    s = analyze(
        read_export(export_dir),
        meta=_meta("free", {"x": "lateral", "y": "vertical", "z": "longitudinal"}),
        requirements=REQS,
    )
    assert s["goals"] == []  # a free run verifies no requirement
    assert s["usage"]["active_gps_s"] == pytest.approx(22, abs=0.5)
    assert s["usage"]["distance_km"] == pytest.approx(0.128, abs=0.005)
    assert s["durability"]["cycles"] > 100
    assert set(s["durability"]["pseudo_damage"]) == {"m3", "m5"}
    assert s["quality"]["sensors"]["accelerometer"]["rate_hz"] == pytest.approx(100, abs=1)
    paths = write_results(s, tmp_path / "results")
    summary = json.loads(paths["summary"].read_text(encoding="utf-8"))
    assert "_events" not in summary
    report = paths["report"].read_text(encoding="utf-8")
    for section in (
        "## Vehicle goals",
        "## Usage",
        "## Events",
        "## Durability (VG-02)",
        "## Data quality",
    ):
        assert section in report
    assert paths["events"].read_text(encoding="utf-8").startswith("type,t,peak,airtime,bin")


def _make_run(root: Path, name: str, export_dir: Path, test_type: str) -> Path:
    run = root / "2026-11-08" / name
    shutil.copytree(export_dir, run / "export")
    meta = yaml.safe_load((ROOT / "templates" / "meta.yaml").read_text(encoding="utf-8"))
    meta.update({"run_id": name.split("_")[0], "test_type": test_type, "requirement_ids": []})
    (run / "meta.yaml").write_text(yaml.safe_dump(meta), encoding="utf-8")
    return run


def test_cli_analyze_and_usage(export_dir: Path, tmp_path: Path) -> None:
    runner = CliRunner()
    for name, test in (("R01_free", "free"), ("R02_acceleration", "acceleration")):
        run = _make_run(tmp_path, name, export_dir, test)
        result = runner.invoke(app, ["analyze", str(run)])
        assert result.exit_code == 0, result.output
        assert (run / "results" / "summary.json").exists()
    assert "VG-04" in result.output  # acceleration run reports its goal
    totals = collect(tmp_path)
    assert totals.runs == 2
    assert totals.equivalent_h is None  # no reference damage rate configured
    out = runner.invoke(app, ["usage", str(tmp_path), "--csv", str(tmp_path / "usage.csv")])
    assert out.exit_code == 0, out.output
    assert "TOTAL 2 runs" in out.output
    assert (tmp_path / "usage.csv").read_text(encoding="utf-8").startswith("run_dir,")


def test_cli_errors(tmp_path: Path) -> None:
    runner = CliRunner()
    assert runner.invoke(app, ["analyze", str(tmp_path)]).exit_code == 2  # no export
    assert runner.invoke(app, ["usage", str(tmp_path / "missing")]).exit_code == 2
    assert runner.invoke(app, ["usage", str(tmp_path)]).exit_code == 1  # nothing analyzed
