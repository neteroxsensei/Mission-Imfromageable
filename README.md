# Lunar Layout Generator

Constraint-driven lunar habitat layout generator, validator, and optimizer designed for 2–4 crew missions (30–180 days). The toolkit enforces NASA/CSA habitability and safety rules and provides both CLI utilities and Python APIs for rapid iteration.

## Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Quickstart

```bash
python -m lunar_layout.cli init
python -m lunar_layout.cli generate --config examples/seed_config.json --out layout.json
python -m lunar_layout.cli validate --in layout.json
python -m lunar_layout.cli optimize --in layout.json --iters 3000 --out layout_opt.json
python -m lunar_layout.cli score --in layout_opt.json
python -m lunar_layout.cli export --in layout_opt.json --format md > report.md
```

## Project Layout

```
examples/
  seed_config.json
lunar_layout/
  __init__.py
  models.py
  constraints.py
  scoring.py
  generator.py
  optimizer.py
  io_schema.py
  cli.py
tests/
  test_models.py
  test_constraints.py
  test_optimizer.py
  test_cli.py
```

Each module provides a focused surface:

- `models` defines Pydantic models for zones, systems, layouts, and metrics.
- `constraints` implements hard/soft validators and reports.
- `scoring` computes metrics and multi-objective scores.
- `generator` builds initial feasible layouts from configuration.
- `optimizer` refines layouts using simulated annealing with constraint checks.
- `io_schema` contains JSON schema helpers for import/export.
- `cli` offers a production-grade command line.

## Notes

- Default usable ratios and adjacency rules follow the specification provided in the task prompt.
- All hard constraints must pass before a layout is deemed feasible. CLI commands exit with non-zero status if validation fails.
- Override scoring weights by passing a JSON file via `--weights`.

## Testing

```bash
pytest
```

## License

MIT
