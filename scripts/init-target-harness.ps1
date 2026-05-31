<#
.SYNOPSIS
Initialize harness into the current project directory from the harness git remote.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\init-target-harness.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\init-target-harness.ps1 https://github.com/cycho21/harness.git -Dest C:\work\my-project -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Repo = "https://github.com/cycho21/harness.git",

    [Parameter(Position = 1)]
    [string]$Dest = (Get-Location).Path,

    [string]$Ref = "",

    [string]$SourceSubdir = "target",

    [switch]$Force,

    [switch]$DryRun,

    [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"
$ExcludeDirs = @("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache")
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

function Test-Excluded([System.IO.FileSystemInfo]$Item, [string]$Root) {
    $rel = Get-RelativePath $Root $Item.FullName
    $parts = $rel -split '[\\/]+'

    foreach ($part in $parts) {
        if ($ExcludeDirs -contains $part) { return $true }
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
    if ($DryRun) { Write-Host "mode:   dry-run" }

    $cloneArgs = @("clone", "--depth", "1")
    if ($Ref) { $cloneArgs += @("--branch", $Ref) }
    $cloneArgs += @($Repo, $cloneDir)

    & git @cloneArgs
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE" }

    $source = Join-Path $cloneDir $SourceSubdir
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Source template directory not found in repo: $SourceSubdir"
    }

    $copied = 0
    $skipped = 0
    $overwritten = 0

    Get-ChildItem -LiteralPath $source -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
        if (Test-Excluded $_ $source) { return }

        $rel = Get-RelativePath $source $_.FullName
        $target = Join-Path $destPath $rel
        $exists = Test-Path -LiteralPath $target

        if ($exists -and -not $Force) {
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
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force:$Force
        }

        if ($exists) { $script:overwritten++ } else { $script:copied++ }
    }

    Write-Host ""
    Write-Host ("Done. copied={0} overwritten={1} skipped={2}" -f $copied, $overwritten, $skipped)
    Write-Host "Next: run 'pi' from the destination project root."
}
finally {
    if ($KeepTemp) {
        Write-Host "temp kept: $tempRoot"
    } elseif (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
