"""Streaming run analysis: the same algorithms as the live dashboard (``dashboard/analysis.js``).

Running exactly the same logic offline over the phone's full recording means the dashboard's
live estimates and the official results only differ by the data they saw (stream gaps), not by
method. Thresholds come from ``config/analysis.yaml``.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from felinos_telemetry.models import AnalysisConfig
from felinos_telemetry.processing.gps import haversine_m

G0 = 9.80665


def _at(xs: list[float | None], i: int) -> float | None:
    return xs[i] if i < len(xs) else None


@dataclass
class Event:
    type: str  # impact | jump | hardBrake | hardCorner
    t: float  # s (epoch)
    peak: float | None = None  # g
    airtime: float | None = None  # s
    bin: int | None = None  # impact severity bin


@dataclass
class Attempt:
    """Standing-start launch: times to 100 ft and 150 ft (IMU+GPS and GPS-only)."""

    t: float
    t100: float | None
    t150: float | None
    gps100: float | None
    gps150: float | None
    max_speed_kmh: float
    mean_grade_deg: float | None


@dataclass
class Turn:
    t: float
    r_cg_m: float
    speed_kmh: float
    direction: str  # left | right


@dataclass
class _Launch:
    t0: float
    bias: float
    v: float
    d: float
    times: list[float | None]
    gps_times: list[float | None]
    gps_d: float = 0.0
    gps_last: tuple[float, float] = (0.0, 0.0)
    max_speed_kmh: float = 0.0
    grades: list[float] = field(default_factory=list)


class StreamAnalyzer:
    def __init__(self, config: AnalysisConfig | None = None) -> None:
        self.cfg = config or AnalysisConfig()
        self.active_gps_s = 0.0
        self.active_imu_s = 0.0
        self._acc_ms = 0.0
        self.distance_m = 0.0
        self._last_gps: tuple[float, float | None, float, float] | None = None
        self.counts = {"impact": 0, "jump": 0, "hardBrake": 0, "hardCorner": 0}
        self.impact_bins = [0] * len(self.cfg.events.impact_severity_g)
        self.events: list[Event] = []
        self._impact: list[float] | None = None  # [t, peak]
        self._last_impact_end = -math.inf
        self._air_start: float | None = None
        self._brake: dict[str, Any] | None = None
        self._corner: dict[str, Any] | None = None
        self._long_s = 0.0
        self._lat_s = 0.0
        self._last_imu_t: float | None = None
        self._rest_start: float | None = None
        self._rest_sum = 0.0
        self._rest_n = 0
        self._exceed_start: float | None = None
        self._pre = (0.0, 0.0)
        self._launch: _Launch | None = None
        self.attempts: list[Attempt] = []
        self._yaw_win: list[tuple[float, float]] = []
        self._gps_win: list[tuple[float, float]] = []
        self._turn_seg: dict[str, Any] | None = None
        self._turn_dir = 0.0
        self.turns: list[Turn] = []
        self._next_turn_eval = 0.0

    # ---- GPS ----------------------------------------------------------------------------

    def gps(self, t: float, speed_kmh: float | None, lat: float, lon: float) -> None:
        u = self.cfg.usage
        prev = self._last_gps
        if prev is not None and speed_kmh is not None:
            dt = t - prev[0]
            if 0 < dt <= u.max_gap_s and speed_kmh >= u.active_speed_kmh:
                self.active_gps_s += dt
                self.distance_m += float(haversine_m(prev[2], prev[3], lat, lon))
        self._last_gps = (t, speed_kmh, lat, lon)
        if speed_kmh is not None:
            self._gps_win.append((t, speed_kmh))
        self._trim(t)
        if self._launch is not None and speed_kmh is not None:
            self._launch_gps(t, speed_kmh)

    @property
    def active_s(self) -> float:
        return self.active_gps_s + self.active_imu_s

    def _imu_activity(self, t: float, dt: float, long: float, lat: float, vert: float) -> None:
        """Without a recent GPS fix, count active time from vibration (1 s RMS of |a|)."""
        u = self.cfg.usage
        w = dt / (u.imu_window_s + dt) if dt > 0 else 1.0
        self._acc_ms += w * (long**2 + lat**2 + vert**2 - self._acc_ms)
        covered = self._last_gps is not None and t - self._last_gps[0] <= u.max_gap_s
        if not covered and dt > 0 and math.sqrt(self._acc_ms) > u.imu_activity_g:
            self.active_imu_s += dt

    def _speed_now(self, t: float) -> float | None:
        g = self._last_gps
        return g[1] if g is not None and g[1] is not None and t - g[0] <= 2.5 else None

    # ---- IMU ----------------------------------------------------------------------------

    def imu(
        self, t: float, long: float, lat: float, vert: float, sf: float, yaw: float, grade: float
    ) -> None:
        dt = 0.0 if self._last_imu_t is None else max(0.0, min(0.1, t - self._last_imu_t))
        self._last_imu_t = t
        e = self.cfg.events
        alpha = dt / (e.smooth_s + dt) if dt > 0 else 1.0
        self._long_s += alpha * (long - self._long_s)
        self._lat_s += alpha * (lat - self._lat_s)
        self._imu_activity(t, dt, long, lat, vert)
        self._detect_impact(t, abs(vert))
        self._detect_jump(t, sf)
        self._brake = self._sustained(
            t, self._brake, -self._long_s > e.hard_brake_g, -self._long_s,
            e.hard_brake_min_s, "hardBrake",
        )  # fmt: skip
        self._corner = self._sustained(
            t, self._corner, abs(self._lat_s) > e.hard_corner_g, abs(self._lat_s),
            e.hard_corner_min_s, "hardCorner",
        )  # fmt: skip
        self._launch_imu(t, dt, long, grade)
        self._turn_imu(t, yaw)

    def _record(self, ev: Event) -> None:
        self.counts[ev.type] += 1
        self.events.append(ev)

    def _detect_impact(self, t: float, v: float) -> None:
        e = self.cfg.events
        if v > e.impact_g:
            if self._impact is not None:
                self._impact[1] = max(self._impact[1], v)
            elif t - self._last_impact_end >= e.impact_refractory_s:
                self._impact = [t, v]
        elif self._impact is not None:
            t0, peak = self._impact
            b = 0
            for i, edge in enumerate(e.impact_severity_g):
                if peak >= edge:
                    b = i
            self.impact_bins[b] += 1
            self._record(Event("impact", t0, peak=peak, bin=b))
            self._impact = None
            self._last_impact_end = t

    def _detect_jump(self, t: float, sf: float) -> None:
        e = self.cfg.events
        if sf < e.freefall_g:
            if self._air_start is None:
                self._air_start = t
        elif self._air_start is not None:
            airtime = t - self._air_start
            if airtime >= e.jump_min_airtime_s:
                self._record(Event("jump", self._air_start, airtime=airtime))
            self._air_start = None

    def _sustained(
        self,
        t: float,
        state: dict[str, Any] | None,
        active: bool,
        value: float,
        min_s: float,
        kind: str,
    ) -> dict[str, Any] | None:
        if not active:
            return None
        if state is None:
            return {"t": t, "peak": value, "counted": False}
        state["peak"] = max(state["peak"], value)
        if not state["counted"] and t - state["t"] >= min_s:
            state["counted"] = True
            self._record(Event(kind, state["t"], peak=state["peak"]))
        return state

    # ---- launches (VG-04 / VG-06) -------------------------------------------------------

    def _launch_imu(self, t: float, dt: float, long: float, grade: float) -> None:
        c = self.cfg.acceleration
        launch = self._launch
        if launch is not None:
            launch.v = max(0.0, launch.v + (long - launch.bias) * G0 * dt)
            before = launch.d
            launch.d += launch.v * dt
            launch.grades.append(grade)
            for i, target in enumerate(c.distances_m):
                if launch.times[i] is None and launch.d >= target:
                    frac = (target - before) / (launch.d - before) if launch.d > before else 1.0
                    launch.times[i] = t - dt + frac * dt - launch.t0
            elapsed = t - launch.t0
            done = all(x is not None for x in launch.times)
            if done or (elapsed > 2 and launch.v < 0.5) or elapsed > c.timeout_s:
                self._finish_launch()
            return
        speed = self._speed_now(t)
        at_rest = speed is not None and speed < c.rest_speed_kmh
        if at_rest:
            if self._rest_start is None:
                self._rest_start, self._rest_sum, self._rest_n = t, 0.0, 0
            self._rest_sum += long
            self._rest_n += 1
        elif self._rest_start is not None:
            short_stop = t - self._rest_start < c.rest_min_s
            rolling = speed is not None and speed > c.rest_speed_kmh + 5
            if short_stop or rolling:
                self._rest_start = None
        armed = (
            self._rest_start is not None and t - self._rest_start >= c.rest_min_s and self._rest_n
        )
        if not armed:
            self._exceed_start = None
            return
        bias = self._rest_sum / self._rest_n
        if long - bias > c.launch_g:
            if self._exceed_start is None:
                self._exceed_start, self._pre = t, (0.0, 0.0)
            else:
                v = self._pre[0] + (long - bias) * G0 * dt
                self._pre = (v, self._pre[1] + v * dt)
            if t - self._exceed_start >= c.launch_min_s:
                n = len(c.distances_m)
                self._launch = _Launch(
                    t0=self._exceed_start,
                    bias=bias,
                    v=self._pre[0],
                    d=self._pre[1],
                    times=[None] * n,
                    gps_times=[None] * n,
                    gps_last=(self._exceed_start, 0.0),
                )
                self._rest_start = None
                self._exceed_start = None
        else:
            self._exceed_start = None

    def _launch_gps(self, t: float, speed_kmh: float) -> None:
        c = self.cfg.acceleration
        launch = self._launch
        assert launch is not None
        v = speed_kmh / 3.6
        launch.max_speed_kmh = max(launch.max_speed_kmh, speed_kmh)
        launch.v += c.gps_blend * (v - launch.v)
        t_last, v_last = launch.gps_last
        dt = t - t_last
        if dt > 0:
            before = launch.gps_d
            launch.gps_d += (v_last + v) / 2 * dt
            for i, target in enumerate(c.distances_m):
                if launch.gps_times[i] is None and launch.gps_d >= target:
                    frac = (target - before) / (launch.gps_d - before)
                    launch.gps_times[i] = t_last + frac * dt - launch.t0
        launch.gps_last = (t, v)

    def _finish_launch(self) -> None:
        launch = self._launch
        self._launch = None
        if launch is None or launch.times[0] is None:
            return
        self.attempts.append(
            Attempt(
                t=launch.t0,
                t100=launch.times[0],
                t150=_at(launch.times, 1),
                gps100=launch.gps_times[0],
                gps150=_at(launch.gps_times, 1),
                max_speed_kmh=launch.max_speed_kmh,
                mean_grade_deg=statistics.fmean(launch.grades) if launch.grades else None,
            )
        )

    # ---- steady turns (VG-05) -----------------------------------------------------------

    def _trim(self, t: float) -> None:
        w = self.cfg.turning.window_s
        while self._yaw_win and self._yaw_win[0][0] < t - w:
            self._yaw_win.pop(0)
        while self._gps_win and self._gps_win[0][0] < t - w - 1:
            self._gps_win.pop(0)

    def _turn_imu(self, t: float, yaw: float) -> None:
        c = self.cfg.turning
        self._yaw_win.append((t, yaw))
        self._trim(t)
        if t < self._next_turn_eval:
            return
        self._next_turn_eval = t + 0.25
        span = t - self._yaw_win[0][0] if self._yaw_win else 0.0
        steady, r, speed = False, None, None
        if span >= c.window_s * 0.9 and len(self._gps_win) >= 2:
            ys = [y for _, y in self._yaw_win]
            m = statistics.fmean(ys)
            speeds = [s for _, s in self._gps_win]
            speed = statistics.fmean(speeds)
            steady = (
                abs(m) >= c.min_yaw_deg_s
                and statistics.pstdev(ys) / abs(m) <= c.max_yaw_cv
                and c.speed_kmh[0] <= speed <= c.speed_kmh[1]
                and statistics.pstdev(speeds) / speed <= c.max_speed_cv
            )
            if steady:
                r = (speed / 3.6) / math.radians(abs(m))
                self._turn_dir = math.copysign(1.0, m)
        if steady:
            if self._turn_seg is None:
                self._turn_seg = {"t": t - span, "rs": [], "speeds": []}
            self._turn_seg["rs"].append(r)
            self._turn_seg["speeds"].append(speed)
        elif self._turn_seg is not None:
            seg, self._turn_seg = self._turn_seg, None
            self.turns.append(
                Turn(
                    t=seg["t"],
                    r_cg_m=statistics.median(seg["rs"]),
                    speed_kmh=statistics.fmean(seg["speeds"]),
                    direction="left" if self._turn_dir > 0 else "right",
                )
            )

    def flush(self) -> None:
        if self._launch is not None:
            self._finish_launch()
        if self._turn_seg is not None:
            self._turn_imu(math.inf, 0.0)


def run_stream(
    signals: pd.DataFrame, gps: pd.DataFrame, config: AnalysisConfig | None = None
) -> StreamAnalyzer:
    """Feed vehicle-frame IMU signals and GPS fixes in time order, like the live stream."""
    an = StreamAnalyzer(config)
    g_t = gps["t_s"].to_numpy(dtype=float) if not gps.empty else np.array([])
    g_speed = gps["speed_kmh"].to_numpy(dtype=float) if not gps.empty else np.array([])
    g_lat = gps["lat"].to_numpy(dtype=float) if not gps.empty else np.array([])
    g_lon = gps["lon"].to_numpy(dtype=float) if not gps.empty else np.array([])
    cols = ["t_s", "a_long", "a_lat", "a_vert", "sf", "yaw_rate", "pitch"]
    arr = signals[cols].to_numpy(dtype=float)
    j = 0
    for t, lo, la, ve, sf, yaw, pitch in arr:
        while j < len(g_t) and g_t[j] <= t:
            sp = None if math.isnan(g_speed[j]) else float(g_speed[j])
            an.gps(float(g_t[j]), sp, float(g_lat[j]), float(g_lon[j]))
            j += 1
        an.imu(float(t), float(lo), float(la), float(ve), float(sf), float(yaw), float(pitch))
    while j < len(g_t):
        sp = None if math.isnan(g_speed[j]) else float(g_speed[j])
        an.gps(float(g_t[j]), sp, float(g_lat[j]), float(g_lon[j]))
        j += 1
    an.flush()
    return an
