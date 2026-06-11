---
name: trace
description: Use for evidence-driven causal analysis before fixing ambiguous workflow, guard, runtime, or test failures. Separates observation, hypotheses, evidence, missing facts, and the next discriminating probe. Output language is Korean.
---

# Trace Skill

Use this skill when the user asks why something happened, when a workflow/guard failure is ambiguous, or when a bug/regression should be explained before implementation.

Do not use this skill for direct implementation when the cause and required fix are already clear.

## Goal

Turn an observed failure into a ranked, evidence-backed explanation without jumping to a premature fix.

## Core Contract

Always preserve these distinctions:

1. **Observation** — what was actually observed.
2. **Hypotheses** — competing explanations that could account for the observation.
3. **Evidence For** — facts that support each hypothesis.
4. **Evidence Against / Gaps** — facts that contradict it or are still missing.
5. **Current Best Explanation** — the leading explanation now, not fake certainty.
6. **Critical Unknown** — the missing fact that keeps top hypotheses apart.
7. **Discriminating Probe** — the cheapest next check that would collapse uncertainty.

## Evidence Strength

Rank evidence from strongest to weakest:

1. Controlled reproduction, direct experiment, or uniquely discriminating artifact.
2. Primary source with provenance: file path, line behavior, test output, logs, config, git history.
3. Multiple independent sources converging on one explanation.
4. Single-source code-path inference.
5. Circumstantial clue such as timing, naming, or resemblance.
6. Intuition, analogy, or speculation.

Down-rank hypotheses that rely mainly on weak evidence when stronger contradictory evidence exists.

## Workflow

1. Restate the observation precisely.
2. Generate 2–4 deliberately different hypotheses.
3. Gather narrow evidence for and against each hypothesis. Do not perform broad repository scans unless the user explicitly asks.
4. State each hypothesis's distinctive prediction.
5. Run a rebuttal pass between the strongest two hypotheses.
6. Merge hypotheses only when they reduce to the same root mechanism.
7. Recommend one discriminating probe before proposing a fix.

## Output Template

```markdown
## Observation
<what was observed>

## Ranked Hypotheses
| Rank | Hypothesis | Confidence | Why |
|------|------------|------------|-----|
| 1 | ... | high/medium/low | ... |

## Evidence
### H1: <hypothesis>
- For: <evidence with path/output when available>
- Against / Gaps: <contradiction or missing fact>
- Distinctive Prediction: <what should be true if this is correct>

## Rebuttal Round
<best alternative's challenge and answer>

## Current Best Explanation
<best explanation with confidence and caveats>

## Critical Unknown
<one missing fact>

## Discriminating Probe
<smallest next check>
```

## Rules

- Do not implement during trace unless the user explicitly asks to proceed after the trace.
- Do not claim root cause without evidence.
- Prefer fewer, stronger probes over many weak checks.
- For harness workflow issues, include phase, guard, command, state, and affected file/path evidence when available.
