# setup_corenlp.ps1 — Download Stanford CoreNLP for SBADR (Windows)
#
# Usage: powershell -ExecutionPolicy Bypass -File .pi/setup_corenlp.ps1
#
# Downloads ~500 MB. Requires Java 17+.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$CORENLP_VERSION = "4.5.7"
$CORENLP_ZIP     = "stanford-corenlp-$CORENLP_VERSION.zip"
$CORENLP_URL     = "https://nlp.stanford.edu/software/$CORENLP_ZIP"
$SCRIPT_DIR      = $PSScriptRoot
$DEST            = Join-Path $SCRIPT_DIR "corenlp"

Write-Host "── Stanford CoreNLP Setup ────────────────────────────────"
Write-Host "  Version : $CORENLP_VERSION"
Write-Host "  Dest    : $DEST"
Write-Host "─────────────────────────────────────────────────────────"

# Check Java
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    throw "java not found. Install Java 17+ and retry."
}
# java -version writes to stderr. Use cmd /c to capture it as plain text,
# avoiding PowerShell ErrorRecord / NativeCommandError issues entirely.
$javaVerRaw = cmd /c "java -version 2>&1"
$javaVer = ($javaVerRaw | Select-String '"(\d+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1)
if ([int]$javaVer -lt 17) {
    throw "Java 17+ required (found Java $javaVer)."
}

# Already installed?
if (Get-ChildItem -Path $DEST -Filter "stanford-corenlp-*.jar" -ErrorAction SilentlyContinue) {
    Write-Host "✅ CoreNLP already installed at $DEST"
    exit 0
}

New-Item -ItemType Directory -Path $DEST -Force | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("corenlp-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    Write-Host "Downloading CoreNLP $CORENLP_VERSION (~500 MB)..."
    Invoke-WebRequest -Uri $CORENLP_URL -OutFile (Join-Path $tmp $CORENLP_ZIP) -UseBasicParsing

    Write-Host "Extracting..."
    Expand-Archive -Path (Join-Path $tmp $CORENLP_ZIP) -DestinationPath $tmp -Force

    Write-Host "Installing JARs to $DEST..."
    Get-ChildItem -Path (Join-Path $tmp "stanford-corenlp-$CORENLP_VERSION") -Filter "*.jar" |
        Copy-Item -Destination $DEST -Force

    Write-Host ""
    Write-Host "✅ CoreNLP installed at $DEST"
    Write-Host ""
    Write-Host "Verify installation:"
    Write-Host "  sbadr server status"
    Write-Host "  sbadr server start"
} finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
