"""Constraint-aware optimizer for habitat layouts."""

from __future__ import annotations

import math
import random
from copy import deepcopy
from typing import Callable, List, Tuple

from .constraints import validate_layout
from .models import (
    ConstraintSettings,
    Layout,
    OptimizationLogEntry,
    OptimizationResult,
    ScoreWeights,
)
from .scoring import evaluate

NeighborOp = Callable[[Layout, random.Random], None]


def _copy_layout(layout: Layout) -> Layout:
    return Layout.parse_obj(layout.dict())


def _op_adjust_zone_volume(layout: Layout, rng: random.Random) -> None:
    adjustable = [z for z in layout.zones if z.name not in {"Airlock", "StormShelter"}]
    if len(adjustable) < 2:
        return
    donor, receiver = rng.sample(adjustable, 2)
    transfer = donor.volume_m3 * rng.uniform(0.02, 0.06)
    donor.volume_m3 = max(donor.volume_m3 - transfer, 5.0)
    receiver.volume_m3 += transfer
    layout.pressurized_volume_m3 = sum(z.volume_m3 for z in layout.zones)


def _op_tune_systems(layout: Layout, rng: random.Random) -> None:
    layout.systems.water_recycling_rate = min(
        0.99, max(0.9, layout.systems.water_recycling_rate + rng.uniform(-0.02, 0.03))
    )
    autonomy = int(layout.systems.power.get("autonomy_days", 14))
    autonomy = max(14, autonomy + rng.randint(-1, 2))
    layout.systems.power["autonomy_days"] = autonomy
    storage = float(layout.systems.power.get("storage_kwh", 160.0))
    layout.systems.power["storage_kwh"] = max(120.0, storage + rng.uniform(-10, 15))


def _op_adjust_isru(layout: Layout, rng: random.Random) -> None:
    delta = rng.uniform(-0.05, 0.08)
    layout.isru_ratio = min(1.0, max(0.4, layout.isru_ratio + delta))


def _op_adjust_privacy(layout: Layout, rng: random.Random) -> None:
    targets = [z for z in layout.zones if z.name in {"Work", "Exercise", "GalleyDining"}]
    if not targets:
        return
    zone = rng.choice(targets)
    zone.acoustic_isolation = min(1.0, max(0.3, zone.acoustic_isolation + rng.uniform(-0.05, 0.1)))


NEIGHBOR_OPS: List[NeighborOp] = [
    _op_adjust_zone_volume,
    _op_tune_systems,
    _op_adjust_isru,
    _op_adjust_privacy,
]


def optimize_layout(
    layout: Layout,
    iterations: int = 3000,
    settings: ConstraintSettings | None = None,
    weights: ScoreWeights | None = None,
    seed: int | None = None,
) -> OptimizationResult:
    """Run simulated annealing under hard constraints."""

    rng = random.Random(seed or int(layout.metadata.get("seed", 42)))
    settings = settings or ConstraintSettings()
    weights = weights or ScoreWeights()

    current = _copy_layout(layout)
    current_metrics, current_score = evaluate(current, settings, weights)
    best = _copy_layout(current)
    best_metrics = current_metrics
    best_score = current_score

    history: List[OptimizationLogEntry] = [
        OptimizationLogEntry(iteration=0, score=current_score, accepted=True, reason="initial")
    ]

    temperature_start = 1.0
    temperature_end = 0.05

    for step in range(1, iterations + 1):
        candidate = _copy_layout(current)
        op = rng.choice(NEIGHBOR_OPS)
        op(candidate, rng)

        validation = validate_layout(candidate, settings)
        if not validation.passed:
            history.append(
                OptimizationLogEntry(
                    iteration=step,
                    score=current_score,
                    accepted=False,
                    reason=f"constraint_fail:{','.join(validation.failed_rules)}",
                )
            )
            continue

        candidate_metrics, candidate_score = evaluate(candidate, settings, weights)
        temperature = temperature_start * ((temperature_end / temperature_start) ** (step / iterations))
        delta = candidate_score - current_score
        accept = delta >= 0 or rng.random() < math.exp(delta / max(temperature, 1e-6))

        if accept:
            current = candidate
            current_metrics = candidate_metrics
            current_score = candidate_score
            history.append(
                OptimizationLogEntry(
                    iteration=step,
                    score=current_score,
                    accepted=True,
                    reason=op.__name__,
                )
            )
            if candidate_score > best_score:
                best = _copy_layout(candidate)
                best_metrics = candidate_metrics
                best_score = candidate_score
        else:
            history.append(
                OptimizationLogEntry(
                    iteration=step,
                    score=current_score,
                    accepted=False,
                    reason="anneal_reject",
                )
            )

    return OptimizationResult(layout=best, metrics=best_metrics, score=best_score, history=history)
