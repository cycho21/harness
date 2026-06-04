# setup_corenlp.ps1 — Start shared Stanford CoreNLP Docker container (Windows)
#
# Builds a local Docker image on first run (~500 MB, cached by Docker).
# All subsequent runs and other projects reuse the cached image.
# Safe to run multiple times — exits early if already running.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

$ContainerName = "corenlp"
$ImageName     = "corenlp-local"
$Port          = if ($env:CORENLP_PORT)   { $env:CORENLP_PORT }   else { "9000" }
$Memory        = if ($env:CORENLP_MEMORY) { $env:CORENLP_MEMORY } else { "6g" }
$ScriptDir     = $PSScriptRoot
$DockerfileDir = Join-Path $ScriptDir "corenlp"

Write-Host "Stanford CoreNLP Shared Server"
Write-Host "  Container : $ContainerName"
Write-Host "  Port      : $Port"

function Test-LocalPortInUse([int]$PortNumber) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $PortNumber, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(300, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found. Install Docker Desktop and retry."
}

# Build local image if not yet built (one-time, ~500 MB)
# docker images --quiet returns image ID if found, empty if not — no stderr, always exits 0
$imageId = docker images --quiet $ImageName 2>$null
if (-not $imageId) {
    Write-Host "Building CoreNLP Docker image (one-time ~500 MB download)..."
    docker build -t $ImageName $DockerfileDir
    if ($LASTEXITCODE -ne 0) { throw "docker build failed." }
}

# Already running?
$running = docker ps --filter "name=^${ContainerName}$" --format "{{.Names}}" 2>$null
if ($running -match "^${ContainerName}$") {
    Write-Host "CoreNLP already running at http://localhost:$Port"
    exit 0
}

# If another process already owns the port, do not fail the whole harness install.
# This commonly happens when another project already started CoreNLP, or when a
# local service is using 9000. Users can override with CORENLP_PORT=9001.
if (Test-LocalPortInUse ([int]$Port)) {
    Write-Warning "Port $Port is already in use. Skipping CoreNLP container creation/start."
    Write-Host "If this is an existing CoreNLP server, use: CORENLP_URL=http://localhost:$Port"
    Write-Host "To start a separate container, set CORENLP_PORT to a free port, e.g. 9001."
    exit 0
}

# Container exists but stopped -> start it
$exists = docker ps -a --filter "name=^${ContainerName}$" --format "{{.Names}}" 2>$null
if ($exists -match "^${ContainerName}$") {
    Write-Host "Starting existing container $ContainerName..."
    docker start $ContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker start failed." }
} else {
    Write-Host "Creating CoreNLP container..."
    docker run -d `
        --name $ContainerName `
        -p "${Port}:9000" `
        -m $Memory `
        --restart unless-stopped `
        $ImageName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker run failed." }
}

Write-Host "CoreNLP server started at http://localhost:$Port"
Write-Host ""
Write-Host "Connect from projects via: CORENLP_URL=http://localhost:$Port"
