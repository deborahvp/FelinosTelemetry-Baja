"""Phone axes → vehicle axes (ISO 8855: x forward, y left, z up).

Same model as the dashboard (``dashboard/vehicle.js``) so live and offline numbers agree:

- The phone is rigid to the chassis, so vehicle axes in phone coordinates are constant. They are
  built from a gravity *level reference* (the quietest window near the start of the recording)
  and the signed ``axis_map`` of ``meta.yaml``.
- Android reports gravity pointing up and linear acceleration in the direction of motion (m/s²);
  raw iOS reports gravity pointing down, acceleration with the opposite sign, and may use g. Both
  are detected from the data: gravity sign against the mounted vertical axis, gravity magnitude.

Output columns: ``time_ns, t_s, a_long, a_lat, a_vert`` (g, gravity removed), ``sf`` (|specific
force| in g: ≈1 at rest, ≈0 in free fall), ``yaw_rate`` (deg/s, + = left), ``pitch`` (deg, nose
up +) and ``roll`` (deg).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
import pandas as pd

from felinos_telemetry.io.sensorlogger import pivot_sensor
from felinos_telemetry.models import AxisMap

G0 = 9.80665
FloatArray = npt.NDArray[np.float64]
_IDX = {"x": 0, "y": 1, "z": 2}


@dataclass(frozen=True)
class VehicleFrame:
    f: FloatArray  # forward, phone coordinates (unit)
    l: FloatArray  # left  # noqa: E741 - ISO 8855 axis name
    u: FloatArray  # up
    accel_sign: int  # -1 for the iOS (gravity-down) convention
    unit_scale: float  # multiply accelerometer/gravity readings by this to get m/s²
    reference_gravity: FloatArray


def axis_vectors(axis_map: AxisMap) -> dict[str, FloatArray]:
    out: dict[str, FloatArray] = {}
    for vehicle_axis, (phone_axis, sign) in axis_map.resolve().items():
        v = np.zeros(3)
        v[_IDX[phone_axis]] = sign
        out[vehicle_axis] = v
    return out


def _unit(v: FloatArray) -> FloatArray:
    n = float(np.linalg.norm(v))
    if n < 1e-9:
        raise ValueError("zero vector")
    return v / n


def frame_from_gravity(gravity: FloatArray, axis_map: AxisMap) -> VehicleFrame:
    axes = axis_vectors(axis_map)
    g = np.asarray(gravity, dtype=float)
    u = _unit(g)
    accel_sign = 1
    if float(u @ axes["vertical"]) < 0:
        u, accel_sign = -u, -1
    f0 = axes["longitudinal"]
    f = _unit(f0 - (f0 @ u) * u)
    n = float(np.linalg.norm(g))
    return VehicleFrame(
        f=f,
        l=np.cross(u, f),
        u=u,
        accel_sign=accel_sign,
        unit_scale=G0 if 0.3 < n < 3 else 1.0,
        reference_gravity=g,
    )


def _interp_to(t_target: FloatArray, t_src: FloatArray, values: FloatArray) -> FloatArray:
    return np.column_stack([np.interp(t_target, t_src, values[:, i]) for i in range(3)])


def _xyz(df: pd.DataFrame) -> FloatArray:
    return df[["x", "y", "z"]].to_numpy(dtype=float)


def _xyz_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Rows with all three axes present (empty if the sensor is missing)."""
    if not {"x", "y", "z"} <= set(df.columns):
        return df.iloc[0:0]
    return df.dropna(subset=["x", "y", "z"])


def quietest_window(t: FloatArray, accel: FloatArray, window_s: float, search_s: float) -> slice:
    """Slice of the lowest-RMS acceleration window within the first ``search_s`` seconds."""
    end = np.searchsorted(t, t[0] + search_s)
    best, best_rms = slice(0, np.searchsorted(t, t[0] + window_s)), np.inf
    step = max(1, int(np.searchsorted(t, t[0] + 0.5)))
    for i in range(0, max(1, end), step):
        j = int(np.searchsorted(t, t[i] + window_s))
        if j >= len(t) or t[j - 1] - t[i] < window_s * 0.9:
            break
        rms = float(np.sqrt(np.mean(np.sum(accel[i:j] ** 2, axis=1))))
        if rms < best_rms:
            best, best_rms = slice(i, j), rms
    return best


def vehicle_signals(
    long: pd.DataFrame,
    axis_map: AxisMap,
    level_window_s: float = 5.0,
    level_search_s: float = 60.0,
) -> tuple[pd.DataFrame, VehicleFrame]:
    """Vehicle-frame signals at the accelerometer timestamps, plus the frame used."""
    acc = _xyz_rows(pivot_sensor(long, "accelerometer"))
    grav = _xyz_rows(pivot_sensor(long, "gravity"))
    if acc.empty or grav.empty:
        raise ValueError("accelerometer and gravity are required")
    t = acc["time_ns"].to_numpy(dtype=np.int64)
    ts = t / 1e9
    a_raw = _xyz(acc)
    g = _interp_to(ts, grav["time_ns"].to_numpy() / 1e9, _xyz(grav))
    gyro_df = _xyz_rows(pivot_sensor(long, "gyroscope"))
    w = (
        _interp_to(ts, gyro_df["time_ns"].to_numpy() / 1e9, _xyz(gyro_df))
        if not gyro_df.empty
        else np.zeros_like(a_raw)
    )

    window = quietest_window(ts, a_raw, level_window_s, level_search_s)
    frame = frame_from_gravity(g[window].mean(axis=0), axis_map)
    a = a_raw * frame.unit_scale * frame.accel_sign  # m/s², Android sign convention
    up_now = g / np.linalg.norm(g, axis=1, keepdims=True) * frame.accel_sign
    sf = np.linalg.norm(a + up_now * G0, axis=1) / G0
    pitch = np.degrees(np.arcsin(np.clip(up_now @ frame.f, -1, 1)))
    roll = np.degrees(np.arcsin(np.clip(up_now @ frame.l, -1, 1)))
    out = pd.DataFrame(
        {
            "time_ns": t,
            "t_s": ts,
            "a_long": a @ frame.f / G0,
            "a_lat": a @ frame.l / G0,
            "a_vert": a @ frame.u / G0,
            "sf": sf,
            "yaw_rate": np.degrees(w @ frame.u),
            "pitch": pitch,
            "roll": roll,
        }
    )
    return out, frame
