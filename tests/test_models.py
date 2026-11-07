from pathlib import Path

import pytest
from pydantic import ValidationError

from felinos_telemetry.models import (
    AxisMap,
    Criterion,
    RunMeta,
    TestType,
    load_requirements,
    load_run_meta,
    load_vehicle_config,
)

ROOT = Path(__file__).resolve().parents[1]


def test_meta_template_is_valid() -> None:
    meta = load_run_meta(ROOT / "templates" / "meta.yaml")
    assert meta.run_id == "R01"
    assert meta.test_type is TestType.ACCELERATION
    assert meta.device.axis_map.resolve()["longitudinal"] == ("y", 1)


def test_repo_configs_are_valid() -> None:
    vehicle = load_vehicle_config(ROOT / "config" / "vehicles" / "felinos-2027.yaml")
    assert vehicle.vehicle_id == "felinos-2027"
    reqs = load_requirements(ROOT / "config" / "requirements.yaml")
    assert [r.id for r in reqs] == ["VG-04", "VG-05", "VG-06"]
    assert reqs[0].criterion.check(4.2)
    assert not reqs[0].criterion.check(4.6)


def test_minimal_meta_uses_defaults() -> None:
    meta = RunMeta.model_validate(
        {"vehicle_id": "thundercat", "date": "2026-11-08", "session_id": "s", "run_id": "R12"}
    )
    assert meta.test_type is TestType.FREE
    assert meta.configuration.tire_pressure_psi.front == 0


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("run_id", "run1"),
        ("test_type", "drag"),
        ("requirement_ids", ["vg-04"]),
        ("unknown_field", 1),
    ],
)
def test_invalid_meta_is_rejected(field: str, value: object) -> None:
    data = {"vehicle_id": "v", "date": "2026-11-08", "session_id": "s", "run_id": "R01"}
    data[field] = value
    with pytest.raises(ValidationError):
        RunMeta.model_validate(data)


def test_axis_map_signed() -> None:
    axes = AxisMap(x="-longitudinal", y="vertical", z="lateral").resolve()
    assert axes == {"longitudinal": ("x", -1), "vertical": ("y", 1), "lateral": ("z", 1)}


@pytest.mark.parametrize(
    "mapping",
    [
        {"x": "lateral", "y": "lateral", "z": "vertical"},
        {"x": "sideways", "y": "longitudinal", "z": "vertical"},
    ],
)
def test_axis_map_invalid(mapping: dict[str, str]) -> None:
    with pytest.raises(ValidationError):
        AxisMap.model_validate(mapping)


@pytest.mark.parametrize(
    ("op", "measured", "expected"),
    [("<", 1, True), ("<", 2, False), (">", 3, True), (">=", 2, True), ("==", 2, True)],
)
def test_criterion_ops(op: str, measured: float, expected: bool) -> None:
    assert Criterion.model_validate({"op": op, "value": 2}).check(measured) is expected
