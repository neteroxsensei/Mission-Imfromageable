import csv
import math
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, request, render_template, send_file
from habitat_sim import HabitatRenderer, compute_metrics, enforce_module_bounds
from lunar_layout.generator import generate_initial_layout
from lunar_layout.constraints import validate_layout as ll_validate
from lunar_layout.scoring import evaluate as ll_evaluate
from lunar_layout.optimizer import optimize_layout as ll_optimize
from lunar_layout.io_schema import export_markdown as ll_export_markdown
from lunar_layout.models import Layout as LLLayout, ScoreWeights, ConstraintSettings

# Flask setup
app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static", exist_ok=True)

# Global state
_current_layout = {
    "habitat": {"type": "cylinder", "radius": 4.0, "length": 14.0},
    "modules": [],
    "render_style": "realistic",
    "crew": 4,
    "mission_prompt": "",
}

# Global module ID counter
_module_id_counter = 1

def _get_next_module_id():
    """
    Generate the next module ID starting from 1.
    Ensures IDs are unique and within the range 1-9999.
    """
    global _module_id_counter
    if _module_id_counter > 9999:
        raise ValueError("Maximum module ID reached (9999).")
    module_id = f"{_module_id_counter:04d}"  # Use 4-digit ID
    _module_id_counter += 1
    return module_id
_renderer = None
_renderer_lock = threading.Lock()

# Named colors → RGB
COLOR_MAP = {
    "green": [0.2, 0.8, 0.3],
    "orange": [0.9, 0.6, 0.2],
    "teal": [0.2, 0.85, 0.85],
    "purple": [0.6, 0.3, 0.9],
    "grey": [0.5, 0.5, 0.5],
    "blue": [0.25, 0.55, 0.95],
    "red": [0.95, 0.25, 0.25],
    "yellow": [0.9, 0.9, 0.2]
}

COLOR_KEYS = list(COLOR_MAP.keys())


def _color_for_type(type_name: str) -> str:
    if not COLOR_KEYS:
        return "grey"
    return COLOR_KEYS[abs(hash(type_name)) % len(COLOR_KEYS)]


# --- Requirements dataset ---------------------------------------------------

class RequirementEntry:
    __slots__ = (
        "type_name",
        "function_name",
        "volume_4",
        "volume_6",
        "volume_delta",
        "min_width",
        "min_depth",
        "min_height",
        "type_crit",
        "function_crit",
        "canonical_type",
        "canonical_function",
        "keywords",
    )

    def __init__(
        self,
        type_name: str,
        function_name: str,
        volume_4: float,
        volume_6: float,
        volume_delta: float,
        min_width: Optional[float],
        min_depth: Optional[float],
        min_height: Optional[float],
        type_crit: Optional[int],
        function_crit: Optional[int],
    ) -> None:
        self.type_name = type_name
        self.function_name = function_name
        self.volume_4 = volume_4
        self.volume_6 = volume_6
        self.volume_delta = volume_delta
        self.min_width = min_width
        self.min_depth = min_depth
        self.min_height = min_height
        self.type_crit = type_crit
        self.function_crit = function_crit
        self.canonical_type = _canonical(type_name)
        self.canonical_function = _canonical(function_name)
        keywords = set()
        for token in self.canonical_function.split():
            if token:
                keywords.add(token)
        self.keywords = keywords


def _canonical(text: str) -> str:
    return " ".join(
        filter(
            None,
            "".join(ch.lower() if ch.isalnum() else " " for ch in (text or "")).split()
        )
    )


def _to_float(value: str | None) -> Optional[float]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _to_int(value: str | None) -> Optional[int]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        try:
            return int(float(value))
        except ValueError:
            return None


