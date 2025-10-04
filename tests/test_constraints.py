from lunar_layout.constraints import validate_layout
from lunar_layout.generator import generate_initial_layout
from lunar_layout.models import ConstraintSettings, Layout


def make_layout(crew: int = 4) -> Layout:
    config = {
        "crew": crew,
        "duration_days": 90,
        "habitat_type": "Inflatable",
        "pressurized_volume_m3": 170,
        "target_isru_ratio": 0.6,
        "docking_ports": 2,
        "seed": 7,
    }
    return generate_initial_layout(config)


def test_validate_layout_passes():
    layout = make_layout()
    result = validate_layout(layout, ConstraintSettings())
    assert result.passed, result.failed_rules


def test_validate_detects_missing_zone():
    layout = make_layout()
    # drop exercise zone to force failure
    layout.zones = [z for z in layout.zones if z.name != "Exercise"]
    result = validate_layout(layout, ConstraintSettings())
    assert not result.passed
    assert "required_zones" in result.failed_rules
