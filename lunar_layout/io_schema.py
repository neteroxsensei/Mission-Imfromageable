"""JSON schema helpers for import/export."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from pydantic import BaseModel, ValidationError

from .models import Layout, Metrics, ScoreWeights


class GeneratorConfig(BaseModel):
    crew: int
    duration_days: int
    habitat_type: str
    pressurized_volume_m3: float
    target_isru_ratio: float
    docking_ports: int
    seed: int
    weights: Dict[str, float] | None = None


def layout_schema() -> Dict[str, Any]:
    return Layout.schema()


def metrics_schema() -> Dict[str, Any]:
    return Metrics.schema()


def config_schema() -> Dict[str, Any]:
    return GeneratorConfig.schema()


def load_layout(path: Path | str) -> Layout:
    data = json.loads(Path(path).read_text())
    try:
        return Layout.parse_obj(data)
    except ValidationError as exc:
        raise ValueError(f"Layout file invalid: {exc}") from exc


def save_layout(layout: Layout, path: Path | str) -> None:
    Path(path).write_text(layout.json(indent=2, sort_keys=True))


def load_weights(path: Path | str | None) -> ScoreWeights | None:
    if path is None:
        return None
    data = json.loads(Path(path).read_text())
    return ScoreWeights.parse_obj(data)


def load_config(path: Path | str) -> GeneratorConfig:
    data = json.loads(Path(path).read_text())
    return GeneratorConfig.parse_obj(data)


def export_markdown(layout: Layout, metrics: Metrics, validation_msgs: list[str]) -> str:
    lines: list[str] = []
    crew = layout.metadata.get("crew")
    duration = layout.metadata.get("duration_days")
    lines.append(f"# {layout.habitat_name} Summary")
    lines.append("")
    lines.append(f"- Crew: {crew}")
    lines.append(f"- Duration: {duration} days")
    lines.append(f"- Habitat Type: {layout.habitat_type}")
    lines.append(f"- ISRU Ratio: {layout.isru_ratio:.2f}")
    lines.append(f"- Power Autonomy: {layout.systems.power.get('autonomy_days', 'N/A')} days")
    lines.append("")
    lines.append("## Zones")
    lines.append("| Zone | Volume (m³) | Usable | Privacy | Connections | Equipment |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for zone in layout.zones:
        lines.append(
            f"| {zone.name} | {zone.volume_m3:.1f} | {zone.usable_ratio:.2f} | {zone.privacy} | "
            f"{', '.join(zone.connections)} | {', '.join(zone.equipment)} |"
        )
    lines.append("")
    lines.append("## Systems")
    lines.append(
        f"- ECLSS loops: {layout.systems.eclss_redundancy_loops}\n"
        f"- Water recycling: {layout.systems.water_recycling_rate:.2f}\n"
        f"- Power autonomy days: {layout.systems.power.get('autonomy_days', 'N/A')}\n"
        f"- Shielding: {layout.shield_equivalent_g_cm2:.1f} g/cm²\n"
    )
    lines.append("## Metrics")
    lines.append(
        f"- NHV: {metrics.nhv_m3:.1f} m³\n"
        f"- NHV Efficiency: {metrics.nhv_efficiency:.2f}\n"
        f"- Privacy Score: {metrics.privacy_score:.2f}\n"
        f"- Transit Score: {metrics.transit_distance_score:.2f}\n"
        f"- Sustainability Score: {metrics.sustainability_score:.2f}\n"
        f"- Energy Use (kWh/person-day): {metrics.energy_use_kwh_per_person_day:.2f}\n"
        f"- Safety Score: {metrics.safety_redundancy_score:.2f}\n"
    )
    lines.append("## Validation")
    for msg in validation_msgs:
        prefix = "✅" if msg.lower().startswith("crew") or "meets" in msg.lower() else "⚠️"
        lines.append(f"- {prefix} {msg}")
    return "\n".join(lines)
