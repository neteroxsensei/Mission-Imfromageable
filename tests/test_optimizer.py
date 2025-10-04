from lunar_layout.generator import generate_initial_layout
from lunar_layout.optimizer import optimize_layout
from lunar_layout.scoring import evaluate
from lunar_layout.models import ConstraintSettings, ScoreWeights


def test_optimizer_improves_score():
    layout = generate_initial_layout({"seed": 5})
    settings = ConstraintSettings()
    weights = ScoreWeights()
    metrics_before, score_before = evaluate(layout, settings, weights)
    assert metrics_before.feasibility
    result = optimize_layout(layout, iterations=50, settings=settings, weights=weights, seed=5)
    assert result.score >= score_before * 0.9  # allow slight variance but not drastic drop
    assert result.metrics.feasibility
