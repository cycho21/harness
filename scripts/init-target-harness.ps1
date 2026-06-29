<#
.SYNOPSIS
Initialize harness into the current project directory from the harness git remote.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\init-target-harness.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\init-target-harness.ps1 https://github.com/chochanyeon/harness.git -Dest C:\work\my-project -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Repo = "https://github.com/chochanyeon/harness.git",

    [Parameter(Position = 1)]
    [string]$Dest = $(if ($env:HARNESS_DEST) { $env:HARNESS_DEST } else { (Get-Location).Path }),

    [string]$Ref = "",

    [string]$SourceSubdir = "target",

    [switch]$Force,

    [switch]$Clean,

    [switch]$DryRun,

    [ValidateSet("all", "workflow", "memory")]
    [string[]]$Component = @("all"),

    [switch]$KeepTemp
)
# Note: A shared Stanford CoreNLP Docker container is started automatically
# when the workflow component is selected. Requires Docker Desktop.
# To skip, omit the workflow component: -Component memory

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$ExcludeDirs = @("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", ".cache")
$ExcludeFiles = @(".DS_Store")

function Assert-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Get-RelativePath([string]$Base, [string]$Path) {
    $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $baseUri = New-Object System.Uri(($baseFull + [System.IO.Path]::DirectorySeparatorChar))
    $pathUri = New-Object System.Uri($pathFull)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Get-ComponentRoots([string]$ComponentName) {
    switch ($ComponentName) {
        "workflow" { return @("AGENTS.md", ".pi/.gitignore", ".pi/LOCAL.md", ".pi/WORKFLOW.md", ".pi/GOVERNANCE.md", ".pi/extensions/workflow.ts", ".pi/extensions/assistant-markdown-box.ts", ".pi/extensions/workflow", ".harness/workflow-policy.json", ".ai/interview", ".pi/dpaa", ".pi/workflows", ".pi/skills", ".pi/personas", ".pi/themes", ".pi/pyproject.toml", ".pi/schemas/harness-field-log-event.schema.json", ".pi/sbadr", ".pi/corenlp", ".pi/setup_corenlp.sh", ".pi/setup_corenlp.ps1") }
        "memory" { return @("AGENTS.md", ".pi/.gitignore", ".pi/LOCAL.md", ".pi/extensions/memory.ts", ".pi/schemas/harness-memory-entry.schema.json") }
    }
}

function Get-SelectedComponentRoots {
    $components = $Component
    if ($components -contains "all") { $components = @("workflow", "memory") }
    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($componentName in $components) {
        foreach ($root in (Get-ComponentRoots $componentName)) { $roots.Add($root) }
    }
    return $roots | Select-Object -Unique
}

function Test-ComponentSelected([string]$Rel) {
    $normalized = $Rel.Replace('\', '/')
    $components = $Component
    if ($components -contains "all") { $components = @("workflow", "memory") }

    foreach ($componentName in $components) {
        $roots = Get-ComponentRoots $componentName
        foreach ($root in $roots) {
            if ($normalized -eq $root -or $normalized.StartsWith($root.TrimEnd('/') + "/")) { return $true }
        }
    }
    return $false
}

function Test-PreserveOnClean([string]$Rel) {
    $normalized = $Rel.Replace('\', '/')
    foreach ($root in @("AGENTS.md", ".pi/LOCAL.md", ".ai/interview")) {
        if ($normalized -eq $root -or $normalized.StartsWith($root.TrimEnd('/') + "/")) { return $true }
    }
    return $false
}

function Test-Excluded([System.IO.FileSystemInfo]$Item, [string]$Root) {
    $rel = Get-RelativePath $Root $Item.FullName
    $parts = $rel -split '[\\/]+'

    foreach ($part in $parts) {
        if (($ExcludeDirs -contains $part) -or $part.EndsWith(".egg-info")) { return $true }
    }

    if (-not $Item.PSIsContainer -and ($ExcludeFiles -contains $Item.Name)) { return $true }
    return $false
}

Assert-Command git

$destPath = [System.IO.Path]::GetFullPath($Dest)
if (-not (Test-Path -LiteralPath $destPath)) {
    if ($DryRun) {
        Write-Host "dest directory would be created: $destPath"
    } else {
        New-Item -ItemType Directory -Path $destPath | Out-Null
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-" + [System.Guid]::NewGuid().ToString("N"))
$cloneDir = Join-Path $tempRoot "repo"

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null

    Write-Host "repo:   $Repo"
    Write-Host "dest:   $destPath"
    if ($Ref) { Write-Host "ref:    $Ref" }
    Write-Host ("components: {0}" -f ($Component -join ", "))
    if ($DryRun) { Write-Host "mode:   dry-run" }
    if ($Clean) { Write-Host "mode:   clean reinstall (managed runtime paths only)" }

    $cloneArgs = @("clone", "--depth", "1")
    if ($Ref) { $cloneArgs += @("--branch", $Ref) }
    $cloneArgs += @($Repo, $cloneDir)

    & git @cloneArgs
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }

    $source = Join-Path $cloneDir $SourceSubdir
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Source template directory not found in repo: $SourceSubdir"
    }

    if ($Clean) {
        $preserveOnClean = @("AGENTS.md", ".pi/LOCAL.md", ".ai/interview")
        foreach ($root in (Get-SelectedComponentRoots)) {
            $normalizedRoot = $root.Replace('\\', '/')
            if ($preserveOnClean -contains $normalizedRoot) {
                Write-Host ("preserve   {0}" -f $root)
                continue
            }
            $targetRoot = Join-Path $destPath $root
            if (Test-Path -LiteralPath $targetRoot) {
                Write-Host ("clean      {0}" -f $root)
                if (-not $DryRun) { Remove-Item -LiteralPath $targetRoot -Recurse -Force }
            }
        }
    }

    $copied = 0
    $skipped = 0
    $overwritten = 0

    Get-ChildItem -LiteralPath $source -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
        if (Test-Excluded $_ $source) { return }

        $rel = Get-RelativePath $source $_.FullName
        if (-not (Test-ComponentSelected $rel)) { return }
        $target = Join-Path $destPath $rel
        $exists = Test-Path -LiteralPath $target

        if ($exists -and (($Clean -and (Test-PreserveOnClean $rel)) -or (-not ($Force -or $Clean)))) {
            Write-Host ("skip       {0}" -f $rel)
            $script:skipped++
            return
        }

        $action = if ($exists) { "overwrite" } else { "copy" }
        Write-Host ("{0,-10} {1}" -f $action, $rel)

        if (-not $DryRun) {
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Path $parent | Out-Null
            }
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force:($Force -or $Clean)
        }

        if ($exists) { $script:overwritten++ } else { $script:copied++ }
    }

    Write-Host ""
    Write-Host ("Done. copied={0} overwritten={1} skipped={2}" -f $copied, $overwritten, $skipped)

    # Install Stanford CoreNLP if workflow component was selected
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
                Write-Warning "CoreNLP installation failed: $_. Run .pi\setup_corenlp.ps1 manually to retry."
            }
        }
    }

    Write-Host "Next: run 'pi' from the destination project root."
}
finally {
    if ($KeepTemp) {
        Write-Host "temp kept: $tempRoot"
    } elseif (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
