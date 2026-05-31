import json
import re
from dataclasses import dataclass, field
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_TYPES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "types.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
TRANSCRIPT = ROOT / "tests" / "fixtures" / "llm_workflow_transcript.json"


APPROVAL_WORDS = ("approve", "approved", "승인", "좋아", "확인")


def _workflow_phases_from_runtime_source() -> list[str]:
    text = WORKFLOW_TYPES.read_text(encoding="utf-8")
    match = re.search(r"export const WORKFLOW_PHASES:[^=]+=[\s\S]*?\];", text)
    assert match, "WORKFLOW_PHASES must stay explicit in the workflow runtime source"
    return re.findall(r'"([a-z_]+)"', match.group(0))


def _assert_transcript_covers_real_extension_gates() -> None:
    text = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    # This test is a replay of the real workflow contract. If these hooks/tools
    # disappear, the transcript would no longer represent the extension runtime.
    for needle in [
        'pi.registerCommand("workflow"',
        'Code review guard 승인 확인',
        'pi.on("input"',
        'event.source !== "interactive"',
        'pi.on("tool_call"',
        'state.workflow.phase !== "push"',
        'formatGateBlocked({',
    ]:
        assert needle in text


@dataclass
class ReplayHarness:
    phases: list[str]
    phase: str | None = None
    dpaa_level: str | None = None
    review_token: dict[str, int] | None = None
    push_phase_token: bool = False
    history: list[tuple[str, str, str]] = field(default_factory=list)

    def start(self, title: str) -> str:
        assert title.strip()
        assert self.phase is None
        self.phase = self.phases[0]
        return self.phase

    def handle_user_input(self, text: str) -> dict[str, str | bool]:
        assert self.phase is not None, "workflow must be started before approval input"
        if not any(word in text.lower() for word in APPROVAL_WORDS):
            return {"allowed": True, "phase": self.phase}
        return self.advance("natural_language_approval")

    def advance(self, reason: str) -> dict[str, str | bool]:
        assert self.phase is not None
        current_index = self.phases.index(self.phase)
        if current_index == len(self.phases) - 1:
            return {"allowed": False, "reason": f"already at final phase: {self.phase}"}

        from_phase = self.phase
        to_phase = self.phases[current_index + 1]
        if from_phase == "plan_review" and to_phase == "implement" and self.dpaa_level != "PASS":
            return {"allowed": False, "reason": "DPAA gate blocked before plan_review → implement"}

        if from_phase == "code_review" and to_phase == "review_approved" and not self.review_token:
            self.confirm_code_review_guard()
        self.phase = to_phase
        self.history.append((from_phase, to_phase, reason))
        if from_phase == "commit" and to_phase == "push":
            self.push_phase_token = True
        return {"allowed": True, "phase": self.phase}

    def write_artifact(self, event: dict) -> None:
        if event["name"] == ".ai/interview/plan.md":
            self.dpaa_level = event.get("dpaa_level")

    def confirm_code_review_guard(self) -> None:
        self.review_token = {"critical": 0, "major": 0, "minor": 0}

    def bash(self, command: str) -> dict[str, str | bool]:
        if not re.search(r"(^|&&|;)\s*git\s+push\b", command):
            return {"allowed": True, "reason": "not a push"}

        if self.phase != "push":
            return {"allowed": False, "reason": f"WORKFLOW PHASE required: push, current: {self.phase}"}

        if not self.push_phase_token:
            return {"allowed": False, "reason": "Push Phase Authority token is missing"}

        if not self.review_token:
            return {"allowed": False, "reason": "Push Review token is missing"}

        token = self.review_token
        self.review_token = None
        if token["critical"] > 0 or token["major"] > 2:
            return {"allowed": False, "reason": "Push Review threshold failed"}
        return {"allowed": True, "reason": "push allowed"}


def test_llm_like_transcript_replays_complete_workflow_with_gates():
    _assert_transcript_covers_real_extension_gates()
    transcript = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    harness = ReplayHarness(_workflow_phases_from_runtime_source())

    for event in transcript:
        if event["kind"] == "command" and event["name"] == "workflow":
            command, _, args = event["args"].partition(" ")
            assert command == "start"
            assert harness.start(args) == "interview"
            continue

        if event["kind"] == "input":
            result = harness.handle_user_input(event["text"])
        elif event["kind"] == "artifact":
            harness.write_artifact(event)
            continue
        elif event["kind"] == "tool_call" and event["tool"] == "bash":
            result = harness.bash(event["command"])
        elif event["kind"] == "message":
            continue
        else:
            raise AssertionError(f"unsupported transcript event: {event}")

        if event.get("expect_allowed"):
            assert result["allowed"], result
        if expected_block := event.get("expect_blocked"):
            assert not result["allowed"], result
            assert expected_block in str(result["reason"]), result

    assert harness.phase == "push"
    assert harness.history == [
        ("interview", "plan", "natural_language_approval"),
        ("plan", "plan_review", "natural_language_approval"),
        ("plan_review", "implement", "natural_language_approval"),
        ("implement", "code_review", "natural_language_approval"),
        ("code_review", "review_approved", "natural_language_approval"),
        ("review_approved", "document", "natural_language_approval"),
        ("document", "commit", "natural_language_approval"),
        ("commit", "push", "natural_language_approval"),
    ]
    assert harness.review_token is None, "push review token must be single-use"
