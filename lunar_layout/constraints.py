"""Hard and soft constraint validators for lunar habitat layouts."""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Tuple

from .models import (
    ConstraintSettings,
    Layout,
    ValidationResult,
)


def _build_adjacency(layout: Layout) -> Dict[str, List[str]]:
    graph: Dict[str, List[str]] = {}
    for zone in layout.zones:
        graph.setdefault(zone.name, [])
        for neighbor in zone.connections:
            if neighbor == zone.name:
                continue
            graph.setdefault(neighbor, [])
            if neighbor not in graph[zone.name]:
                graph[zone.name].append(neighbor)
            if zone.name not in graph[neighbor]:
                graph[neighbor].append(zone.name)
    return graph


def _nhv(layout: Layout) -> float:
    return sum(z.volume_m3 * z.usable_ratio for z in layout.zones if z.is_pressurized)


def _crew(layout: Layout) -> int:
    return int(layout.metadata.get("crew", 0))


def _duration(layout: Layout) -> int:
    return int(layout.metadata.get("duration_days", 0))


def _has_cycle(graph: Dict[str, List[str]]) -> bool:
    visited: Dict[str, str] = {}

    def dfs(node: str, parent: str) -> bool:
        visited[node] = parent
        for nbr in graph.get(node, []):
            if nbr == parent:
                continue
            if nbr in visited:
                return True
            if dfs(nbr, node):
                return True
        return False

    for node in graph:
        if node not in visited:
            if dfs(node, ""):
                return True
    return False


def _storm_distance(graph: Dict[str, List[str]], start: str, target: str) -> int:
    queue: deque[Tuple[str, int]] = deque([(start, 0)])
    seen = {start}
    while queue:
        node, dist = queue.popleft()
        if node == target:
            return dist
        for nbr in graph.get(node, []):
            if nbr not in seen:
                seen.add(nbr)
                queue.append((nbr, dist + 1))
    return -1


