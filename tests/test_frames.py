from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from felinos_telemetry.io.sensorlogger import read_export
from felinos_telemetry.models import AxisMap
from felinos_telemetry.processing.frames import G0, frame_from_gravity, vehicle_signals
from felinos_telemetry.processing.gps import gps_track, haversine_m, to_enu

FLAT = AxisMap(x="lateral", y="longitudinal", z="vertical")


def _long(sensor: str, t: np.ndarray, xyz: np.ndarray) -> pd.DataFrame:
    rows = []
    for k, f in enumerate("xyz"):
        rows.append(pd.DataFrame({"time_ns": t, "sensor": sensor, "field": f, "value": xyz[:, k]}))
    return pd.concat(rows, ignore_index=True)


def _synthetic(
    gravity: tuple[float, float, float], accel: tuple[float, float, float], n: int = 1000
) -> pd.DataFrame:
    t = (1e18 + np.arange(n) * 1e7).astype("int64")
    g = np.tile(gravity, (n, 1)).astype(float)
    a = np.zeros((n, 3))
    a[600:] = accel  # first 6 s at rest (level reference), then constant acceleration
    gyro = np.zeros((n, 3))
    gyro[600:, 2] = np.radians(10)
    return pd.concat(
        [_long("gravity", t, g), _long("accelerometer", t, a), _long("gyroscope", t, gyro)],
        ignore_index=True,
    )


@pytest.mark.parametrize(
    ("label", "gravity", "accel"),
    [
        ("android", (0, 0, G0), (0, 0.5 * G0, 0)),
        ("ios-raw", (0, 0, -1), (0, -0.5, 0)),  # gravity down, opposite sign, units in g
    ],
)
def test_platform_conventions_give_the_same_vehicle_signals(
    label: str, gravity: tuple[float, float, float], accel: tuple[float, float, float]
) -> None:
    sig, frame = vehicle_signals(_synthetic(gravity, accel), FLAT)
    moving = sig.iloc[700:]
    assert moving["a_long"].mean() == pytest.approx(0.5, abs=1e-9), label
    assert moving["a_lat"].abs().max() < 1e-9
    assert moving["yaw_rate"].mean() == pytest.approx(10, abs=1e-9)
    at_rest = sig.iloc[:600]["sf"].mean()  # |specific force| at rest = 1 g
    assert at_rest == pytest.approx(1.0, abs=1e-9)
    assert frame.accel_sign == (1 if label == "android" else -1)


def test_tilted_mount_is_removed() -> None:
    th = np.radians(30)
    gravity = (0, np.sin(th) * G0, np.cos(th) * G0)
    frame = frame_from_gravity(np.array(gravity), FLAT)
    a_phone = np.array([0, 3 * np.cos(th), -3 * np.sin(th)])  # horizontal forward 3 m/s²
    assert a_phone @ frame.f == pytest.approx(3)
    assert a_phone @ frame.u == pytest.approx(0, abs=1e-12)


def test_real_export_produces_finite_signals(export_dir: Path) -> None:
    long = read_export(export_dir)
    sig, frame = vehicle_signals(long, AxisMap(x="lateral", y="vertical", z="longitudinal"))
    assert len(sig) == 5978
    assert np.isfinite(sig[["a_long", "a_lat", "a_vert", "sf", "yaw_rate", "pitch"]]).all().all()
    assert frame.unit_scale == 1.0  # Android export in m/s²
    assert sig["sf"].median() == pytest.approx(1.0, abs=0.1)
    gps = gps_track(long)
    assert len(gps) == 22
    assert gps["speed_kmh"].max() == pytest.approx(26.5, abs=0.1)


def test_gps_helpers() -> None:
    assert float(haversine_m(21, -101.7, 21 + 1 / 60, -101.7)) == pytest.approx(1853.2, abs=1)
    e, n = to_enu([21.0, 21.001], [-101.7, -101.7])
    assert e[1] == pytest.approx(0, abs=1e-6)
    assert n[1] == pytest.approx(111.2, abs=0.1)
    assert gps_track(pd.DataFrame(columns=["time_ns", "sensor", "field", "value"])).empty


def test_requires_accelerometer_and_gravity() -> None:
    with pytest.raises(ValueError, match="required"):
        vehicle_signals(pd.DataFrame(columns=["time_ns", "sensor", "field", "value"]), FLAT)
