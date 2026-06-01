# harness

[한국어 README](README.md)

Pi workflow harness source repository.

Pi workflow runtime files are isolated under `target/` so developing the harness from this repository root does not automatically load the harness extension, skills, or context files. In an initialized project, only `AGENTS.md` and `.pi/` are placed at the project root; workflow internals, DPAA, and reference docs live under `.pi/`.

## Initialize in another project

From the target project's directory, run the one-liner for your OS.

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh
```

Then start Pi from the same project directory:

```powershell
pi
```

The initializer clones `https://github.com/cycho21/harness.git` into a temp directory, copies missing files from `target/`, then removes the temp clone. Existing files are skipped by default.

After initialization, self-check the install:

```text
/workflow doctor
```

DPAA dependencies are installed automatically into `.pi/.venv/` the first time the DPAA gate runs. The generated venv is ignored by `.pi/.gitignore`.

SBADR (Score-Based Ambiguity Detector and Resolver, ICSME 2020) is installed alongside DPAA under `.pi/sbadr/`. It detects syntactic ambiguity in English plan documents using Stanford CoreNLP dependency parsing (PP attachment, coordination scope, analytical, noun-phrase stacking). CoreNLP is installed automatically on the first gate run. To install manually:

```bash
# macOS/Linux
bash .pi/setup_corenlp.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .pi/setup_corenlp.ps1
```

Requires Java 17+ and downloads ~500 MB. DPAA and SBADR are complementary: DPAA covers multi-layer plan quality (structural, referential, temporal, verification) in a rule-based, server-free way; SBADR adds deep syntactic NLP analysis for English text.

Harness failures are logged locally under `.project-memory/harness/events.jsonl` when gates block or are explicitly skipped. Review and export redacted logs with:

```text
/workflow failures
/workflow failures export
```

External memory is stored separately under `.project-memory/memory/`. It starts as a small, user-governed memory layer: manually remember durable facts, search/list them, disable incorrect entries, and inspect what was injected into the prompt. Retrieval/injection tracking is recorded as ids/hashes/counts rather than raw prompts. The extension also adds `.project-memory/` to `.git/info/exclude` on first write so local memory is not accidentally committed.

Current MVP commands:

```text
/memory remember <durable project fact or decision>
/memory list
/memory search <query>
/memory explain
/memory stats
/memory feedback <id> helpful|irrelevant|wrong|stale
```

Planned later: candidate extraction, approve/reject workflow, merge/supersede, export, and AGENTS.md promotion. These are intentionally not automatic in the MVP.

Install only one component when needed:

```bash
# workflow only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component workflow

# memory only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component memory
```

Optional arguments:

Windows PowerShell:

```powershell
# Preview only
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -DryRun

# Use a specific branch/tag
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Ref main

# Overwrite existing files intentionally
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Force

# Install only one component
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Component memory
```

macOS/Linux:

```bash
# Preview only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --dry-run

# Use a specific branch/tag
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --ref main

# Overwrite existing files intentionally
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --force

# Install only one component
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component memory
```

## Update an installed harness

Run from the project root.

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'update-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh
```

Updates overwrite upstream-managed harness runtime files only. Project-owned files such as `AGENTS.md`, `.pi/config/`, and `.pi/local/` are preserved.

Update only one component when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component workflow
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component memory
```

## Customization boundary

**Dependencies:**

| Dependency | Purpose | Notes |
|---|---|---|
| Python 3.10+ | DPAA, SBADR | venv auto-created by harness |
| Java 17+ | SBADR (CoreNLP) | CoreNLP auto-installed on first gate run |
| git | workflow | required |

- Upstream-managed: `.pi/extensions/`, `.pi/dpaa/`, `.pi/sbadr/`, `.pi/setup_corenlp.sh`, `.pi/setup_corenlp.ps1`, `.pi/workflows/`, `.pi/skills/`, `.pi/personas/`, `.pi/WORKFLOW.md`, `.pi/GOVERNANCE.md`, `.pi/pyproject.toml`, `.pi/schemas/`
- Project-owned: `AGENTS.md`, `.pi/config/`, `.pi/local/`, `.pi/LOCAL.md`
- Generated/ignored: `.pi/.venv/`, `.pi/.cache/`, `.pi/dpaa-runs/`

See `.pi/LOCAL.md` after initialization for the same boundary inside the project.

## Preview the bundled target template

`target/` is the template that gets copied into another project. To preview that template locally without initializing another repository:

```powershell
cd target
pi
```

For normal usage, run the initializer from the project you want to equip with the harness, then run `pi` from that project root.

Key runtime entrypoints:

- `target/AGENTS.md`
- `target/.pi/WORKFLOW.md`
- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/memory.ts`
- `target/.pi/skills/`
- `target/.pi/personas/`
- `target/.pi/GOVERNANCE.md`
- `target/.pi/dpaa/`
- `target/.pi/sbadr/`
- `target/.pi/setup_corenlp.sh`
- `target/.pi/pyproject.toml`
- `target/.pi/workflows/`
- `target/.pi/schemas/harness-field-log-event.schema.json`
- `target/.pi/schemas/harness-memory-entry.schema.json`
