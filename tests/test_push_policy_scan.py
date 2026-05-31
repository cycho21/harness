import re
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GATES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "gates.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


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


def test_push_policy_scan_is_wired_before_push_review_gate():
    gates = GATES.read_text(encoding="utf-8")
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8")

    for needle in [
        "export function scanPushPolicy",
        "build\\.gradle(\\.kts)?|pom\\.xml",
        "application\\.ya?ml",
        "db\\/migration\\/",
        "Dockerfile|.*\\.Dockerfile",
        "github\\/workflows",
        "Deleted files",
        "Excessive file changes",
        "HARNESS_POLICY_MAX_CHANGED_FILES",
    ]:
        assert needle in gates

    policy_index = workflow.index('consumeSkipToken("policy-scan")')
    review_index = workflow.index('consumeSkipToken("push-review")')
    assert policy_index < review_index, "policy scan must run before consuming the push-review token"
    assert 'ctx.ui.confirm(\n          "Push policy scan 승인 확인"' in workflow
    assert "예: 현재 git push를 계속 진행합니다." in workflow
    assert "아니오: git push를 차단하고 변경 검토를 요구합니다." in workflow
    assert "/workflow skip <dpaa|code-quality|push-review|policy-scan> <reason>" in workflow


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
