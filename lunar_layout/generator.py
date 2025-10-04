"""Initial feasible layout generator."""

from __future__ import annotations

import json
import math
import random
from pathlib import Path
from typing import Dict

from .constraints import validate_layout
from .models import ConstraintSettings, Layout, Systems, Zone

DEFAULT_USABLE = {
    "Airlock": 0.6,
    "Work": 0.85,
    "HygieneMedical": 0.8,
    "GalleyDining": 0.85,
    "CrewQuarters": 0.9,
    "Exercise": 0.8,
    "MaintenanceStorage": 0.75,
    "StormShelter": 0.7,
    "Agriculture": 0.85,
}

BASE_VOLUME_FRACTIONS = {
    "Airlock": 0.07,
    "Work": 0.18,
    "HygieneMedical": 0.09,
    "GalleyDining": 0.11,
    "CrewQuarters": 0.20,
    "Exercise": 0.1,
    "MaintenanceStorage": 0.1,
    "StormShelter": 0.07,
    "Agriculture": 0.08,
}

PRIVACY_DEFAULT = {
    "Airlock": "Low",
    "Work": "Medium",
    "HygieneMedical": "High",
    "GalleyDining": "Medium",
    "CrewQuarters": "High",
    "Exercise": "Medium",
    "MaintenanceStorage": "Low",
    "StormShelter": "High",
    "Agriculture": "Medium",
}

ACOUSTIC_DEFAULT = {
    "Airlock": 0.4,
    "Work": 0.55,
    "HygieneMedical": 0.75,
    "GalleyDining": 0.6,
    "CrewQuarters": 0.8,
    "Exercise": 0.65,
    "MaintenanceStorage": 0.5,
    "StormShelter": 0.85,
    "Agriculture": 0.6,
}

CONNECTIONS = {
    "Airlock": ["MaintenanceStorage", "Work"],
    "MaintenanceStorage": ["Airlock", "Work", "StormShelter", "Agriculture"],
    "Work": ["Airlock", "GalleyDining", "Exercise", "MaintenanceStorage"],
    "GalleyDining": ["Work", "CrewQuarters", "Agriculture"],
    "CrewQuarters": ["GalleyDining", "HygieneMedical", "Exercise"],
    "HygieneMedical": ["CrewQuarters", "StormShelter"],
    "Exercise": ["CrewQuarters", "Work"],
    "StormShelter": ["HygieneMedical", "MaintenanceStorage"],
    "Agriculture": ["GalleyDining", "MaintenanceStorage"],
}

EQUIPMENT = {
    "Airlock": ["dual-door", "suit-lock", "dust-scrubber"],
    "Work": ["lab-bench", "fab-station"],
    "HygieneMedical": ["med-kit", "hygiene-module"],
    "GalleyDining": ["galley", "table"],
    "CrewQuarters": ["pods", "privacy-panels"],
    "Exercise": ["treadmill", "flywheel"],
    "MaintenanceStorage": ["tool-racks", "spares"],
    "StormShelter": ["shielded-bunks", "backup-comms"],
    "Agriculture": ["hydroponics", "algae"],
}


def _load_config(config_path: Path | str | None) -> Dict[str, object]:
    if config_path is None:
        return {}
    path = Path(config_path)
    data = json.loads(path.read_text())
    return data


def _scale_volumes(pressurized_volume: float, fractions: Dict[str, float]) -> Dict[str, float]:
    total_fraction = sum(fractions.values())
    return {name: pressurized_volume * frac / total_fraction for name, frac in fractions.items()}


