"""Metric and scoring utilities."""

from __future__ import annotations

from typing import Dict

from .constraints import validate_layout
from .models import ConstraintSettings, Layout, Metrics, ScoreWeights

PRIVACY_WEIGHTS: Dict[str, float] = {"Low": 0.3, "Medium": 0.6, "High": 1.0}
ACOUSTIC_TARGETS: Dict[str, float] = {
    "CrewQuarters": 0.7,
    "Exercise": 0.6,
    "Work": 0.5,
}


def _transit_score(layout: Layout, settings: ConstraintSettings) -> float:
    graph = {}
    for zone in layout.zones:
        graph.setdefault(zone.name, set())
        for nbr in zone.connections:
            if nbr == zone.name:
                continue
            graph.setdefault(nbr, set())
            graph[zone.name].add(nbr)
            graph[nbr].add(zone.name)
    if not settings.adjacency_pairs:
        return 1.0
    satisfied = 0
    for a, b in settings.adjacency_pairs:
        if b in graph.get(a, set()) or a in graph.get(b, set()):
            satisfied += 1
    return satisfied / len(settings.adjacency_pairs)


def _privacy_score(layout: Layout) -> float:
    if not layout.zones:
        return 0.0
    total = 0.0
    for zone in layout.zones:
        weight = PRIVACY_WEIGHTS.get(zone.privacy, 0.3)
        acoustic_bonus = 0.0
        target = ACOUSTIC_TARGETS.get(zone.name)
        if target is not None:
            acoustic_bonus = min(max(zone.acoustic_isolation - target, 0.0), 0.3)
        total += max(min(weight + acoustic_bonus, 1.0), 0.0)
    return total / len(layout.zones)


def _sustainability_score(layout: Layout, settings: ConstraintSettings) -> float:
    water_factor = min(layout.systems.water_recycling_rate / settings.min_water_recycling, 1.2)
    isru_factor = min(layout.isru_ratio / 0.5, 1.2)
    return min((water_factor + isru_factor) / 2.0, 1.0)


def _energy_per_person_day(layout: Layout) -> float:
    crew = int(layout.metadata.get("crew", 1))
    autonomy_days = int(layout.systems.power.get("autonomy_days", 1))
    storage_kwh = float(layout.systems.power.get("storage_kwh", 120.0))
    if crew <= 0 or autonomy_days <= 0:
        return 10.0
    return storage_kwh / (crew * autonomy_days)


def _safety_score(layout: Layout, settings: ConstraintSettings) -> float:
    loops_factor = min(layout.systems.eclss_redundancy_loops / settings.min_eclss_loops, 1.5)
    egress_count = sum(1 for z in layout.zones if z.is_egress)
    egress_factor = min(egress_count / 2, 1.0)
    shelter = any(z.name == "StormShelter" for z in layout.zones)
    shelter_factor = 1.0 if shelter else 0.0
    return min((loops_factor + egress_factor + shelter_factor) / 3.0, 1.0)


def evaluate(
    layout: Layout,
    constraints: ConstraintSettings | None = None,
    weights: ScoreWeights | None = None,
) -> tuple[Metrics, float]:
    """Compute metrics and weighted score for a layout."""

    settings = constraints or ConstraintSettings()
    weights = (weights or ScoreWeights()).normalized()

    nhv = sum(z.volume_m3 * z.usable_ratio for z in layout.zones if z.is_pressurized)
    nhv_eff = nhv / layout.pressurized_volume_m3 if layout.pressurized_volume_m3 else 0.0
    transit = _transit_score(layout, settings)
    privacy = _privacy_score(layout)
    sustain = _sustainability_score(layout, settings)
    energy = _energy_per_person_day(layout)
    safety = _safety_score(layout, settings)

    feasibility_result = validate_layout(layout, settings)
    feasibility = feasibility_result.passed

    metrics = Metrics(
        nhv_m3=nhv,
        nhv_efficiency=nhv_eff,
        transit_distance_score=transit,
        privacy_score=privacy,
        sustainability_score=sustain,
        energy_use_kwh_per_person_day=energy,
        safety_redundancy_score=safety,
        feasibility=feasibility,
    )

    energy_score = max(0.0, min(2.0 / max(energy, 1e-6), 1.0))
    score = (
        weights.w_volume_eff * min(nhv_eff / settings.min_nhv_efficiency, 1.2)
        + weights.w_privacy * privacy
        + weights.w_transit * transit
        + weights.w_safety * safety
        + weights.w_sustain * sustain
        + weights.w_energy * energy_score
    )
    if not feasibility:
        score *= 0.5
    return metrics, score
