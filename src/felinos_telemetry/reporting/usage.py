"""Accumulated usage across runs (VG-02 durability ledger).

Reads every ``results/summary.json`` under a data folder and totals the three ways of counting
vehicle life: active hours, distance and damage-equivalent hours (plus impacts by severity).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class UsageRow:
    run_dir: str
    date: str | None
    run_id: str | None
    test_type: str
    active_h: float
    distance_km: float
    impacts: int
    jumps: int
    damage: float | None  # pseudo-damage, first Wöhler exponent
    equivalent_h: float | None


@dataclass
class UsageTotals:
    runs: int = 0
    active_h: float = 0.0
    distance_km: float = 0.0
    impacts: int = 0
    jumps: int = 0
    damage: float = 0.0
    equivalent_h: float | None = None
    rows: list[UsageRow] = field(default_factory=list)

    def progress(self, target_h: float) -> float:
        return self.active_h / target_h if target_h else 0.0


def _first(d: dict[str, Any]) -> Any:
    return next(iter(d.values())) if d else None


def collect(data_dir: Path) -> UsageTotals:
    totals = UsageTotals()
    eq_known = True
    for path in sorted(data_dir.rglob("results/summary.json")):
        s = json.loads(path.read_text(encoding="utf-8"))
        run, u, ev, d = s["run"], s["usage"], s["events"]["counts"], s["durability"]
        row = UsageRow(
            run_dir=str(path.parent.parent.relative_to(data_dir)),
            date=run.get("date"),
            run_id=run.get("run_id"),
            test_type=run.get("test_type", "free"),
            active_h=float(u.get("active_h") or 0.0),
            distance_km=float(u.get("distance_km") or 0.0),
            impacts=int(ev.get("impact", 0)),
            jumps=int(ev.get("jump", 0)),
            damage=_first(d.get("pseudo_damage") or {}),
            equivalent_h=d.get("equivalent_hours"),
        )
        totals.rows.append(row)
        totals.runs += 1
        totals.active_h += row.active_h
        totals.distance_km += row.distance_km
        totals.impacts += row.impacts
        totals.jumps += row.jumps
        totals.damage += row.damage or 0.0
        if row.equivalent_h is None:
            eq_known = False
        else:
            totals.equivalent_h = (totals.equivalent_h or 0.0) + row.equivalent_h
    if not eq_known:
        totals.equivalent_h = None  # partial sums would understate the life consumed
    return totals