def _load_requirements(path: Path) -> Tuple[Dict[Tuple[str, str], RequirementEntry], Dict[str, Dict[str, RequirementEntry]]]:
    requirements: Dict[Tuple[str, str], RequirementEntry] = {}
    by_type: Dict[str, Dict[str, RequirementEntry]] = {}

    if not path.exists():
        return requirements, by_type

    with path.open("r", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        current_type: Optional[str] = None
        current_type_crit: Optional[int] = None

        for row in reader:
            raw_type = (row.get("Type") or "").replace("\n", " ").strip()
            if raw_type:
                current_type = raw_type
                current_type_crit = _to_int(row.get("Type criticality")) or current_type_crit
            elif current_type is None:
                continue

            type_name = current_type
            type_crit = _to_int(row.get("Type criticality")) or current_type_crit

            function_name = (row.get("Function") or "").replace("\n", " ").strip()
            if not function_name:
                continue

            volume_4 = _to_float(row.get("VOLUME - 4 CREW\n(m3)")) or 0.0
            volume_6 = _to_float(row.get("VOLUME - 6 CREW\n(m3)")) or max(volume_4, 0.0)
            volume_delta = _to_float(row.get("increase in 2 crew (m^3)")) or 0.0
            min_width = _to_float(row.get("min width (m)"))
            min_depth = _to_float(row.get("min depth (m)"))
            min_height = _to_float(row.get("min height (m)"))
            function_crit = _to_int(row.get("Function criticality"))

            entry = RequirementEntry(
                type_name=type_name,
                function_name=function_name,
                volume_4=volume_4,
                volume_6=volume_6,
                volume_delta=volume_delta,
                min_width=min_width,
                min_depth=min_depth,
                min_height=min_height,
                type_crit=type_crit,
                function_crit=function_crit,
            )

            requirements[(entry.canonical_type, entry.canonical_function)] = entry
            by_type.setdefault(entry.canonical_type, {})[entry.canonical_function] = entry

    return requirements, by_type


REQUIREMENTS_PATH = Path("Requirements.csv")
REQUIREMENT_LOOKUP, REQUIREMENTS_BY_TYPE = _load_requirements(REQUIREMENTS_PATH)


def _required_volume(entry: RequirementEntry, crew_size: int) -> float:
    crew = max(crew_size or 4, 4)
    if crew <= 4:
        return entry.volume_4
    if crew <= 6:
        return entry.volume_6
    # extrapolate using delta per +2 crew beyond 6
    extra_pairs = max((crew - 6 + 1) // 2, 0)
    return entry.volume_6 + extra_pairs * entry.volume_delta


def _list_all_critical_functions() -> List[RequirementEntry]:
    critical = []
    seen: set[Tuple[str, str]] = set()
    for entry in REQUIREMENT_LOOKUP.values():
        if entry.function_crit == 1:
            key = (entry.canonical_type, entry.canonical_function)
            if key not in seen:
                seen.add(key)
                critical.append(entry)
    return critical


BASE_CRITICAL_FUNCTIONS = _list_all_critical_functions()


def _find_requirement(type_name: Optional[str], function_name: Optional[str]) -> Optional[RequirementEntry]:
    if function_name:
        key = (_canonical(type_name or ""), _canonical(function_name))
        entry = REQUIREMENT_LOOKUP.get(key)
        if entry:
            return entry
    if type_name:
        candidates = REQUIREMENTS_BY_TYPE.get(_canonical(type_name))
        if candidates and len(candidates) == 1:
            return next(iter(candidates.values()))
    return None


def _detect_functions_in_prompt(prompt: str) -> List[RequirementEntry]:
    if not prompt:
        return []
    tokens = set(_canonical(prompt).split())
    matched: Dict[Tuple[str, str], RequirementEntry] = {}
    for entry in REQUIREMENT_LOOKUP.values():
        if entry.keywords and entry.keywords.issubset(tokens):
            matched[(entry.canonical_type, entry.canonical_function)] = entry
        else:
            # partial match: any keyword present
            if any(token in tokens for token in entry.keywords):
                matched[(entry.canonical_type, entry.canonical_function)] = entry
    return list(matched.values())


def _required_function_set(crew: int, prompt: str = "") -> Dict[Tuple[str, str], RequirementEntry]:
    required: Dict[Tuple[str, str], RequirementEntry] = {}
    for entry in BASE_CRITICAL_FUNCTIONS:
        required[(entry.canonical_type, entry.canonical_function)] = entry

    for entry in _detect_functions_in_prompt(prompt):
        required[(entry.canonical_type, entry.canonical_function)] = entry

    return required


def _module_function_key(module: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    type_name = _canonical(module.get("kind") or module.get("type") or "")
    function_name = module.get("function") or module.get("functionality") or module.get("id")
    if function_name:
        key = (_canonical(module.get("category") or module.get("kind") or module.get("type") or ""), _canonical(function_name))
        if key in REQUIREMENT_LOOKUP:
            return key
    if type_name and type_name in REQUIREMENTS_BY_TYPE and len(REQUIREMENTS_BY_TYPE[type_name]) == 1:
        function_only = next(iter(REQUIREMENTS_BY_TYPE[type_name].keys()))
        return (type_name, function_only)
    if type_name in REQUIREMENTS_BY_TYPE:
        functions = REQUIREMENTS_BY_TYPE[type_name]
        search_space = [module.get("function"), module.get("id"), module.get("kind"), module.get("type")]
        for candidate in search_space:
            cand_norm = _canonical(candidate or "")
            if cand_norm and cand_norm in functions:
                return (type_name, cand_norm)
    return None


def _extract_module_function_keys(modules: List[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    found: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for module in modules:
        key = _module_function_key(module)
        if key:
            found[key] = module
    return found


def _function_id(entry: RequirementEntry, modules: List[Dict[str, Any]]) -> str:
    base_tokens = [token[:2] for token in entry.canonical_function.split() if token]
    if not base_tokens:
        base_tokens = [entry.canonical_function[:2] or entry.canonical_type[:2] or 'md']
    acronym = "".join(base_tokens).lower()
    acronym = (acronym or 'md')[:4]

    existing_ids = {str(module.get('id', '')).lower() for module in modules}
    idx = 1
    candidate = f"{acronym}-{idx:02d}"
    while candidate.lower() in existing_ids:
        idx += 1
        candidate = f"{acronym}-{idx:02d}"
    return candidate


def _approximate_dimensions(entry: RequirementEntry, crew_size: int) -> Tuple[float, float, float]:
    width = entry.min_width or 0.0
    depth = entry.min_depth or 0.0
    height = entry.min_height or 0.0
    volume = max(_required_volume(entry, crew_size), 0.1)

    dims = [width, depth, height]
    missing = [i for i, value in enumerate(dims) if value <= 0]
    if missing:
        known_product = 1.0
        for i in range(3):
            if i not in missing:
                known_product *= dims[i]
        remaining_volume = volume / max(known_product, 1e-6)
        fill_value = max(remaining_volume ** (1 / max(len(missing), 1)), 0.5)
        for idx in missing:
            dims[idx] = fill_value
    else:
        # ensure total volume not far below requirement by scaling uniformly
        current_volume = dims[0] * dims[1] * dims[2]
        if current_volume < volume:
            scale = (volume / max(current_volume, 1e-6)) ** (1 / 3)
            dims = [dimension * scale for dimension in dims]

    return tuple(round(d, 3) for d in dims)


def _ensure_requirement_modules(designer_layout: Dict[str, Any], crew_size: int, prompt: str) -> Dict[str, Any]:
    modules = list(designer_layout.get("modules", []))
    required = _required_function_set(crew_size, prompt)
    present = _extract_module_function_keys(modules)

    added_modules: List[Dict[str, Any]] = []
    cursor_y = 0.0
    if modules:
        cursor_y = max(m.get("y", 0.0) + m.get("d", 0.0) + 1.0 for m in modules)

    for key, entry in required.items():
        canonical_type, canonical_function = key
        if key in present:
            module = present[key]
            if not module.get("function"):
                module["function"] = entry.function_name
            continue
        if canonical_type in present:
            continue
        if canonical_function in present:
            continue
        width, depth, height = _approximate_dimensions(entry, crew_size)
        color_name = _color_for_type(entry.type_name)
        new_module = {
            "id": _get_next_module_id(),
            "type": entry.type_name,
            "kind": entry.type_name,
            "function": entry.function_name,
            "shape": "box",
            "x": 0.0,
            "y": cursor_y,
            "z": height / 2.0,
            "w": width,
            "d": depth,
            "h": height,
            "color": color_name,
        }
        modules.append(new_module)
        added_modules.append(new_module)
        cursor_y += depth + 0.75

    # Renumber all module IDs in the table, starting from '0001'
    for idx, mod in enumerate(modules, start=1):
        mod["id"] = f"{idx:04d}"
    designer_layout["modules"] = modules
    designer_layout.setdefault("requirements_report", {})
    designer_layout["requirements_report"]["added"] = [
        {
            "type": mod.get("type"),
            "function": mod.get("function"),
            "id": mod.get("id"),
        }
        for mod in added_modules
    ]
    designer_layout["requirements_report"]["required_total"] = len(required)
    designer_layout["requirements_report"]["covered"] = len(_extract_module_function_keys(modules))
    return designer_layout


def _compute_requirement_score(modules: List[Dict[str, Any]], crew: int, prompt: str) -> Dict[str, Any]:
    required = _required_function_set(crew, prompt)
    present = _extract_module_function_keys(modules)
    covered = sum(1 for key in required if key in present)
    total_required = max(len(required), 1)
    score = round((covered / total_required) * 100, 2)
    missing = [
        {
            "type": REQUIREMENT_LOOKUP[key].type_name,
            "function": REQUIREMENT_LOOKUP[key].function_name,
        }
        for key in required
        if key not in present
    ]
    return {
        "score": score,
        "covered": covered,
        "required": total_required,
        "missing": missing,
    }


def _requirement_library_entry(entry: RequirementEntry, crew_size: int = 4) -> Dict[str, Any]:
    width, depth, height = _approximate_dimensions(entry, crew_size)
    asset = f"req_{entry.canonical_type.replace(' ', '_')}_{entry.canonical_function.replace(' ', '_')}"
    return {
        "asset": asset,
        "label": entry.function_name,
        "type": entry.type_name,
        "function": entry.function_name,
        "shape": "box",
        "color": _color_for_type(entry.type_name),
        "size": {
            "w": width,
            "d": depth,
            "h": height,
        },
        "defaultZ": round(height / 2.0, 2),
        "critical": True,
        "description": f"Critical requirement: {entry.type_name} — {entry.function_name}",
    }

def _coerce_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def normalize_layout(layout):
    """Convert frontend JSON into Panda3D-ready layout."""
    habitat = layout.get("habitat", {})
    shape_type = str(habitat.get("type", "cylinder")).lower()

    shape = {"type": shape_type}
    if shape_type == "sphere":
        shape["radius"] = _coerce_float(habitat.get("radius"), 4.0)
    elif shape_type == "cube":
        shape["width"] = _coerce_float(habitat.get("width"), 10.0)
        shape["depth"] = _coerce_float(habitat.get("depth"), 10.0)
        shape["height"] = _coerce_float(habitat.get("height"), 10.0)
    else:  # default to cylinder configuration
        shape["type"] = "cylinder"
        shape["radius"] = _coerce_float(habitat.get("radius"), 4.0)
        shape["length"] = _coerce_float(habitat.get("length"), 14.0)

    # Ensure the habitat starts at (0, 0, 0) and aligns with the grid
    shape["position"] = [0.0, 0.0, 0.0]

    norm = {
        "shape": shape,
        "modules": []
    }

    for m in layout.get("modules", []):
        color = COLOR_MAP.get(m.get("color", "grey"), [0.7, 0.7, 0.7])
        module_id = m.get("id", "module")
        kind = m.get("type", "generic")
        shape_name = m.get("shape", "box")
        asset_name = m.get("asset")
        function_name = m.get("function") or m.get("functionality")
        module_entry = {
            "id": module_id,
            "kind": kind,
            "shape": shape_name,
            "pos": [
                _coerce_float(m.get("x"), 0.0),
                _coerce_float(m.get("y"), 0.0),
                _coerce_float(m.get("z"), 0.0),
            ],
            "size": [
                _coerce_float(m.get("w"), 1.0),
                _coerce_float(m.get("d"), 1.0),
                _coerce_float(m.get("h"), 1.0),
            ],
            "hpr": [0, 0, 0],
            "color": color
        }
        if asset_name:
            module_entry["asset"] = str(asset_name)
        if function_name:
            module_entry["function"] = function_name

        requirement = _find_requirement(kind, function_name)
        if requirement:
            module_entry["requirement"] = requirement

        norm["modules"].append(module_entry)

    return norm


def _build_reference_layouts():
    helios_layout = {
        "habitat": {"type": "cylinder", "radius": 3.25, "length": 11.0},
        "modules": [
            {"id": "airlock-vestibule", "type": "ingress", "shape": "cylinder",
             "x": -1.4, "y": -4.6, "z": -2.2, "w": 1.8, "d": 2.2, "h": 2.2, "color": "blue"},
            {"id": "suit-bay", "type": "maintenance", "shape": "box",
             "x": 0.6, "y": -4.2, "z": -2.2, "w": 2.2, "d": 2.6, "h": 2.0, "color": "grey"},
            {"id": "storm-shelter", "type": "life_support", "shape": "box",
             "x": 0.0, "y": -2.2, "z": -2.3, "w": 2.5, "d": 2.5, "h": 2.2, "color": "purple"},
            {"id": "maintenance-hub", "type": "maintenance", "shape": "box",
             "x": 1.8, "y": -1.0, "z": -2.1, "w": 2.3, "d": 2.3, "h": 2.0, "color": "orange"},
            {"id": "storage-carousel", "type": "storage", "shape": "cylinder",
             "x": -1.8, "y": -1.2, "z": -2.0, "w": 1.8, "d": 2.0, "h": 2.1, "color": "grey"},
            {"id": "power-hub", "type": "power", "shape": "box",
             "x": 0.0, "y": -0.2, "z": -2.2, "w": 2.0, "d": 1.8, "h": 1.8, "color": "yellow"},
            {"id": "eclss-core", "type": "life_support", "shape": "box",
             "x": 0.0, "y": 0.0, "z": 0.0, "w": 2.6, "d": 2.2, "h": 2.4, "color": "teal"},
            {"id": "lab-bench", "type": "work", "shape": "box",
             "x": -1.8, "y": 1.8, "z": 0.0, "w": 2.2, "d": 3.0, "h": 2.3, "color": "green"},
            {"id": "fabrication-bay", "type": "work", "shape": "box",
             "x": 1.9, "y": 1.6, "z": 0.0, "w": 2.0, "d": 2.8, "h": 2.2, "color": "orange"},
            {"id": "galley-hub", "type": "galley", "shape": "box",
             "x": -0.2, "y": 3.6, "z": 0.0, "w": 2.6, "d": 2.6, "h": 2.2, "color": "yellow"},
            {"id": "hygiene-suite", "type": "medbay", "shape": "box",
             "x": 1.9, "y": 3.6, "z": 0.0, "w": 2.0, "d": 2.4, "h": 2.2, "color": "blue"},
            {"id": "hydroponics", "type": "life_support", "shape": "box",
             "x": -2.0, "y": 3.8, "z": 0.0, "w": 1.8, "d": 2.6, "h": 2.3, "color": "green"},
            {"id": "crew-1", "type": "sleep", "shape": "capsule",
             "x": -2.0, "y": -3.2, "z": 2.2, "w": 1.6, "d": 2.0, "h": 2.1, "color": "green"},
            {"id": "crew-2", "type": "sleep", "shape": "capsule",
             "x": 0.0, "y": -3.2, "z": 2.2, "w": 1.6, "d": 2.0, "h": 2.1, "color": "green"},
            {"id": "crew-3", "type": "sleep", "shape": "capsule",
             "x": 2.0, "y": -3.2, "z": 2.2, "w": 1.6, "d": 2.0, "h": 2.1, "color": "green"},
            {"id": "crew-4", "type": "sleep", "shape": "capsule",
             "x": -2.0, "y": -0.8, "z": 2.2, "w": 1.6, "d": 2.0, "h": 2.1, "color": "green"},
            {"id": "exercise-zone", "type": "exercise", "shape": "box",
             "x": 2.0, "y": 0.8, "z": 2.2, "w": 2.2, "d": 2.4, "h": 2.3, "color": "purple"},
            {"id": "observation-dome", "type": "comms", "shape": "sphere",
             "x": 0.0, "y": 2.2, "z": 2.5, "w": 1.6, "d": 1.6, "h": 1.6, "color": "teal"},
            {"id": "life-support-backup", "type": "power", "shape": "box",
             "x": 0.0, "y": -0.8, "z": 2.2, "w": 1.8, "d": 1.8, "h": 1.8, "color": "orange"},
        ]
    }

    horizon_layout = {
        "habitat": {"type": "cylinder", "radius": 3.4, "length": 14.0},
        "modules": helios_layout["modules"] + [
            {"id": "isru-interface", "type": "work", "shape": "box",
             "x": 0.0, "y": 5.4, "z": -0.8, "w": 2.6, "d": 2.8, "h": 2.2, "color": "grey"},
            {"id": "robotics-lab", "type": "work", "shape": "box",
             "x": -2.2, "y": 5.4, "z": 0.8, "w": 2.2, "d": 2.6, "h": 2.2, "color": "blue"},
            {"id": "feedstock-loft", "type": "storage", "shape": "box",
             "x": 2.2, "y": 5.4, "z": 0.8, "w": 2.2, "d": 2.4, "h": 2.2, "color": "grey"},
        ]
    }

    designs = [
        {
            "id": "helios-3-stack",
            "name": "Helios-3 Stack Habitat",
            "crew": "2-4",
            "duration": "180 days",
            "summary": "Three-level hybrid stack with embedded storm shelter, hydroponics wall, and private crew pods.",
            "focus": [
                "Dual-loop ECLSS core with storm shelter redundancy",
                "Hydroponics + algae bioreactor for 20% O₂ buffer",
                "Privacy-optimized crew capsules with acoustic isolation",
                "Exercise alcove and mindfulness dome for well-being",
            ],
            "layout": helios_layout,
        },
        {
            "id": "helios-horizon-wing",
            "name": "Helios + Horizon Fabrication Wing",
            "crew": "3-4",
            "duration": "180 days",
            "summary": "Primary habitat plus expandable ISRU and robotics wing for fabrication-focused missions.",
            "focus": [
                "Extended cylinder envelope with dedicated ISRU interface",
                "Robotics teleoperation bay separated from crew quarters",
                "Elevated feedstock loft for spare parts and expansion kits",
                "Maintains storm shelter and dual redundancy pathways",
            ],
            "layout": horizon_layout,
        },
    ]

    enriched = []
    for design in designs:
        norm = normalize_layout(design["layout"])
        metrics = compute_metrics(norm)
        enriched.append({**design, "metrics": metrics})
    return enriched


REFERENCE_DESIGNS = _build_reference_layouts()


def _zone_color(name: str) -> str:
    palette = {
        "Airlock": "blue",
        "Work": "orange",
        "HygieneMedical": "teal",
        "GalleyDining": "yellow",
        "CrewQuarters": "green",
        "Exercise": "purple",
        "MaintenanceStorage": "grey",
        "StormShelter": "red",
        "Agriculture": "green",
    }
    return palette.get(name, "grey")


def _layout_to_designer_payload(layout: LLLayout) -> Dict[str, Any]:
    modules: List[Dict[str, Any]] = []
    height = 2.5
    spacing = 1.0
    for idx, zone in enumerate(layout.zones):
        footprint = max(zone.volume_m3 / height, 4.0)
        width = round(math.sqrt(footprint), 2)
        depth = round(footprint / width if width else 2.0, 2)
        row = idx // 3
        col = idx % 3
        x = (col - 1) * (width + spacing)
        y = row * (depth + spacing)
        modules.append({
            "id": _get_next_module_id(),
            "type": zone.name,
            "shape": "box",
            "x": round(x, 2),
            "y": round(y, 2),
            "z": round(height / 2, 2),
            "w": round(width, 2),
            "d": round(depth, 2),
            "h": round(height, 2),
            "color": _zone_color(zone.name),
        })

    radius = 4.0
    length = max(10.0, layout.pressurized_volume_m3 / (math.pi * radius * radius))
    designer_layout = {
        "habitat": {"type": "cylinder", "radius": round(radius, 2), "length": round(length, 2)},
        "modules": modules,
    }
    return designer_layout


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/stacked")
def stacked():
    return render_template("stacked.html")


@app.route("/design_library")
def design_library():
    return render_template("designs.html")

@app.route("/layout", methods=["GET"])
def get_layout():
    return jsonify(_current_layout)

@app.route("/layout", methods=["POST"])
def set_layout():
    global _current_layout
    previous_style = _current_layout.get("render_style", "realistic")
    layout = request.get_json(force=True) or {}
    habitat = layout.setdefault("habitat", {})
    if isinstance(habitat, dict):
        habitat["type"] = str(habitat.get("type", "cylinder")).lower()
    layout.setdefault("modules", [])
    style_value = layout.get("render_style", previous_style)
    if isinstance(style_value, str):
        layout["render_style"] = style_value.lower()
    else:
        layout["render_style"] = previous_style
    crew_value = layout.get("crew", _current_layout.get("crew", 4))
    try:
        layout["crew"] = int(crew_value)
    except (TypeError, ValueError):
        layout["crew"] = _current_layout.get("crew", 4)
    mission_prompt = layout.get("mission_prompt") or _current_layout.get("mission_prompt", "")
    layout["mission_prompt"] = str(mission_prompt)
    _current_layout = layout
    return jsonify({"ok": True})


@app.route("/requirements/enforce", methods=["POST"])
def enforce_requirements_route():
    payload = request.get_json(force=True) or {}
    crew = int(payload.get("crew", _current_layout.get("crew", 4)) or 4)
    mission_prompt = str(payload.get("mission_prompt", _current_layout.get("mission_prompt", "")))
    layout_payload = payload.get("layout")

    if layout_payload:
        designer_layout = _ensure_requirement_modules(layout_payload, crew, mission_prompt)
    else:
        designer_layout = {
            "habitat": _current_layout.get("habitat", {}),
            "modules": list(_current_layout.get("modules", [])),
            "render_style": _current_layout.get("render_style", "realistic"),
        }
        designer_layout = _ensure_requirement_modules(designer_layout, crew, mission_prompt)
        with _renderer_lock:
            _current_layout["modules"] = designer_layout["modules"]
            _current_layout["crew"] = crew
            _current_layout["mission_prompt"] = mission_prompt

    coverage = _compute_requirement_score(designer_layout["modules"], crew, mission_prompt)
    designer_layout["crew"] = crew
    designer_layout["mission_prompt"] = mission_prompt
    designer_layout.setdefault("render_style", _current_layout.get("render_style", "realistic"))
    return jsonify({"layout": designer_layout, "requirements": coverage})


@app.route("/requirements/library", methods=["GET"])
def requirements_library():
    global _library_id_counter
    seen: Dict[str, Dict[str, Any]] = {}
    for entry in BASE_CRITICAL_FUNCTIONS:
        module = _requirement_library_entry(entry)
        if module["asset"] not in seen:
            seen[module["asset"]] = module
    modules = sorted(seen.values(), key=lambda m: (m["type"].lower(), m["label"].lower()))
    return jsonify({"modules": modules})


@app.route("/requirements/catalog", methods=["GET"])
def requirements_catalog():
    entries: List[Dict[str, Any]] = []
    for entry in REQUIREMENT_LOOKUP.values():
        entries.append(
            {
                "type": entry.type_name,
                "function": entry.function_name,
                "canonicalType": entry.canonical_type,
                "canonicalFunction": entry.canonical_function,
                "minWidth": entry.min_width,
                "minDepth": entry.min_depth,
                "minHeight": entry.min_height,
                "typeCriticality": entry.type_crit,
                "functionCriticality": entry.function_crit,
                "volume4": entry.volume_4,
                "volume6": entry.volume_6,
                "volumeDelta": entry.volume_delta,
            }
        )
    return jsonify({"requirements": entries})

@app.route("/simulate", methods=["GET"])
def simulate():
    global _renderer
    with _renderer_lock:
        if _renderer is None:
            _renderer = HabitatRenderer()

        norm = normalize_layout(_current_layout)
        render_style = _current_layout.get("render_style", "realistic")
        _renderer.build_scene(norm, render_style)
        _renderer.render_snapshot("static/snapshot.png")

    metrics = compute_metrics(norm)
    crew = int(_current_layout.get("crew", 4) or 4)
    mission_prompt = str(_current_layout.get("mission_prompt", ""))
    requirements = _compute_requirement_score(norm.get("modules", []), crew, mission_prompt)
    return jsonify({"metrics": metrics, "snapshot": "/snapshot", "requirements": requirements})

@app.route("/snapshot", methods=["GET"])
def snapshot():
    path = "static/snapshot.png"
    if not os.path.exists(path):
        return jsonify({"error": "No snapshot yet"}), 404
    return send_file(path, mimetype="image/png")

import re
from flask import request, jsonify

# Default module templates
MODULE_TEMPLATES = {
    "sleep":  {"shape": "capsule", "color": "green",  "size": (0.6, 0.6, 1.5)},
    "galley": {"shape": "box",     "color": "orange", "size": (2.0, 2.0, 2.0)},
    "medbay": {"shape": "box",     "color": "teal",   "size": (2.0, 2.0, 2.0)},
    "exercise": {"shape": "box",   "color": "purple", "size": (2.0, 2.0, 2.0)},
    "storage": {"shape": "box",    "color": "grey",   "size": (1.2, 1.2, 1.2)},
}

# Synonyms mapping
SYNONYMS = {
    "bunk": "sleep",
    "bed": "sleep",
    "crew pod": "sleep",
    "kitchen": "galley",
    "canteen": "galley",
    "hospital": "medbay",
    "clinic": "medbay",
}

def parse_count(keyword, prompt, default=1):
    """Find number before/after a keyword, fallback to default."""
    pattern = rf"(\d+)\s+{keyword}"
    m = re.search(pattern, prompt, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return default

@app.route("/ai_modules", methods=["POST"])
def ai_modules():
    """Generate modules[] from natural language prompt (rule-based NLP)."""
    data = request.get_json(force=True)
    prompt = data.get("prompt", "").lower()
    modules = []

    # Expand synonyms into known keywords
    for syn, canonical in SYNONYMS.items():
        if syn in prompt:
            prompt = prompt.replace(syn, canonical)

    # Go through each known type
    for mtype, template in MODULE_TEMPLATES.items():
        if mtype in prompt:
            count = parse_count(mtype, prompt, default=(4 if mtype == "sleep" else 1))
            for i in range(count):
                sx, sy, sz = template["size"]
                modules.append({
                    "id": _get_next_module_id(),
                    "type": mtype,
                    "shape": template["shape"],
                    "x": (i % 4) * (sx + 0.5),   # auto-grid placement
                    "y": (i // 4) * (sy + 0.5),
                    "z": 1,
                    "w": sx, "d": sy, "h": sz,
                    "color": template["color"],
                })

    return jsonify({"modules": modules})


def _serialize_design(design):
    summary = {k: design[k] for k in ("id", "name", "crew", "duration", "summary", "focus")}
    metrics = design.get("metrics", {})
    return {**summary, "metrics": metrics, "layout": design["layout"]}


@app.route("/designs", methods=["GET"])
def list_designs():
    payload = [_serialize_design(design) for design in REFERENCE_DESIGNS]
    return jsonify({"designs": payload})


@app.route("/designs/<design_id>", methods=["GET"])
def get_design(design_id: str):
    for design in REFERENCE_DESIGNS:
        if design["id"] == design_id:
            return jsonify(_serialize_design(design))
    return jsonify({"error": "Design not found"}), 404


def _parse_ll_layout(payload: Dict[str, Any]) -> LLLayout:
    try:
        return LLLayout.parse_obj(payload)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Invalid layout payload: {exc}") from exc


def _parse_weights(payload: Dict[str, Any] | None) -> ScoreWeights | None:
    if not payload:
        return None
    return ScoreWeights.parse_obj(payload)


@app.route("/api/layout/auto_generate", methods=["POST"])
def auto_generate_layout():
    config = request.get_json(force=True) or {}
    crew = int(config.get("crew", 4) or 4)
    mission_prompt = str(config.get("mission_prompt", ""))
    generator_config = {k: v for k, v in config.items() if k not in {"mission_prompt", "render_style"}}
    try:
        layout = generate_initial_layout(generator_config, ConstraintSettings())
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    metrics, score = ll_evaluate(layout, ConstraintSettings(), _parse_weights(config.get("weights")))
    validation = ll_validate(layout, ConstraintSettings())
    designer_layout = _layout_to_designer_payload(layout)
    designer_layout["crew"] = crew
    designer_layout["mission_prompt"] = mission_prompt
    designer_layout = _ensure_requirement_modules(designer_layout, crew, mission_prompt)
    designer_layout.setdefault("render_style", "realistic")
    coverage = _compute_requirement_score(designer_layout["modules"], crew, mission_prompt)
    response = {
        "layout": designer_layout,
        "raw_layout": layout.dict(),
        "metrics": metrics.dict(),
        "score": coverage["score"],
        "validation": validation.messages,
        "requirements": coverage,
    }
    return jsonify(response)


@app.route("/api/layout/auto_optimize", methods=["POST"])
def auto_optimize_layout():
    payload = request.get_json(force=True) or {}
    layout_data = payload.get("layout")
    if not layout_data:
        return jsonify({"error": "layout payload required"}), 400
    iterations = int(payload.get("iterations", 3000))
    weights = _parse_weights(payload.get("weights"))
    try:
        layout = _parse_ll_layout(layout_data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        result = ll_optimize(layout, iterations=iterations, settings=ConstraintSettings(), weights=weights)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    designer_layout = _layout_to_designer_payload(result.layout)
    crew = int(payload.get("crew", 4) or 4)
    mission_prompt = str(payload.get("mission_prompt", ""))
    designer_layout["crew"] = crew
    designer_layout["mission_prompt"] = mission_prompt
    designer_layout = _ensure_requirement_modules(designer_layout, crew, mission_prompt)
    designer_layout.setdefault("render_style", "realistic")
    coverage = _compute_requirement_score(designer_layout["modules"], crew, mission_prompt)
    validation = ll_validate(result.layout, ConstraintSettings())
    response = {
        "layout": designer_layout,
        "raw_layout": result.layout.dict(),
        "metrics": result.metrics.dict(),
        "score": coverage["score"],
        "validation": validation.messages,
        "requirements": coverage,
    }
    return jsonify(response)


@app.route("/api/layout/auto_validate", methods=["POST"])
def auto_validate_layout():
    payload = request.get_json(force=True) or {}
    layout_data = payload.get("layout")
    if not layout_data:
        return jsonify({"error": "layout payload required"}), 400
    try:
        layout = _parse_ll_layout(layout_data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    result = ll_validate(layout, ConstraintSettings())
    designer_layout = _layout_to_designer_payload(layout)
    crew = int(payload.get("crew", 4) or 4)
    mission_prompt = str(payload.get("mission_prompt", ""))
    designer_layout = _ensure_requirement_modules(designer_layout, crew, mission_prompt)
    coverage = _compute_requirement_score(designer_layout["modules"], crew, mission_prompt)
    return jsonify({
        "passed": result.passed,
        "messages": result.messages,
        "failed": result.failed_rules,
        "requirements": coverage,
    })


@app.route("/api/layout/auto_score", methods=["POST"])
def auto_score_layout():
    payload = request.get_json(force=True) or {}
    layout_data = payload.get("layout")
    if not layout_data:
        return jsonify({"error": "layout payload required"}), 400
    crew = int(payload.get("crew", 4) or 4)
    mission_prompt = str(payload.get("mission_prompt", ""))

    if isinstance(layout_data, dict) and "modules" in layout_data:
        modules = layout_data.get("modules", [])
        coverage = _compute_requirement_score(modules, crew, mission_prompt)
        return jsonify({"score": coverage["score"], "requirements": coverage, "feasible": True})

    else:
        weights = _parse_weights(payload.get("weights"))
        try:
            layout = _parse_ll_layout(layout_data)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        metrics, _ = ll_evaluate(layout, ConstraintSettings(), weights)
        designer_layout = _layout_to_designer_payload(layout)
        designer_layout = _ensure_requirement_modules(designer_layout, crew, mission_prompt)
        coverage = _compute_requirement_score(designer_layout["modules"], crew, mission_prompt)
        return jsonify({
            "metrics": metrics.dict(),
            "score": coverage["score"],
            "requirements": coverage,
            "feasible": metrics.feasibility,
        })


@app.route("/api/layout/auto_export", methods=["POST"])
def auto_export_layout():
    payload = request.get_json(force=True) or {}
    layout_data = payload.get("layout")
    if not layout_data:
        return jsonify({"error": "layout payload required"}), 400
    try:
        layout = _parse_ll_layout(layout_data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    metrics, _ = ll_evaluate(layout, ConstraintSettings(), None)
    validation = ll_validate(layout, ConstraintSettings())
    crew = int(payload.get("crew", 4) or 4)
    mission_prompt = str(payload.get("mission_prompt", ""))
    designer_layout = _layout_to_designer_payload(layout)
    designer_layout = _ensure_requirement_modules(designer_layout, crew, mission_prompt)
    coverage = _compute_requirement_score(designer_layout["modules"], crew, mission_prompt)
    markdown = ll_export_markdown(layout, metrics, validation.messages)
    return jsonify({"markdown": markdown, "requirements": coverage})

@app.route('/re-id-modules', methods=['POST'])
def re_id_modules():
    """
    Reassign IDs to all modules in the current layout, starting from 1.
    """
    global _current_layout, _module_id_counter
    _module_id_counter = 1  # Reset the ID counter

    for index, module in enumerate(_current_layout['modules']):
        module['id'] = f"{_get_next_module_id()}"

    return jsonify({"status": "success", "message": "Modules re-IDed successfully."})

@app.route('/add-module', methods=['POST'])
def add_module():
    """
    Add a new module to the current layout and re-ID all modules automatically.
    """
    global _current_layout

    # Parse the new module data from the request
    new_module = request.json
    new_module['id'] = _get_next_module_id()
    _current_layout['modules'].append(new_module)

    # Re-ID all modules
    for idx, module in enumerate(_current_layout['modules'], start=1):
        module['id'] = f"{idx:04d}"

    return jsonify({"status": "success", "message": "Module added and IDs updated.", "module": new_module})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
