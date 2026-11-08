"""Analyze one run: data quality, usage, events, vehicle goals and durability.

``analyze`` returns a JSON-serializable summary (schema 1) used by ``felinos analyze`` and,
later, by the DVP&R aggregation. Results are judged against ``config/requirements.yaml``.
"""

from __future__ import annotations

import math
from dataclasses import asdict
from typing import Any

import pandas as pd

from felinos_telemetry import __version__
from felinos_telemetry.analysis.fatigue import durability
from felinos_telemetry.analysis.stream import StreamAnalyzer, run_stream
from felinos_telemetry.models import (
    AnalysisConfig,
    AxisMap,
    Requirement,
    RunMeta,
    VehicleConfig,
)
from felinos_telemetry.processing.frames import vehicle_signals
from felinos_telemetry.processing.gps import gps_track
from felinos_telemetry.processing.quality import quality_dict

FT_PER_M = 3.280839895
SUMMARY_SCHEMA = 1


def _best(values: list[float | None]) -> float | None:
    xs = [v for v in values if v is not None and math.isfinite(v)]
    return min(xs) if xs else None


def _judge(req: Requirement, value: float | None) -> dict[str, Any]:
    return {
        "id": req.id,
        "title": req.title,
        "metric": req.metric,
        "criterion": f"{req.criterion.op} {req.criterion.value}",
        "value": value,
        "pass": None if value is None else bool(req.criterion.check(round(float(value), 3))),
    }


def goal_results(
    an: StreamAnalyzer,
    test_type: str,
    requirements: list[Requirement],
    track_width_m: float | None,
) -> list[dict[str, Any]]:
    """Results for the requirements whose method matches this run's test type."""
    out = []
    for req in requirements:
        if req.method != test_type:
            continue
        extra: dict[str, Any] = {}
        value: float | None = None
        if req.method == "acceleration":
            value = _best([a.t100 for a in an.attempts])
            gps = _best([a.gps100 for a in an.attempts])
            extra = {
                "gps_only": gps,
                "uncertainty": None if value is None or gps is None else abs(value - gps),
            }
        elif req.method == "climb":
            value = _best([a.t150 for a in an.attempts])
            grades = [a.mean_grade_deg for a in an.attempts if a.t150 is not None]
            extra = {
                "gps_only": _best([a.gps150 for a in an.attempts]),
                "mean_grade_deg": grades[0] if grades else None,
            }
        elif req.method == "turning":
            r_cg = _best([t.r_cg_m for t in an.turns])
            extra = {"radius_cg_m": r_cg, "track_width_m": track_width_m}
            if r_cg is not None and track_width_m is not None:
                value = (r_cg - track_width_m / 2) * FT_PER_M
            elif r_cg is not None:
                extra["note"] = "inner-tire radius needs track_width_m in config/vehicles"
        out.append({**_judge(req, value), **extra})
    return out


def analyze(
    long: pd.DataFrame,
    meta: RunMeta | None = None,
    vehicle: VehicleConfig | None = None,
    config: AnalysisConfig | None = None,
    requirements: list[Requirement] | None = None,
) -> dict[str, Any]:
    config = config or AnalysisConfig()
    requirements = requirements or []
    axis_map = (
        meta.device.axis_map
        if meta is not None
        else (
            vehicle.device.axis_map
            if vehicle
            else AxisMap(x="lateral", y="longitudinal", z="vertical")
        )
    )
    signals, frame = vehicle_signals(long, axis_map)
    gps = gps_track(long)
    an = run_stream(signals, gps, config)
    dur = durability(
        signals[config.durability.rainflow_channel].to_numpy(),
        an.active_s,
        config.durability.wohler_m,
        config.durability.reference_damage_per_hour,
    )
    test_type = meta.test_type.value if meta is not None else "free"
    hours = an.active_s / 3600
    return {
        "schema": SUMMARY_SCHEMA,
        "generated_by": f"felinos-telemetry {__version__}",
        "run": {
            "run_id": meta.run_id if meta else None,
            "date": meta.date.isoformat() if meta else None,
            "test_type": test_type,
            "vehicle_id": meta.vehicle_id if meta else (vehicle.vehicle_id if vehicle else None),
            "configuration": meta.configuration.model_dump() if meta else None,
            "driver": meta.driver if meta else None,
        },
        "duration_s": float(signals["t_s"].iloc[-1] - signals["t_s"].iloc[0]),
        "frame": {
            "axis_map": axis_map.model_dump(),
            "platform_convention": "ios" if frame.accel_sign < 0 else "android",
            "units": "g" if frame.unit_scale != 1 else "m/s2",
        },
        "quality": quality_dict(long),
        "usage": {
            "active_s": an.active_s,
            "active_gps_s": an.active_gps_s,
            "active_imu_s": an.active_imu_s,
            "active_h": hours,
            "distance_km": an.distance_m / 1000,
            # distance is measured with GPS only, so average over GPS active time
            "mean_active_speed_kmh": (
                (an.distance_m / 1000) / (an.active_gps_s / 3600) if an.active_gps_s > 0 else None
            ),
        },
        "events": {
            "counts": dict(an.counts),
            "impact_bins_g": config.events.impact_severity_g,
            "impact_bins": list(an.impact_bins),
            "per_active_hour": {k: v / hours for k, v in an.counts.items()} if hours > 0 else None,
        },
        "attempts": [asdict(a) for a in an.attempts],
        "turns": [asdict(t) for t in an.turns],
        "goals": goal_results(
            an, test_type, requirements, vehicle.track_width_m if vehicle else None
        ),
        "durability": {
            "channel": config.durability.rainflow_channel,
            "cycles": dur.cycles,
            "pseudo_damage": {f"m{m:g}": v for m, v in dur.damage.items()},
            "damage_per_active_hour": {f"m{m:g}": v for m, v in dur.damage_per_active_hour.items()},
            "equivalent_hours": dur.equivalent_hours,
            "note": "pseudo-damage is relative (compare runs/configurations); not an absolute life",
        },
        "_events": [asdict(e) for e in an.events],
    }
