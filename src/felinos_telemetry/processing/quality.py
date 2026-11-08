"""Data quality: real sample rate per sensor, gaps and accelerometer clipping.

Every report includes this section so a result is never read without knowing how good the data
behind it was.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from felinos_telemetry.io.sensorlogger import pivot_sensor, sensors_in


@dataclass(frozen=True)
class SensorQuality:
    samples: int
    duration_s: float
    rate_hz: float
    gaps: int  # intervals longer than 3x the median period
    longest_gap_s: float


def sensor_quality(long: pd.DataFrame) -> dict[str, SensorQuality]:
    out: dict[str, SensorQuality] = {}
    for sensor in sensors_in(long):
        t = np.unique(long.loc[long["sensor"] == sensor, "time_ns"].to_numpy()) / 1e9
        if t.size < 2:
            out[sensor] = SensorQuality(int(t.size), 0.0, 0.0, 0, 0.0)
            continue
        dt = np.diff(t)
        nominal = float(np.median(dt))
        gaps = dt > 3 * nominal
        out[sensor] = SensorQuality(
            samples=int(t.size),
            duration_s=float(t[-1] - t[0]),
            rate_hz=float((t.size - 1) / (t[-1] - t[0])),
            gaps=int(gaps.sum()),
            longest_gap_s=float(np.max(dt)),
        )
    return out


def clipping_fraction(long: pd.DataFrame, sensor: str = "accelerometer", run: int = 3) -> float:
    """Share of samples sitting at the axis' extreme value for ``run``+ consecutive samples.

    A phone accelerometer saturates at its range (e.g. ±8 g or ±16 g): landings that hit the
    limit read as flat-topped peaks. Non-zero values mean impact peaks are underestimated.
    """
    df = pivot_sensor(long, sensor)
    clipped = 0
    total = 0
    for axis in ("x", "y", "z"):
        if axis not in df:
            continue
        v = df[axis].dropna().to_numpy()
        if v.size < run:
            continue
        total += v.size
        peak = np.abs(v).max()
        if peak == 0:
            continue
        at_peak = np.isclose(np.abs(v), peak, rtol=0, atol=peak * 1e-6)
        # count only runs of `run` or more consecutive samples at the extreme
        edges = np.diff(np.concatenate([[0], at_peak.astype(int), [0]]))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        clipped += int(sum(e - s for s, e in zip(starts, ends, strict=True) if e - s >= run))
    return clipped / total if total else 0.0


def quality_dict(long: pd.DataFrame) -> dict[str, object]:
    return {
        "sensors": {k: asdict(v) for k, v in sensor_quality(long).items()},
        "accelerometer_clipping_fraction": clipping_fraction(long),
    }
