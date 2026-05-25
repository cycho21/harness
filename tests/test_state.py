from dpaa.parser import MarkdownParser
from dpaa.layers.state import StateLayer
from pathlib import Path

FIXTURES = Path("tests/fixtures")


def test_valid_dag_produces_no_findings():
    text = (FIXTURES / "structured_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = StateLayer().analyze(doc)
    assert result.score == 0


def test_cyclic_dependency_detected():
    text = """# Goal
Test

# Steps

```yaml
steps:
  - id: A
    action: do_a
    requires: [STATE_B]
    produces: [STATE_A]
  - id: B
    action: do_b
    requires: [STATE_A]
    produces: [STATE_B]
```

# Acceptance Criteria
PASS if complete.

# Rollback
Revert.
"""
    doc = MarkdownParser().parse(text)
    result = StateLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "cyclic_dependency" in rules


def test_missing_producer_detected():
    text = """# Goal
Test

# Steps

```yaml
steps:
  - id: IMPLEMENT
    action: implement
    requires: [PLAN_APPROVED]
    produces: [DONE]
```

# Acceptance Criteria
PASS if done.

# Rollback
Revert.
"""
    doc = MarkdownParser().parse(text)
    result = StateLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "missing_required_state_producer" in rules
