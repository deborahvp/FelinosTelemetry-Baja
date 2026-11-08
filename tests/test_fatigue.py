import numpy as np
import pytest
import rainflow

from felinos_telemetry.analysis.fatigue import (
    durability,
    histogram,
    pseudo_damage,
    rainflow_cycles,
    turning_points,
)

ASTM_E1049_EXAMPLE = [-2, 1, -3, 5, -1, 3, -4, 4, -2]


def test_astm_e1049_worked_example() -> None:
    # ASTM E1049-85 §5.4.4: ranges 3 (½), 4 (1½), 6 (½), 8 (1), 9 (½)
    assert histogram(rainflow_cycles(ASTM_E1049_EXAMPLE)) == {
        3.0: 0.5,
        4.0: 1.5,
        6.0: 0.5,
        8.0: 1.0,
        9.0: 0.5,
    }


@pytest.mark.parametrize("seed", [0, 1, 2, 3])
def test_matches_reference_library_on_random_signals(seed: int) -> None:
    x = np.random.default_rng(seed).normal(size=2000).cumsum()
    ours = histogram(rainflow_cycles(x), decimals=6)
    ref: dict[float, float] = {}
    for rng, n in rainflow.count_cycles(x):
        ref[round(rng, 6)] = ref.get(round(rng, 6), 0.0) + n
    assert ours == dict(sorted(ref.items()))


def test_turning_points_skip_plateaus_and_monotonic_runs() -> None:
    assert turning_points([0, 1, 2, 2, 1, 1, 3, 0]) == [0, 2, 1, 3, 0]
    assert turning_points([1, 2]) == [1, 2]


def test_constant_amplitude_sine() -> None:
    t = np.linspace(0, 10, 10_001)
    cycles = rainflow_cycles(1.5 * np.sin(2 * np.pi * t))  # 10 cycles of range 3
    full = sum(n for rng, n in cycles if abs(rng - 3) < 1e-3)
    assert full == pytest.approx(10, abs=0.5)


def test_pseudo_damage_and_equivalent_hours() -> None:
    cycles = [(2.0, 1.0), (1.0, 0.5)]
    assert pseudo_damage(cycles, 3) == pytest.approx(8 + 0.5)
    t = np.linspace(0, 10, 10_001)
    sig = np.sin(2 * np.pi * t)  # range 2 → S^3 = 8 per cycle
    res = durability(sig, active_s=1800, m_values=[3.0, 5.0], reference_damage_per_hour=40.0)
    assert res.damage[3.0] == pytest.approx(80, rel=0.05)
    assert res.damage_per_active_hour[3.0] == pytest.approx(160, rel=0.05)
    assert res.equivalent_hours == pytest.approx(2.0, rel=0.05)  # 80 / 40
    assert durability(sig, 0, [3.0]).damage_per_active_hour[3.0] is None
    assert durability(sig, 60, [3.0]).equivalent_hours is None
