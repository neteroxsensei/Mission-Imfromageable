# Mission Imfromageable – Habitat Layout Designer

Mission Imfromageable challenges the Artemis architecture team to establish a long-duration, cheese-research-forward lunar outpost. This repository delivers the end-to-end tooling that powers that effort: an interactive designer coupled with the `lunar_layout` optimization engine so mission architects can experiment with habitat shells, curate module inventories, enforce critical requirements, and instantly inspect coverage metrics while staying on-theme with the Imfromageable brief.

## Highlights

- **Interactive designer** – adjust habitat geometry, crew context, and module inventory from the browser with automatic persistence.
- **Autonomous validation** – every edit runs the constraint pipeline to keep layouts feasible and highlights issues the moment they appear.
- **Requirement assistant** – one-click enforcement of mission-critical modules based on NASA/CSA guidance, tuned to the Imfromageable mission objectives.
- **Rich visual feedback** – snapshot imagery from Panda3D, a 2D layout map, and embedded charts for volume, usage, and footprint.
- **Mission flavor** – UI copy, prefabs, and helper modules lean into the artisanal cheese-production storyline to keep stakeholders aligned on the Imfromageable narrative.
- **AI module ideation** – optional prompt-driven module generation to quickly explore alternative configurations.
- **Headless tooling** – the original `lunar_layout` CLI remains available for scripted batch generation, scoring, and export.

## Getting Started

### Prerequisites

- Python 3.11+
- Optional: Docker (the repository ships with a Dockerfile/docker-compose.yml if you prefer containers)

### Local environment

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Launch the web app

```bash
python app.py
```

By default the server listens on `http://127.0.0.1:5000`. Open that address to reach the Habitat Layout Designer UI.

### Using Docker

```bash
docker build -t habitat-designer .
docker run --rm -p 5000:5000 habitat-designer
```

Or with Compose:

```bash
docker compose up --build
```

## Interface Walkthrough

1. **Mission Blueprint** – set crew size, mission focus (e.g., whey-processing, microbial aging labs), and adjust the habitat shell (cylinder, sphere, cube). Changes automatically persist and inform later validations.
2. **Module Library & Active Layout** – browse prefabs, add or edit custom modules (cryogenic brie vaults, rind-conditioning labs), duplicate, delete, or trigger automatic requirement enforcement.
3. **Snapshot & Metrics** – trigger simulations, review up-to-date renders, inspect the 2D layout map, and monitor coverage via interactive charts.
4. **AI Assistant** – describe desired capabilities (“develop a culturing nook near thermal control”) and let the AI widget draft candidate modules that snap into the layout for further refinement.

## Project Structure

```
app.py                # Flask entry point, REST endpoints, requirement helpers
static/               # Front-end scripts, styles, assets
  script.js
  style.css
  images/
templates/            # Jinja templates (designer, stacked view, design library)
lunar_layout/         # Optimization engine reused by the app and CLI
  models.py
  constraints.py
  generator.py
  optimizer.py
  scoring.py
  io_schema.py
  cli.py
examples/             # Sample configuration files
tests/                # Pytest suite for the core engine
```

## Key Endpoints

- `GET /` – main designer dashboard
- `GET /stacked` – stacked (cross-section) visualization
- `GET /design_library` – curated reference layouts
- `GET /layout` / `POST /layout` – retrieve or persist the working layout state
- `POST /requirements/enforce` – inject mission-critical modules based on crew and mission context
- `POST /api/layout/auto_*` – automation endpoints for validation, optimization, scoring, and export
- `GET /snapshot` – latest rendered image served to the UI

## Development Notes

- The Flask server disables the reloader by default (`use_reloader=False`) to avoid double-initializing Panda3D.
- Panda3D snapshots require a valid display; when running headless, use a virtual framebuffer or the provided Docker configuration.
- JavaScript modules are plain ES5 to remain compatible with the bundled CDN assets.

## Testing

```bash
pytest
```

The test suite covers the `lunar_layout` engine. Add frontend or integration tests as needed for new features.

## License

MIT
