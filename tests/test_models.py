from lunar_layout.models import Layout, Systems, Zone


def test_layout_metadata_required_keys():
    systems = Systems(
        eclss_redundancy_loops=2,
        water_recycling_rate=0.95,
        power={"source": "Solar+Battery", "autonomy_days": 14},
        thermal={},
        comms={},
        dust_mitigation={"dual_door": True, "suit_storage": True},
    )
    zone = Zone(
        name="CrewQuarters",
        volume_m3=40,
        usable_ratio=0.9,
        privacy="High",
        connections=[],
        acoustic_isolation=0.8,
        lighting="Adaptive",
        is_pressurized=True,
        is_egress=False,
        equipment=[],
    )
    layout = Layout(
        habitat_name="Test",
        habitat_type="Inflatable",
        pressurized_volume_m3=120,
        zones=[zone],
        systems=systems,
        shield_equivalent_g_cm2=6.0,
        isru_ratio=0.6,
        docking_ports=2,
        metadata={"crew": 2, "duration_days": 60, "seed": 1},
    )
    assert layout.metadata["crew"] == 2
