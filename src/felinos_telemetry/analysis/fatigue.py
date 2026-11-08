"""Durability (VG-02): rainflow counting, pseudo-damage and equivalent hours.

- ``rainflow_cycles``: ASTM E1049-85 §5.4.4 rainflow counting (own implementation; tests check
  it against the standard's worked example and against the ``rainflow`` package).
- ``pseudo_damage``: Σ nᵢ·Sᵢᵐ with the cycle range S in g. Relative, for comparing runs,
  configurations, drivers and tracks; it is **not** an absolute component life (that needs FEA
  or strain gauges and an S-N curve).
- ``equivalent_hours``: damage divided by the damage rate of a reference hour (a run on the
  roughest representative track). 1 equivalent hour = as damaging as one reference hour.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from itertools import pairwise

import numpy as np
import numpy.typing as npt


def turning_points(x: npt.ArrayLike) -> list[float]:
    """Peaks and valleys (local extrema), keeping the first and last samples."""
    a = np.asarray(x, dtype=float)
    if a.size < 3:
        return [float(v) for v in a]
    d = np.diff(a)
    keep = [0]
    prev = 0.0
    for i, step in enumerate(d):
        if step == 0:
            continue
        if prev != 0 and np.sign(step) != np.sign(prev):
            keep.append(i)
        prev = step
    keep.append(a.size - 1)
    return [float(a[i]) for i in keep]


def rainflow_cycles(x: npt.ArrayLike) -> list[tuple[float, float]]:
    """Rainflow count → list of ``(range, count)`` with count 1.0 (full) or 0.5 (half)."""
    out: list[tuple[float, float]] = []
    stack: list[float] = []
    for point in turning_points(x):
        stack.append(point)
        while len(stack) >= 3:
            rng_x = abs(stack[-1] - stack[-2])
            rng_y = abs(stack[-2] - stack[-3])
            if rng_x < rng_y:
                break
            if len(stack) == 3:
                out.append((rng_y, 0.5))  # Y contains the starting point: half cycle
                stack.pop(0)
            else:
                out.append((rng_y, 1.0))
                last = stack.pop()
                stack.pop()
                stack.pop()
                stack.append(last)
    out.extend((abs(b - a), 0.5) for a, b in pairwise(stack))
    return out


def histogram(cycles: Iterable[tuple[float, float]], decimals: int = 2) -> dict[float, float]:
    """Cycle counts grouped by rounded range."""
    hist: dict[float, float] = {}
    for rng, n in cycles:
        key = round(rng, decimals)
        hist[key] = hist.get(key, 0.0) + n
    return dict(sorted(hist.items()))


def pseudo_damage(cycles: Iterable[tuple[float, float]], m: float) -> float:
    return float(sum(n * rng**m for rng, n in cycles))


@dataclass(frozen=True)
class DurabilityResult:
    cycles: int  # number of counted (half + full) cycles
    histogram: dict[float, float]
    damage: dict[float, float]  # m → Σ n·S^m
    damage_per_active_hour: dict[float, float | None]
    equivalent_hours: float | None  # needs the reference damage rate (first m)


def durability(
    signal: npt.ArrayLike,
    active_s: float,
    m_values: Sequence[float],
    reference_damage_per_hour: float | None = None,
) -> DurabilityResult:
    cycles = rainflow_cycles(signal)
    damage = {m: pseudo_damage(cycles, m) for m in m_values}
    hours = active_s / 3600
    per_hour = {m: (d / hours if hours > 0 else None) for m, d in damage.items()}
    eq = None
    if reference_damage_per_hour and m_values:
        eq = damage[m_values[0]] / reference_damage_per_hour
    return DurabilityResult(
        cycles=len(cycles),
        histogram=histogram(cycles, decimals=1),
        damage=damage,
        damage_per_active_hour=per_hour,
        equivalent_hours=eq,
    )
