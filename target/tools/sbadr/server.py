"""Stanford CoreNLP server lifecycle management."""

from __future__ import annotations

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CORENLP_PORT = 9000
CORENLP_HOST = "localhost"
_READY_TIMEOUT = 60  # seconds
_POLL_INTERVAL = 1.0


def _corenlp_dir() -> Path:
    tools_root = Path(__file__).parent.parent
    return tools_root / "corenlp"


def find_jar() -> Path | None:
    """Return path to stanford-corenlp-*.jar, or None if not installed."""
    for jar in _corenlp_dir().glob("stanford-corenlp-*.jar"):
        if "javadoc" not in jar.name and "sources" not in jar.name:
            return jar
    return None


def find_models_jar() -> Path | None:
    for jar in _corenlp_dir().glob("stanford-corenlp-*-models-english.jar"):
        return jar
    # fall back to any models jar
    for jar in _corenlp_dir().glob("stanford-corenlp-*-models.jar"):
        return jar
    return None


def is_running() -> bool:
    url = f"http://{CORENLP_HOST}:{CORENLP_PORT}/"
    try:
        with urllib.request.urlopen(url, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def start(quiet: bool = True) -> subprocess.Popen | None:
    """Start CoreNLP server as a background process.

    Returns the Popen object, or None if already running.
    """
    if is_running():
        return None

    jar = find_jar()
    if jar is None:
        raise RuntimeError(
            "Stanford CoreNLP not found. Run tools/setup_corenlp.sh first."
        )

    models = find_models_jar()
    sep = ";" if sys.platform == "win32" else ":"
    classpath = str(jar)
    if models:
        classpath += f"{sep}{models}"

    cmd = [
        "java",
        "-Xmx4g",
        "-cp",
        classpath,
        "edu.stanford.nlp.pipeline.StanfordCoreNLPServer",
        "-port",
        str(CORENLP_PORT),
        "-timeout",
        "30000",
        "-threads",
        "4",
        "-quiet",
        "true" if quiet else "false",
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.DEVNULL if quiet else None,
    )
    _wait_ready(proc)
    return proc


def _wait_ready(proc: subprocess.Popen) -> None:
    deadline = time.time() + _READY_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"CoreNLP server exited unexpectedly (rc={proc.returncode})")
        if is_running():
            return
        time.sleep(_POLL_INTERVAL)
    proc.kill()
    raise TimeoutError(f"CoreNLP server did not start within {_READY_TIMEOUT}s")


def stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def ensure_running() -> subprocess.Popen | None:
    """Start CoreNLP server if not already running. Returns Popen or None."""
    if is_running():
        return None
    print("Starting Stanford CoreNLP server...", file=sys.stderr)
    proc = start()
    print(f"CoreNLP server ready on port {CORENLP_PORT}", file=sys.stderr)
    return proc
