<#
.SYNOPSIS
Update upstream-managed harness runtime files in the current project.
#>

[CmdletBinding()]
param(
    [string]$Repo = "https://github.com/chochanyeon/harness.git",
    [string]$Dest = (Get-Location).Path,
    [string]$Ref = "",
    [ValidateSet("all", "workflow", "memory")]
    [string[]]$Component = @("all"),
    [switch]$DryRun,
    [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
function Get-ManagedPaths {
    $components = $Component
    if ($components -contains "all") { $components = @("workflow", "memory") }
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($componentName in $components) {
        switch ($componentName) {
            "workflow" {
                @(
                    ".pi/.gitignore",
                    ".pi/WORKFLOW.md",
                    ".pi/GOVERNANCE.md",
                    ".pi/extensions/workflow.ts",
                    ".pi/extensions/assistant-markdown-box.ts",
                    ".pi/extensions/workflow",
                    ".harness/workflow-policy.json",
                    ".pi/dpaa",
                    ".pi/sbadr",
                    ".pi/corenlp",
                    ".pi/setup_corenlp.sh",
                    ".pi/setup_corenlp.ps1",
                    ".pi/workflows",
                    ".pi/skills",
                    ".pi/personas",
                    ".pi/themes",
                    ".pi/pyproject.toml",
                    ".pi/schemas/harness-field-log-event.schema.json"
                ) | ForEach-Object { $paths.Add($_) }
            }
            "memory" {
                @(
                    ".pi/.gitignore",
                    ".pi/extensions/memory.ts",
                    ".pi/schemas/harness-memory-entry.schema.json"
                ) | ForEach-Object { $paths.Add($_) }
            }
        }
    }
    return $paths | Select-Object -Unique
}
$ExcludeDirs = @("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", ".cache")
$ExcludeFiles = @(".DS_Store")

function Assert-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Required command not found: $Name" }
}

function Get-RelativePath([string]$Base, [string]$Path) {
    $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $baseUri = New-Object System.Uri(($baseFull + [System.IO.Path]::DirectorySeparatorChar))
    $pathUri = New-Object System.Uri($pathFull)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Test-Excluded([System.IO.FileSystemInfo]$Item, [string]$Root) {
    $rel = Get-RelativePath $Root $Item.FullName
    $parts = $rel -split '[\\/]+'
    foreach ($part in $parts) { if (($ExcludeDirs -contains $part) -or $part.EndsWith(".egg-info")) { return $true } }
    if (-not $Item.PSIsContainer -and ($ExcludeFiles -contains $Item.Name)) { return $true }
    return $false
}

Assert-Command git
$destPath = [System.IO.Path]::GetFullPath($Dest)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-update-" + [System.Guid]::NewGuid().ToString("N"))
$cloneDir = Join-Path $tempRoot "repo"

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    Write-Host "repo:   $Repo"
    Write-Host "dest:   $destPath"
    if ($Ref) { Write-Host "ref:    $Ref" }
    Write-Host ("components: {0}" -f ($Component -join ", "))
    if ($DryRun) { Write-Host "mode:   dry-run" }

    $cloneArgs = @("clone", "--depth", "1")
    if ($Ref) { $cloneArgs += @("--branch", $Ref) }
    $cloneArgs += @($Repo, $cloneDir)
    & git @cloneArgs
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }

    $template = Join-Path $cloneDir "target"
    if (-not (Test-Path -LiteralPath $template -PathType Container)) {
        throw "Template directory not found in cloned repo: target"
    }
    $managedPathCount = 0
    $updated = 0
    foreach ($managed in (Get-ManagedPaths)) {
        $source = Join-Path $template $managed
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $managedPathCount++

        if ((Get-Item -LiteralPath $source).PSIsContainer) {
            $targetRoot = Join-Path $destPath $managed
            if (Test-Path -LiteralPath $targetRoot) {
                Write-Host ("clean      {0}" -f $managed)
                if (-not $DryRun) { Remove-Item -LiteralPath $targetRoot -Recurse -Force }
            }
            Get-ChildItem -LiteralPath $source -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
                if (Test-Excluded $_ $template) { return }
                $rel = Get-RelativePath $template $_.FullName
                $target = Join-Path $destPath $rel
                Write-Host ("update     {0}" -f $rel)
                if (-not $DryRun) {
                    $parent = Split-Path -Parent $target
                    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
                    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
                }
                $script:updated++
            }
        } else {
            $target = Join-Path $destPath $managed
            Write-Host ("update     {0}" -f $managed)
            if (-not $DryRun) {
                $parent = Split-Path -Parent $target
                if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
                Copy-Item -LiteralPath $source -Destination $target -Force
            }
            $updated++
        }
    }

    $localSource = Join-Path $template ".pi/LOCAL.md"
    $localTarget = Join-Path $destPath ".pi/LOCAL.md"
    if ((Test-Path -LiteralPath $localSource) -and -not (Test-Path -LiteralPath $localTarget)) {
        Write-Host "seed       .pi/LOCAL.md"
        if (-not $DryRun) {
            $parent = Split-Path -Parent $localTarget
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
            Copy-Item -LiteralPath $localSource -Destination $localTarget
        }
        $updated++
    }

    if ($managedPathCount -eq 0) {
        throw "No managed harness paths were found in template. Check -Repo, -Ref, and target/ contents."
    }

    Write-Host ""
    Write-Host ("Done. updated={0}" -f $updated)
    Write-Host "Project-owned paths were preserved: AGENTS.md, .pi/config/, .pi/local/, .pi/LOCAL.md."

    $includesWorkflow = $Component -contains "all" -or $Component -contains "workflow"
    if (-not $DryRun -and $includesWorkflow) {
        $corenlpScript = Join-Path $destPath ".pi\setup_corenlp.ps1"
        if (Test-Path -LiteralPath $corenlpScript) {
            Write-Host ""
            Write-Host "Starting shared CoreNLP Docker container..."
            try {
                & powershell -NoProfile -ExecutionPolicy Bypass -File $corenlpScript
                if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
            } catch {
                Write-Warning "CoreNLP startup failed: $_. Run .pi\setup_corenlp.ps1 manually to retry."
            }
        }
    }
}
finally {
    if ($KeepTemp) { Write-Host "temp kept: $tempRoot" }
    elseif (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
