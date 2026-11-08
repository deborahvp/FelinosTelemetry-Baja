"""GPS helpers: great-circle distance, cumulative distance and a local ENU projection."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
import pandas as pd

from felinos_telemetry.io.sensorlogger import pivot_sensor

R_EARTH_M = 6_371_008.8
FloatArray = npt.NDArray[np.float64]


def haversine_m(
    lat1: npt.ArrayLike, lon1: npt.ArrayLike, lat2: npt.ArrayLike, lon2: npt.ArrayLike
) -> FloatArray:
    """Great-circle distance in metres (vectorized)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dlat = p2 - p1
    dlon = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dlat / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlon / 2) ** 2
    return np.asarray(2 * R_EARTH_M * np.arcsin(np.minimum(1.0, np.sqrt(a))), dtype=np.float64)


def to_enu(lat: npt.ArrayLike, lon: npt.ArrayLike) -> tuple[FloatArray, FloatArray]:
    """Project to a local east/north plane (m) around the first point. Fine for a few km."""
    lat_a = np.asarray(lat, dtype=np.float64)
    lon_a = np.asarray(lon, dtype=np.float64)
    lat0, lon0 = lat_a[0], lon_a[0]
    east = np.radians(lon_a - lon0) * R_EARTH_M * np.cos(np.radians(lat0))
    north = np.radians(lat_a - lat0) * R_EARTH_M
    return east, north


def gps_track(long: pd.DataFrame) -> pd.DataFrame:
    """GPS fixes as ``t_s, lat, lon, speed_kmh, accuracy_m`` (invalid speeds → NaN)."""
    loc = pivot_sensor(long, "location")
    if loc.empty or "latitude" not in loc:
        return pd.DataFrame(columns=["time_ns", "t_s", "lat", "lon", "speed_kmh", "accuracy_m"])
    speed = loc["speed"] if "speed" in loc else pd.Series(np.nan, index=loc.index)
    acc = loc.get("horizontalAccuracy", np.nan)
    return pd.DataFrame(
        {
            "time_ns": loc["time_ns"].astype("int64"),
            "t_s": loc["time_ns"].astype("int64") / 1e9,
            "lat": loc["latitude"].astype(float),
            "lon": loc["longitude"].astype(float),
            "speed_kmh": speed.where(speed >= 0) * 3.6,
            "accuracy_m": acc,
        }
    ).reset_index(drop=True)
