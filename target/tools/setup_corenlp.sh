#!/usr/bin/env bash
# setup_corenlp.sh — Download Stanford CoreNLP for SBADR
#
# Usage: bash tools/setup_corenlp.sh
#
# Downloads ~500 MB. Requires curl and Java 17+.

set -euo pipefail

CORENLP_VERSION="4.5.7"
CORENLP_ZIP="stanford-corenlp-${CORENLP_VERSION}.zip"
CORENLP_URL="https://nlp.stanford.edu/software/${CORENLP_ZIP}"
TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${TOOLS_DIR}/corenlp"

echo "── Stanford CoreNLP Setup ────────────────────────────────"
echo "  Version : ${CORENLP_VERSION}"
echo "  Dest    : ${DEST}"
echo "─────────────────────────────────────────────────────────"

# Check Java
if ! command -v java &>/dev/null; then
  echo "Error: java not found. Install Java 17+ and retry." >&2
  exit 1
fi
JAVA_VER=$(java -version 2>&1 | head -1 | grep -oE '[0-9]+' | head -1)
if [ "${JAVA_VER}" -lt 17 ]; then
  echo "Error: Java 17+ required (found Java ${JAVA_VER})." >&2
  exit 1
fi

# Already installed?
if ls "${DEST}"/stanford-corenlp-*.jar &>/dev/null 2>&1; then
  echo "✅ CoreNLP already installed at ${DEST}"
  exit 0
fi

mkdir -p "${DEST}"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading CoreNLP ${CORENLP_VERSION}..."
curl -L --progress-bar -o "${TMP}/${CORENLP_ZIP}" "${CORENLP_URL}"

echo "Extracting..."
unzip -q "${TMP}/${CORENLP_ZIP}" -d "${TMP}"

# Move jars to dest
find "${TMP}/stanford-corenlp-${CORENLP_VERSION}" -name "*.jar" \
  -exec cp {} "${DEST}/" \;

echo "✅ CoreNLP installed at ${DEST}"
echo ""
echo "Verify installation:"
echo "  sbadr server status"
echo "  sbadr server start"