def validate_layout(layout: Layout, settings: ConstraintSettings | None = None) -> ValidationResult:
    """Validate a layout against the mission hard constraints."""

    settings = settings or ConstraintSettings()
    messages: List[str] = []
    failed: List[str] = []

    crew = _crew(layout)
    duration = _duration(layout)
    graph = _build_adjacency(layout)
    nhv_value = _nhv(layout)
    nhv_eff = nhv_value / layout.pressurized_volume_m3 if layout.pressurized_volume_m3 else 0.0
    zone_by_name = {zone.name: zone for zone in layout.zones}

    # Crew & duration range
    if not (settings.min_crew <= crew <= settings.max_crew):
        failed.append("crew_range")
        messages.append(
            f"Crew size {crew} outside supported range {settings.min_crew}-{settings.max_crew}."
        )
    else:
        messages.append(f"Crew size {crew} within supported range.")

    if not (settings.min_duration_days <= duration <= settings.max_duration_days):
        failed.append("duration_range")
        messages.append(
            f"Duration {duration} days outside supported range {settings.min_duration_days}-{settings.max_duration_days}."
        )
    else:
        messages.append(f"Mission duration {duration} days within supported range.")

    # Required zones present
    zone_names = {zone.name for zone in layout.zones}
    missing_zones = [z for z in settings.required_zones if z not in zone_names]
    if missing_zones:
        failed.append("required_zones")
        messages.append(f"Missing mandatory zones: {', '.join(missing_zones)}.")
    else:
        messages.append("All mandatory zones present.")

    # NHV per crew
    required_nhv = crew * settings.min_nhv_per_person
    if nhv_value < required_nhv:
        failed.append("nhv_per_crew")
        deficit = required_nhv - nhv_value
        messages.append(
            f"NHV {nhv_value:.1f} m³ below required {required_nhv:.1f} m³ (add {deficit:.1f} m³ usable)."
        )
    else:
        messages.append(f"NHV {nhv_value:.1f} m³ meets per-crew requirement.")

    if nhv_eff < settings.min_nhv_efficiency:
        failed.append("nhv_efficiency")
        messages.append(
            f"NHV efficiency {nhv_eff:.2f} < {settings.min_nhv_efficiency:.2f}; consider more usable volume."
        )
    else:
        messages.append(f"NHV efficiency {nhv_eff:.2f} meets minimum.")

    # Shielding
    if layout.shield_equivalent_g_cm2 < settings.min_shield_g_cm2:
        failed.append("radiation_shield")
        messages.append(
            f"Shielding {layout.shield_equivalent_g_cm2:.1f} g/cm² < {settings.min_shield_g_cm2:.1f} g/cm²."
        )
    else:
        messages.append("Radiation shielding meets requirement.")

    # Systems checks
    systems = layout.systems
    if systems.eclss_redundancy_loops < settings.min_eclss_loops:
        failed.append("eclss_redundancy")
        messages.append(
            "ECLSS redundancy below requirement; need >= 2 full loops."
        )
    else:
        messages.append("ECLSS redundancy satisfied.")

    if systems.water_recycling_rate < settings.min_water_recycling:
        failed.append("water_recycling")
        messages.append(
            f"Water recycling {systems.water_recycling_rate:.2f} < {settings.min_water_recycling:.2f}."
        )
    else:
        messages.append("Water recycling meets specification.")

    autonomy = int(systems.power.get("autonomy_days", 0))
    if autonomy < settings.min_power_autonomy_days:
        failed.append("power_autonomy")
        messages.append(
            f"Power autonomy {autonomy} days < {settings.min_power_autonomy_days} days target."
        )
    else:
        messages.append("Power autonomy meets lunar night requirement.")

    dust_ok = systems.dust_mitigation.get("dual_door") and systems.dust_mitigation.get("suit_storage")
    if not dust_ok:
        failed.append("dust_mitigation")
        messages.append("Dust mitigation must include dual-door vestibule and suit storage.")
    else:
        messages.append("Dust mitigation features verified.")

    # Connectivity
    if not graph:
        failed.append("connectivity")
        messages.append("No connectivity graph defined across zones.")
    else:
        # simple connectivity
        start = next(iter(graph))
        seen = set()
        queue: deque[str] = deque([start])
        while queue:
            node = queue.popleft()
            if node in seen:
                continue
            seen.add(node)
            for nbr in graph.get(node, []):
                if nbr not in seen:
                    queue.append(nbr)
        if len(seen) != len(zone_names):
            failed.append("connectivity")
            messages.append("Zone adjacency graph is disconnected.")
        else:
            messages.append("Zone adjacency graph is connected.")

        if not _has_cycle(graph) and "connectivity" not in failed:
            failed.append("redundant_paths")
            messages.append("Adjacency graph lacks alternate routes; add redundant connections.")
        elif "connectivity" not in failed:
            messages.append("Redundant paths present in adjacency graph.")

    # Adjacency pairs
    for pair in settings.adjacency_pairs:
        a, b = pair
        if a in graph and b in graph.get(a, []):
            continue
        failed.append(f"adjacency_{a}_{b}")
        messages.append(f"Critical adjacency missing between {a} and {b}.")

    # Egress paths
    egress_zones = [z for z in layout.zones if z.is_egress]
    if len(egress_zones) < 2:
        failed.append("egress_paths")
        messages.append("At least two egress-capable zones required (e.g., airlock and shelter exit).")
    else:
        messages.append("Multiple egress-capable zones confirmed.")

    # Storm shelter reachability
    shelter = zone_by_name.get("StormShelter")
    if shelter and graph:
        for zone in layout.zones:
            dist = _storm_distance(graph, zone.name, shelter.name)
            if dist == -1 or dist > settings.max_storm_shelter_hops:
                failed.append("storm_shelter_access")
                messages.append(
                    f"Storm shelter too far from {zone.name} (distance {dist})."
                )
                break
        else:
            messages.append("Storm shelter reachable within required hops.")
    else:
        failed.append("storm_shelter_access")
        messages.append("Storm shelter zone missing or disconnected.")

    # Crew quarters privacy
    quarters = zone_by_name.get("CrewQuarters")
    if not quarters:
        # already captured by required zones but keep message
        messages.append("Crew quarters zone not defined.")
    else:
        if quarters.privacy != "High" or quarters.acoustic_isolation < settings.min_privacy_quarters:
            failed.append("crew_privacy")
            messages.append(
                "Crew quarters must have High privacy and acoustic isolation >= 0.7."
            )
        else:
            messages.append("Crew quarters privacy targets satisfied.")

    # Storm shelter shielding
    if shelter and shelter.usable_ratio * shelter.volume_m3 <= 0:
        messages.append("Storm shelter volume not contributing to NHV (ok if non-habitable).")

    passed = not failed
    return ValidationResult(passed=passed, messages=messages, failed_rules=failed)
