import re
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GATES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "gates.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
TOOL_CALL_GATE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "application" / "tool-call-gate.ts"


@dataclass(frozen=True)
class StatusEntry:
    status: str
    file: str


def _parse_porcelain(lines: list[str]) -> list[StatusEntry]:
    entries: list[StatusEntry] = []
    for line in lines:
        status = line[:2]
        raw_path = line[3:].strip()
        file = raw_path.split(" -> ")[-1].replace("\\", "/")
        entries.append(StatusEntry(status, file))
    return entries


def _mirror_policy_scan(lines: list[str], max_changed: int = 30) -> dict[str, list[str]]:
    entries = _parse_porcelain(lines)
    checks = [
        ("Build descriptor changed", lambda e: re.search(r"(^|/)(build\.gradle(\.kts)?|pom\.xml)$", e.file)),
        ("Application config changed", lambda e: re.search(r"(^|/)application\.ya?ml$", e.file)),
        ("DB migration changed", lambda e: re.search(r"(^|/)db/migration/", e.file)),
        ("Dockerfile changed", lambda e: re.search(r"(^|/)(Dockerfile|.*\.Dockerfile)$", e.file)),
        ("CI config changed", lambda e: re.search(r"(^\.github/workflows/|^\.gitlab-ci\.ya?ml$|(^|/)Jenkinsfile$|^azure-pipelines\.ya?ml$|^\.circleci/|^bitbucket-pipelines\.ya?ml$)", e.file)),
        ("High-risk path changed", lambda e: _has_high_risk_path(e.file)),
        ("Deleted files", lambda e: "D" in e.status),
    ]
    findings = {
        category: [entry.file for entry in entries if matcher(entry)]
        for category, matcher in checks
    }
    findings = {category: files for category, files in findings.items() if files}
    if len(entries) > max_changed:
        findings[f"Excessive file changes ({len(entries)} > {max_changed})"] = [entry.file for entry in entries]
    return findings


def test_push_policy_scan_is_wired_for_git_push_gate():
    gates = GATES.read_text(encoding="utf-8")
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8") + TOOL_CALL_GATE.read_text(encoding="utf-8")

    for needle in [
        "export function scanPushPolicy",
        "build\\.gradle(\\.kts)?|pom\\.xml",
        "application\\.ya?ml",
        "db\\/migration\\/",
        "Dockerfile|.*\\.Dockerfile",
        "github\\/workflows",
        "High-risk path changed",
        "auth",
        "schema.prisma",
        "Deleted files",
        "Excessive file changes",
        "HARNESS_POLICY_MAX_CHANGED_FILES",
    ]:
        assert needle in gates

    assert 'consumeSkipToken("policy-scan")' in workflow
    assert 'consumeSkipToken("push-review")' not in workflow
    assert 'Workflow Transition History' in workflow
    assert "ctx.ui.confirm(" in workflow
    assert "Push policy scan 승인 확인" in workflow
    assert "예: 현재 workspace 상태를 승인하고 push합니다." in workflow
    assert "아니오: push를 차단합니다." in workflow
    assert "gateFailures" in workflow
    assert "state.gateFailures.set" in workflow
    assert "/workflow skip policy-scan <사유>" in workflow


def _has_high_risk_path(file: str) -> bool:
    high_risk_segments = {
        "auth", "authentication", "authorization", "oauth",
        "password", "secret", "secrets", "credential", "credentials",
        "token", "tokens", "session", "sessions", "permission", "permissions",
        "security", "crypto", "encryption",
    }
    high_risk_filenames = {"schema.prisma"}
    segments = [segment.lower() for segment in file.split("/") if segment]
    filename = segments[-1] if segments else ""
    return filename in high_risk_filenames or any(segment in high_risk_segments for segment in segments)


def test_push_policy_scan_categories_match_requested_risky_files():
    findings = _mirror_policy_scan([
        " M build.gradle",
        " M service/pom.xml",
        " M src/main/resources/application.yml",
        " M src/main/resources/db/migration/V2__add_table.sql",
        " M Dockerfile",
        " M .github/workflows/ci.yml",
        " D src/main/java/com/acme/OldService.java",
    ])

    assert findings["Build descriptor changed"] == ["build.gradle", "service/pom.xml"]
    assert findings["Application config changed"] == ["src/main/resources/application.yml"]
    assert findings["DB migration changed"] == ["src/main/resources/db/migration/V2__add_table.sql"]
    assert findings["Dockerfile changed"] == ["Dockerfile"]
    assert findings["CI config changed"] == [".github/workflows/ci.yml"]
    assert findings["Deleted files"] == ["src/main/java/com/acme/OldService.java"]


def test_push_policy_scan_flags_excessive_file_count():
    findings = _mirror_policy_scan([f" M src/File{i}.java" for i in range(31)], max_changed=30)
    assert "Excessive file changes (31 > 30)" in findings


def test_push_policy_scan_flags_high_risk_paths():
    findings = _mirror_policy_scan([
        " M src/main/java/com/acme/auth/LoginService.java",
        " M src/main/java/com/acme/session/SessionStore.java",
        " M src/main/java/com/acme/security/CryptoConfig.java",
        " M prisma/schema.prisma",
    ])

    assert findings["High-risk path changed"] == [
        "src/main/java/com/acme/auth/LoginService.java",
        "src/main/java/com/acme/session/SessionStore.java",
        "src/main/java/com/acme/security/CryptoConfig.java",
        "prisma/schema.prisma",
    ]
