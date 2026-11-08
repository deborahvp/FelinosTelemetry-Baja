"""Same synthetic cases as tests/dashboard/analysis.test.mjs: live and offline must agree."""

import math
from collections.abc import Callable

import numpy as np
import pandas as pd
import pytest

from felinos_telemetry.analysis.stream import G0, StreamAnalyzer, run_stream
from felinos_telemetry.processing.gps import haversine_m

REST = {"long": 0.0, "lat": 0.0, "vert": 0.0, "sf": 1.0, "yaw": 0.0, "grade": 0.0}
GpsFn = Callable[[float], tuple[float | None, float, float]]


def drive(
    an: StreamAnalyzer,
    t0: float,
    t1: float,
    imu: Callable[[float], dict[str, float]],
    gps: GpsFn | None = None,
) -> None:
    for i in range(round(t0 / 0.01), round(t1 / 0.01) + 1):
        t = i * 0.01
        if gps is not None and i % 100 == 0:
            an.gps(t, *gps(t))
        s = imu(t)
        an.imu(t, s["long"], s["lat"], s["vert"], s["sf"], s["yaw"], s["grade"])


def test_usage_active_time_and_distance() -> None:
    an = StreamAnalyzer()
    m_per_deg = float(haversine_m(0, 0, 1, 0))
    drive(
        an,
        0,
        30,
        lambda t: REST,
        lambda t: (
            (0.0, 21.0894, -101.7)
            if t <= 10
            else (18.0, 21.0894 + (t - 10) * 5 / m_per_deg, -101.7)
        ),
    )
    assert an.active_s == pytest.approx(20)
    assert an.distance_m == pytest.approx(100, abs=0.5)


def test_imu_fallback_without_gps() -> None:
    an = StreamAnalyzer()
    drive(
        an,
        0,
        30,
        lambda t: {**REST, "vert": (0.03 if t < 10 else 0.2) * math.sin(t * 60) * math.sqrt(2)},
    )
    assert an.active_imu_s == pytest.approx(20, abs=1.5)
    assert an.active_gps_s == 0
    covered = StreamAnalyzer()
    drive(
        covered,
        0,
        20,
        lambda t: {**REST, "vert": 0.2 * math.sin(t * 60) * math.sqrt(2)},
        lambda t: (20.0, 21.0, -101.0),
    )
    assert covered.active_imu_s == 0


def test_impacts_jump_brake_corner() -> None:
    an = StreamAnalyzer()

    def imu(t: float) -> dict[str, float]:
        if abs(t - 1.0) < 0.015:
            return {**REST, "vert": 2.6}
        if abs(t - 3.0) < 0.015:
            return {**REST, "vert": 4.8}
        if 5 <= t < 5.45:
            return {**REST, "sf": 0.05, "vert": -0.95}
        if 7 <= t < 8:
            return {**REST, "long": -0.7}
        if 9 <= t < 10:
            return {**REST, "lat": 0.65}
        return REST

    drive(an, 0, 11, imu)
    assert an.counts == {"impact": 2, "jump": 1, "hardBrake": 1, "hardCorner": 1}
    assert an.impact_bins == [1, 0, 1]
    jump = next(e for e in an.events if e.type == "jump")
    assert jump.airtime == pytest.approx(0.45, abs=0.02)


def test_vg04_constant_acceleration_matches_analytic_time() -> None:
    an = StreamAnalyzer()
    a = 0.5
    v_max = a * G0 * 5 * 3.6

    def gps(t: float) -> tuple[float | None, float, float]:
        return (0.0 if t < 3 else min(a * G0 * (t - 3) * 3.6, v_max), 21.0, -101.0)

    drive(an, 0, 12, lambda t: {**REST, "long": a if 3 <= t < 8 else 0.0}, gps)
    an.flush()
    assert len(an.attempts) == 1
    att = an.attempts[0]
    assert att.t100 == pytest.approx(math.sqrt(2 * 30.48 / (a * G0)), abs=0.05)
    assert att.t150 == pytest.approx(math.sqrt(2 * 45.72 / (a * G0)), abs=0.05)
    assert att.gps100 == pytest.approx(math.sqrt(2 * 30.48 / (a * G0)), abs=0.15)


def test_vg05_circle_radius() -> None:
    an = StreamAnalyzer()
    v, r = 8.0, 2.5
    yaw = math.degrees((v / 3.6) / r)
    drive(
        an,
        0,
        12,
        lambda t: {**REST, "yaw": yaw if 2 <= t < 10 else 0.0},
        lambda t: (v, 21.0, -101.0),
    )
    an.flush()
    assert len(an.turns) == 1
    assert an.turns[0].r_cg_m == pytest.approx(r, abs=0.01)
    assert an.turns[0].direction == "left"


def test_run_stream_interleaves_gps_and_imu() -> None:
    t = np.arange(0, 12, 0.01)
    signals = pd.DataFrame(
        {
            "t_s": t,
            "a_long": np.where((t >= 3) & (t < 8), 0.5, 0.0),
            "a_lat": 0.0,
            "a_vert": 0.0,
            "sf": 1.0,
            "yaw_rate": 0.0,
            "pitch": 0.0,
        }
    )
    tg = np.arange(0, 13, 1.0)
    gps = pd.DataFrame(
        {
            "t_s": tg,
            "speed_kmh": np.where(tg < 3, 0.0, np.minimum(0.5 * G0 * (tg - 3), 0.5 * G0 * 5) * 3.6),
            "lat": 21.0,
            "lon": -101.0,
        }
    )
    an = run_stream(signals, gps)
    assert len(an.attempts) == 1
    assert an.attempts[0].t100 == pytest.approx(3.526, abs=0.05)
