from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GATES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "gates.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
ROUTER = ROOT / "target" / ".pi" / "extensions" / "workflow" / "application" / "workflow-command-router.ts"
FORMAT = ROOT / "target" / ".pi" / "extensions" / "workflow" / "format.ts"


def test_code_quality_gate_runs_before_review_approved():
    gates = GATES.read_text(encoding="utf-8")

    assert 'from === "code_review" && to === "review_approved"' in gates
    assert "runCodeQualityGate(workflow)" in gates
    assert "export function runCodeQualityGate" in gates
    assert "codeQualityGuard" in gates
    assert "HARNESS_CODE_QUALITY_GUARD_CMD" in gates
    assert "Checkstyle/PMD" in gates  # message content; exact phrasing may vary


def test_code_quality_gate_treats_unknown_exit_as_blocking_environment_error():
    gates = GATES.read_text(encoding="utf-8")

    assert "status == null" in gates
    assert "exit code unknown" in gates
    assert "environment-error" in gates
    assert "Quality guard execution failed before violations could be verified" in gates
    assert "ok: false" in gates


def test_code_quality_gate_has_explicit_skip_and_phase_guidance():
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8") + ROUTER.read_text(encoding="utf-8")
    fmt = FORMAT.read_text(encoding="utf-8")

    assert '"code-quality"' in workflow
    assert "/workflow skip <gate> <사유>" in workflow
    assert "Advancing to review_approved mechanically runs codeQualityGuard" in fmt


# ── diff-aware gate + --no-build-cache ────────────────────────────────────────

def test_code_quality_gate_uses_no_daemon_and_no_build_cache_not_rerun_tasks():
    gates = GATES.read_text(encoding="utf-8")
    assert "--no-daemon" in gates
    assert "--no-build-cache" in gates
    # --rerun-tasks must not appear as an actual argument (comment mentions are ok)
    import re
    actual_uses = re.findall(r'["\']--rerun-tasks["\']', gates)
    assert actual_uses == [], f"--rerun-tasks used as argument: {actual_uses}"


def test_code_quality_gate_retries_environment_failures_once_and_keeps_violation_failures_single_attempt():
    gates = GATES.read_text(encoding="utf-8")
    assert "MAX_CODE_QUALITY_ATTEMPTS = 2" in gates
    assert "shouldRetryCodeQualityFailure" in gates
    assert "classifyCodeQualityFailure" in gates
    assert "attempts" in gates
    assert "stdoutTail" in gates
    assert "stderrTail" in gates


def test_diff_aware_gate_check_function_exists():
    gates = GATES.read_text(encoding="utf-8")
    assert "diffAwareGateCheck" in gates
    assert "extractViolationFilePaths" in gates
    assert "getChangedFileAbsPaths" in gates


def test_extract_violation_file_paths_exported():
    gates = GATES.read_text(encoding="utf-8")
    assert "export function extractViolationFilePaths" in gates


def test_diff_aware_gate_called_in_quality_gate():
    gates = GATES.read_text(encoding="utf-8")
    # diffAwareGateCheck must be invoked inside runCodeQualityGate error path
    assert "diffAwareGateCheck(" in gates
    assert "if (diffAware)" in gates or "if (diffAware) return" in gates


def test_diff_aware_gate_logs_pre_existing_pass():
    gates = GATES.read_text(encoding="utf-8")
    assert "diff-aware-pass" in gates
    assert "Pre-existing" in gates or "pre-existing" in gates


def test_extract_violation_handles_absolute_and_relative_paths():
    gates = GATES.read_text(encoding="utf-8")
    # Should have patterns for both absolute (/path or C:\path) and relative paths
    assert "ABS_RE" in gates
    assert "REL_RE" in gates


def test_changed_files_uses_git_status_porcelain():
    gates = GATES.read_text(encoding="utf-8")
    assert "git status --porcelain=v1" in gates
