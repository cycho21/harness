# harness

Pi workflow harness source repository.

Pi workflow runtime files are isolated under `target/` so developing the harness from this repository root does not automatically load the harness extension, skills, or context files. DPAA and workflow reference docs are part of the workflow runtime and stay in `target/`; tests, analysis notes, and reference docs live at the repository root.

## Initialize in another project

From the target project's directory, run this one-liner in Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

Then start Pi from the same project directory:

```powershell
pi
```

The initializer clones `https://github.com/cycho21/harness.git` into a temp directory, copies missing files from `target/`, then removes the temp clone. Existing files are skipped by default.

Optional arguments:

```powershell
# Preview only
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p -DryRun

# Use a specific branch/tag
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Ref main

# Overwrite existing files intentionally
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Force
```

## Run the harness inside this repository

```powershell
cd target
pi
```

Key runtime entrypoints:

- `target/AGENTS.md`
- `target/WORKFLOW.md`
- `target/.pi/extensions/workflow.ts`
- `target/.pi/skills/`
- `target/.pi/personas/`
- `target/.pi/GOVERNANCE.md`
- `target/dpaa/`
- `target/pyproject.toml`
- `target/workflows/`
