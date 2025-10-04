"""Core data models for lunar habitat layouts."""

from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, validator

ZoneName = Literal[
    "Airlock",
    "Work",
    "HygieneMedical",
    "GalleyDining",
    "CrewQuarters",
    "Exercise",
    "MaintenanceStorage",
    "StormShelter",
    "Agriculture",
]

PrivacyLevel = Literal["Low", "Medium", "High"]
LightingProfile = Literal["Warm3000K", "Neutral4000K", "Cool6500K", "Adaptive"]
HabitatType = Literal["Inflatable", "Rigid", "RegolithHybrid"]


class Zone(BaseModel):
    """Pressurized or support zone inside the habitat."""

    name: ZoneName
    volume_m3: float = Field(..., gt=0)
    usable_ratio: float = Field(..., gt=0, le=1)
    privacy: PrivacyLevel
    connections: List[str] = Field(default_factory=list)
    acoustic_isolation: float = Field(..., ge=0, le=1)
    lighting: LightingProfile
    is_pressurized: bool = True
    is_egress: bool = False
    equipment: List[str] = Field(default_factory=list)

    @validator("connections", each_item=True)
    def _strip_names(cls, value: str) -> str:
        return value.strip()


class Systems(BaseModel):
    """High-level systems summary for the habitat."""

    eclss_redundancy_loops: int = Field(..., ge=1)
    water_recycling_rate: float = Field(..., ge=0, le=1)
    power: Dict[str, object]
    thermal: Dict[str, object]
    comms: Dict[str, object]
    dust_mitigation: Dict[str, object]


class Layout(BaseModel):
    """Complete layout description."""

    habitat_name: str
    habitat_type: HabitatType
    pressurized_volume_m3: float = Field(..., gt=0)
    zones: List[Zone]
    systems: Systems
    shield_equivalent_g_cm2: float = Field(..., ge=0)
    isru_ratio: float = Field(..., ge=0, le=1)
    docking_ports: int = Field(..., ge=0)
    metadata: Dict[str, object]

    @validator("metadata")
    def _validate_metadata(cls, value: Dict[str, object]) -> Dict[str, object]:
        required = {"crew", "duration_days"}
        missing = required - set(value.keys())
        if missing:
            raise ValueError(f"metadata missing required keys: {', '.join(sorted(missing))}")
        return value


class Metrics(BaseModel):
    """Calculated performance metrics for a layout."""

    nhv_m3: float
    nhv_efficiency: float
    transit_distance_score: float
    privacy_score: float
    sustainability_score: float
    energy_use_kwh_per_person_day: float
    safety_redundancy_score: float
    feasibility: bool


class ConstraintSettings(BaseModel):
    """Thresholds used for validation."""

    min_crew: int = 2
    max_crew: int = 4
    min_duration_days: int = 30
    max_duration_days: int = 180
    min_nhv_per_person: float = 25.0
    min_nhv_efficiency: float = 0.70
    min_shield_g_cm2: float = 5.0
    min_eclss_loops: int = 2
    min_water_recycling: float = 0.90
    min_power_autonomy_days: int = 14
    min_privacy_quarters: float = 0.7
    required_zones: List[ZoneName] = Field(
        default_factory=lambda: [
            "Airlock",
            "Work",
            "HygieneMedical",
            "GalleyDining",
            "CrewQuarters",
            "Exercise",
            "MaintenanceStorage",
            "StormShelter",
        ]
    )
    adjacency_pairs: List[List[str]] = Field(
        default_factory=lambda: [
            ["Airlock", "Work"],
            ["CrewQuarters", "HygieneMedical"],
            ["CrewQuarters", "GalleyDining"],
        ]
    )
    max_storm_shelter_hops: int = 3


class ScoreWeights(BaseModel):
    """Weights for the multi-objective score."""

    w_volume_eff: float = 0.20
    w_privacy: float = 0.15
    w_transit: float = 0.15
    w_safety: float = 0.20
    w_sustain: float = 0.15
    w_energy: float = 0.15

    def normalized(self) -> "ScoreWeights":
        total = (
            self.w_volume_eff
            + self.w_privacy
            + self.w_transit
            + self.w_safety
            + self.w_sustain
            + self.w_energy
        )
        if total <= 0:
            raise ValueError("Score weights must sum to more than zero")
        return ScoreWeights(
            w_volume_eff=self.w_volume_eff / total,
            w_privacy=self.w_privacy / total,
            w_transit=self.w_transit / total,
            w_safety=self.w_safety / total,
            w_sustain=self.w_sustain / total,
            w_energy=self.w_energy / total,
        )


class ValidationResult(BaseModel):
    """Result set from running constraint checks."""

    passed: bool
    messages: List[str]
    failed_rules: List[str] = Field(default_factory=list)
    metrics: Optional[Metrics] = None


class OptimizationLogEntry(BaseModel):
    """A single step summary from the optimizer."""

    iteration: int
    score: float
    accepted: bool
    reason: str


class OptimizationResult(BaseModel):
    """Optimizer output bundle."""

    layout: Layout
    metrics: Metrics
    score: float
    history: List[OptimizationLogEntry]
