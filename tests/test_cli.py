import json
import subprocess
import sys
from pathlib import Path

import pytest

CLI = [sys.executable, "-m", "lunar_layout.cli"]


@pytest.mark.integration
def test_cli_quickstart(tmp_path: Path):
    config_path = tmp_path / "config.json"
    layout_path = tmp_path / "layout.json"
    opt_path = tmp_path / "layout_opt.json"

    subprocess.run(CLI + ["init", "--out", str(config_path)], check=True)
    subprocess.run(CLI + ["generate", "--config", str(config_path), "--out", str(layout_path)], check=True)
    subprocess.run(CLI + ["validate", "--in", str(layout_path)], check=True)
    subprocess.run(CLI + ["optimize", "--in", str(layout_path), "--iters", "20", "--out", str(opt_path)], check=True)
    subprocess.run(CLI + ["validate", "--in", str(opt_path)], check=True)
    result = subprocess.run(
        CLI + ["score", "--in", str(opt_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["metrics"]["feasibility"] is True
