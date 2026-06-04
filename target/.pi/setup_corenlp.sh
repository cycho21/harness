#!/usr/bin/env bash
# setup_corenlp.sh — Start shared Stanford CoreNLP Docker container
#
# Builds a local Docker image on first run (~500 MB, cached by Docker).
# All subsequent runs and other projects reuse the cached image.
# Safe to run multiple times — exits early if already running.

set -euo pipefail

CONTAINER_NAME="corenlp"
IMAGE_NAME="corenlp-local"
PORT="${CORENLP_PORT:-9000}"
MEMORY="${CORENLP_MEMORY:-6g}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCKERFILE_DIR="${SCRIPT_DIR}/corenlp"

echo "\u2500\u2500 Stanford CoreNLP Shared Server \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
echo "  Container : ${CONTAINER_NAME}"
echo "  Port      : ${PORT}"
echo "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"

port_in_use() {
  (echo >"/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1
}

if ! command -v docker &>/dev/null; then
  echo "Error: docker not found. Install Docker Desktop and retry." >&2
  exit 1
fi

# Build local image if not yet built (one-time, ~500 MB)
if ! docker image inspect "${IMAGE_NAME}" &>/dev/null; then
  echo "Building CoreNLP Docker image (one-time ~500 MB download)..."
  docker build -t "${IMAGE_NAME}" "${DOCKERFILE_DIR}"
fi

# Already running?
if docker ps --filter "name=^${CONTAINER_NAME}$" --format "{{.Names}}" 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  echo "CoreNLP already running at http://localhost:${PORT}"
  exit 0
fi

# If another process already owns the port, do not fail the whole harness install.
# This commonly happens when another project already started CoreNLP, or when a
# local service is using 9000. Users can override with CORENLP_PORT=9001.
if port_in_use; then
  echo "Warning: port ${PORT} is already in use. Skipping CoreNLP container creation/start." >&2
  echo "If this is an existing CoreNLP server, use: CORENLP_URL=http://localhost:${PORT}"
  echo "To start a separate container, set CORENLP_PORT to a free port, e.g. 9001."
  exit 0
fi

# Container exists but stopped -> start it
if docker ps -a --filter "name=^${CONTAINER_NAME}$" --format "{{.Names}}" 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  echo "Starting existing container ${CONTAINER_NAME}..."
  docker start "${CONTAINER_NAME}"
else
  echo "Creating CoreNLP container..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${PORT}:9000" \
    -m "${MEMORY}" \
    --restart unless-stopped \
    "${IMAGE_NAME}"
fi

echo "CoreNLP server started at http://localhost:${PORT}"
echo ""
echo "Connect from projects via: CORENLP_URL=http://localhost:${PORT}"
