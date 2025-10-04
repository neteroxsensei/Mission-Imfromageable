"""Command line interface for lunar_layout toolkit."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .constraints import validate_layout
from .generator import generate_from_file, generate_initial_layout
from .io_schema import (
    GeneratorConfig,
    config_schema,
    export_markdown,
    load_config,
    load_layout,
    load_weights,
    metrics_schema,
    save_layout,
)
from .models import ConstraintSettings, Layout, ScoreWeights
from .optimizer import optimize_layout
from .scoring import evaluate

DEFAULT_CONFIG_PATH = Path("examples/seed_config.json")


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True))


def cmd_init(args: argparse.Namespace) -> int:
    path = Path(args.out or DEFAULT_CONFIG_PATH)
    if not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "crew": 4,
        "duration_days": 90,
        "habitat_type": "Inflatable",
        "pressurized_volume_m3": 160,
        "target_isru_ratio": 0.6,
        "docking_ports": 2,
        "seed": 42,
        "weights": ScoreWeights().dict(),
    }
    _write_json(path, config)
    print(f"Wrote seed configuration to {path}")
    return 0


def _get_weights(args: argparse.Namespace) -> ScoreWeights | None:
    if getattr(args, "weights", None):
        return load_weights(args.weights)
    return None


def cmd_generate(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    settings = ConstraintSettings()
    layout = generate_initial_layout(config.dict(), settings)
    save_layout(layout, args.out)
    print(f"Generated layout saved to {args.out}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    layout = load_layout(args.input)
    settings = ConstraintSettings()
    result = validate_layout(layout, settings)
    for msg in result.messages:
        print(msg)
    return 0 if result.passed else 1


def cmd_score(args: argparse.Namespace) -> int:
    layout = load_layout(args.input)
    settings = ConstraintSettings()
    weights = _get_weights(args)
    metrics, score = evaluate(layout, settings, weights)
    print(json.dumps({"metrics": metrics.dict(), "score": score}, indent=2))
    return 0 if metrics.feasibility else 1


def cmd_optimize(args: argparse.Namespace) -> int:
    layout = load_layout(args.input)
    weights = _get_weights(args)
    result = optimize_layout(
        layout,
        iterations=args.iters,
        settings=ConstraintSettings(),
        weights=weights,
        seed=args.seed,
    )
    save_layout(result.layout, args.out)
    print(f"Optimized layout saved to {args.out}; score={result.score:.3f}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    layout = load_layout(args.input)
    settings = ConstraintSettings()
    weights = _get_weights(args)
    metrics, score = evaluate(layout, settings, weights)
    result = validate_layout(layout, settings)

    if args.format == "md":
        md = export_markdown(layout, metrics, result.messages)
        if args.out:
            Path(args.out).write_text(md)
        else:
            print(md)
    elif args.format == "json":
        data = {
            "layout": layout.dict(),
            "metrics": metrics.dict(),
            "score": score,
            "validation": result.messages,
        }
        payload = json.dumps(data, indent=2)
        if args.out:
            Path(args.out).write_text(payload)
        else:
            print(payload)
    elif args.format == "csv":
        import csv
        from io import StringIO

        buffer = StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["Metric", "Value"])
        for key, value in metrics.dict().items():
            writer.writerow([key, value])
        output = buffer.getvalue()
        if args.out:
            Path(args.out).write_text(output)
        else:
            sys.stdout.write(output)
    else:
        raise ValueError(f"Unsupported export format: {args.format}")
    return 0


def cmd_schema(args: argparse.Namespace) -> int:
    if args.target == "layout":
        data = config_schema() if args.kind == "config" else Layout.schema()
    elif args.target == "metrics":
        data = metrics_schema()
    else:
        raise ValueError("Unknown schema target")
    print(json.dumps(data, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lunar_layout")
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="write seed configuration")
    p_init.add_argument("--out", default=None)
    p_init.set_defaults(func=cmd_init)

    p_gen = sub.add_parser("generate", help="generate initial layout")
    p_gen.add_argument("--config", required=True)
    p_gen.add_argument("--out", required=True)
    p_gen.set_defaults(func=cmd_generate)

    p_val = sub.add_parser("validate", help="validate layout")
    p_val.add_argument("--in", dest="input", required=True)
    p_val.set_defaults(func=cmd_validate)

    p_score = sub.add_parser("score", help="score layout")
    p_score.add_argument("--in", dest="input", required=True)
    p_score.add_argument("--weights", default=None)
    p_score.set_defaults(func=cmd_score)

    p_opt = sub.add_parser("optimize", help="optimize layout")
    p_opt.add_argument("--in", dest="input", required=True)
    p_opt.add_argument("--iters", type=int, default=3000)
    p_opt.add_argument("--out", required=True)
    p_opt.add_argument("--seed", type=int, default=None)
    p_opt.add_argument("--weights", default=None)
    p_opt.set_defaults(func=cmd_optimize)

    p_exp = sub.add_parser("export", help="export layout summary")
    p_exp.add_argument("--in", dest="input", required=True)
    p_exp.add_argument("--format", choices=["md", "json", "csv"], required=True)
    p_exp.add_argument("--out", default=None)
    p_exp.add_argument("--weights", default=None)
    p_exp.set_defaults(func=cmd_export)

    p_schema = sub.add_parser("schema", help="print JSON schema")
    p_schema.add_argument("--target", choices=["layout", "metrics"], required=True)
    p_schema.add_argument("--kind", choices=["layout", "config"], default="layout")
    p_schema.set_defaults(func=cmd_schema)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return 1
    try:
        return int(args.func(args))
    except Exception as exc:  # pragma: no cover - CLI top-level handler
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