def generate_initial_layout(
    config: Dict[str, object] | None = None,
    settings: ConstraintSettings | None = None,
) -> Layout:
    """Generate a feasible baseline layout from configuration parameters."""

    settings = settings or ConstraintSettings()
    config = config or {}
    crew = int(config.get("crew", 4))
    duration = int(config.get("duration_days", 90))
    habitat_type = str(config.get("habitat_type", "Inflatable"))
    pressurized = float(config.get("pressurized_volume_m3", 160.0))
    isru_target = float(config.get("target_isru_ratio", 0.6))
    docking_ports = int(config.get("docking_ports", 2))
    seed = int(config.get("seed", 42))

    if crew < settings.min_crew or crew > settings.max_crew:
        raise ValueError("Config crew outside supported range")

    rng = random.Random(seed)
    volumes = _scale_volumes(pressurized, BASE_VOLUME_FRACTIONS)

    zones = []
    for name in BASE_VOLUME_FRACTIONS:
        usable = DEFAULT_USABLE.get(name, 0.8)
        privacy = PRIVACY_DEFAULT.get(name, "Medium")
        acoustic = ACOUSTIC_DEFAULT.get(name, 0.6)
        equip = EQUIPMENT.get(name, [])
        is_pressurized = name != "MaintenanceStorage" or True
        is_egress = name in {"Airlock", "StormShelter"}
        volume = volumes[name]
        # adjust for crew count (scale quarters and galley, hygiene)
        if name in {"CrewQuarters", "GalleyDining", "HygieneMedical", "Exercise", "Agriculture"}:
            scale = max(1.0, crew / 4.0)
            volume *= scale
        zone = Zone(
            name=name,
            volume_m3=volume,
            usable_ratio=usable,
            privacy=privacy,
            connections=CONNECTIONS.get(name, []),
            acoustic_isolation=acoustic,
            lighting="Adaptive" if name in {"CrewQuarters", "GalleyDining"} else "Neutral4000K",
            is_pressurized=is_pressurized,
            is_egress=is_egress,
            equipment=equip,
        )
        zones.append(zone)

    # Optional randomness: tweak volumes slightly while keeping sum constant
    for zone in zones:
        jitter = rng.uniform(-0.05, 0.05)
        zone.volume_m3 *= 1 + jitter
        zone.volume_m3 = max(zone.volume_m3, 5.0)

    total_pressurized = sum(z.volume_m3 for z in zones)
    scaling = pressurized / total_pressurized if total_pressurized else 1.0
    for zone in zones:
        zone.volume_m3 *= scaling

    systems = Systems(
        eclss_redundancy_loops=2,
        water_recycling_rate=0.92,
        power={
            "source": "Solar+Battery",
            "autonomy_days": max(settings.min_power_autonomy_days, 14),
            "storage_kwh": 160.0,
        },
        thermal={"control": "heat-pump", "range_c": [-173, 127]},
        comms={"local": True, "gateway": "HALO-link"},
        dust_mitigation={"dual_door": True, "suit_storage": True, "electrostatic": True},
    )

    layout = Layout(
        habitat_name=config.get("habitat_name", "Helios-Init"),
        habitat_type=habitat_type,  # type: ignore[arg-type]
        pressurized_volume_m3=pressurized,
        zones=zones,
        systems=systems,
        shield_equivalent_g_cm2=max(5.5, 5.0 + 0.2 * crew),
        isru_ratio=min(1.0, max(0.5, isru_target)),
        docking_ports=docking_ports,
        metadata={"crew": crew, "duration_days": duration, "seed": seed},
    )

    result = validate_layout(layout, settings)
    if not result.passed:
        # Attempt to resolve NHV shortfall by expanding quarters and galley proportionally
        deficit_rules = set(result.failed_rules)
        if {"nhv_per_crew", "nhv_efficiency"} & deficit_rules:
            needed_nhv = crew * settings.min_nhv_per_person
            current_nhv = sum(z.volume_m3 * z.usable_ratio for z in layout.zones)
            boost_ratio = math.sqrt(needed_nhv / current_nhv) if current_nhv else 1.1
            for zone in layout.zones:
                if zone.name in {"CrewQuarters", "GalleyDining", "HygieneMedical", "StormShelter"}:
                    zone.volume_m3 *= boost_ratio
            layout.pressurized_volume_m3 = sum(z.volume_m3 for z in layout.zones)
            result = validate_layout(layout, settings)

    if not result.passed:
        raise ValueError(f"Initial layout generation failed: {result.failed_rules}")

    return layout


def generate_from_file(config_path: Path | str, settings: ConstraintSettings | None = None) -> Layout:
    config = _load_config(config_path)
    return generate_initial_layout(config, settings)
