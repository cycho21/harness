# sync-dev-harness.ps1
# Syncs target\.pi\ -> .pi\ in the dev repo so the local harness reflects
# the current state of target\ without running update-harness.ps1 against GitHub.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\sync-dev-harness.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$src      = Join-Path $repoRoot "target\.pi"
$dest     = Join-Path $repoRoot ".pi"

if (-not (Test-Path $src)) {
    Write-Error "Source not found: $src"
    exit 1
}

Write-Host "Syncing $src -> $dest ..."

& python "$repoRoot\scripts\sync-dev-harness.py" $src $dest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done."
