"""Typed models for run metadata, vehicle configuration and requirements.

Field names are fixed with the future team platform in mind; bump ``schema_version``
when a breaking change is needed.
"""

from __future__ import annotations

import datetime as dt
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VehicleAxis = Literal["longitudinal", "lateral", "vertical"]
_VEHICLE_AXES: frozenset[str] = frozenset({"longitudinal", "lateral", "vertical"})


class TestType(StrEnum):
    __test__ = False  # not a pytest test class

    ACCELERATION = "acceleration"
    TURNING = "turning"
    CLIMB = "climb"
    OBSTACLES = "obstacles"
    ENDURANCE = "endurance"
    FREE = "free"


class Surface(StrEnum):
    DRY = "dry"
    WET = "wet"
    MUD = "mud"
    SAND = "sand"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TirePressure(_Model):
    front: float = Field(0, ge=0)
    rear: float = Field(0, ge=0)


class Configuration(_Model):
    suspension: str = ""
    cvt: str = ""
    tire_pressure_psi: TirePressure = Field(default_factory=TirePressure)
    ballast_kg: float = Field(0, ge=0)


class Weather(_Model):
    temp_c: float | None = None
    surface: Surface = Surface.DRY


class AxisMap(_Model):
    """Maps each phone axis to a signed vehicle axis, e.g. ``{x: "-lateral"}``."""

    x: str
    y: str
    z: str

    @field_validator("x", "y", "z")
    @classmethod
    def _check_axis(cls, value: str) -> str:
        if value.lstrip("+-") not in _VEHICLE_AXES:
            raise ValueError(f"must be one of {sorted(_VEHICLE_AXES)}, optionally signed")
        return value

    @model_validator(mode="after")
    def _check_permutation(self) -> AxisMap:
        targets = {v.lstrip("+-") for v in (self.x, self.y, self.z)}
        if targets != _VEHICLE_AXES:
            raise ValueError("each vehicle axis must be mapped exactly once")
        return self

    def resolve(self) -> dict[VehicleAxis, tuple[str, int]]:
        """Return ``{vehicle_axis: (phone_axis, sign)}``."""
        out: dict[VehicleAxis, tuple[str, int]] = {}
        for phone_axis, target in (("x", self.x), ("y", self.y), ("z", self.z)):
            sign = -1 if target.startswith("-") else 1
            out[target.lstrip("+-")] = (phone_axis, sign)  # type: ignore[index]
        return out


class Device(_Model):
    model: str = "Galaxy Note 10"
    mounting: str = ""
    axis_map: AxisMap = Field(
        default_factory=lambda: AxisMap(x="lateral", y="longitudinal", z="vertical")
    )


class RunMeta(_Model):
    """Contents of ``meta.yaml`` in each run folder."""

    schema_version: Literal[1] = 1
    vehicle_id: str
    date: dt.date
    session_id: str
    run_id: str = Field(pattern=r"^R\d{2,}$")
    sensorlogger_session_id: str | None = None
    test_type: TestType = TestType.FREE
    requirement_ids: list[str] = Field(default_factory=list)
    driver: str = ""
    configuration: Configuration = Field(default_factory=Configuration)
    track: str = ""
    weather: Weather = Field(default_factory=Weather)
    device: Device = Field(default_factory=Device)
    notes: str = ""

    @field_validator("requirement_ids")
    @classmethod
    def _check_requirement_ids(cls, value: list[str]) -> list[str]:
        for rid in value:
            if not rid or rid != rid.upper():
                raise ValueError(f"requirement id {rid!r} must be uppercase, e.g. VG-04")
        return value


class VehicleConfig(_Model):
    """Static vehicle parameters (``config/vehicles/<id>.yaml``). SI units."""

    vehicle_id: str
    name: str = ""
    mass_kg: float | None = Field(None, gt=0)
    track_width_m: float | None = Field(None, gt=0)
    wheelbase_m: float | None = Field(None, gt=0)
    device: Device = Field(default_factory=Device)


class Criterion(_Model):
    op: Literal["<", "<=", ">", ">=", "=="]
    value: float

    def check(self, measured: float) -> bool:
        ops = {
            "<": measured < self.value,
            "<=": measured <= self.value,
            ">": measured > self.value,
            ">=": measured >= self.value,
            "==": measured == self.value,
        }
        return ops[self.op]


class Requirement(_Model):
    """One row of ``config/requirements.yaml`` (DVP&R traceability)."""

    id: str
    title: str
    metric: str
    criterion: Criterion
    method: str
    min_runs: int = Field(1, ge=1)


def _load_yaml(path: Path) -> Any:
    with Path(path).open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def load_run_meta(path: Path) -> RunMeta:
    return RunMeta.model_validate(_load_yaml(path))


def load_vehicle_config(path: Path) -> VehicleConfig:
    return VehicleConfig.model_validate(_load_yaml(path))


def load_requirements(path: Path) -> list[Requirement]:
    return [Requirement.model_validate(item) for item in _load_yaml(path) or []]
