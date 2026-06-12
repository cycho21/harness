#!/usr/bin/env python3
"""sync-dev-harness.py — copies target/.pi/ to .pi/ in the dev repo.

Preserves project-owned paths:
  .pi/config/, .pi/local/, .pi/LOCAL.md

Usage:
  python3 scripts/sync-dev-harness.py <src> <dest>
  bash scripts/sync-dev-harness.sh
  powershell -File scripts/sync-dev-harness.ps1
"""
import sys
import os
import shutil
from pathlib import Path

PRESERVE_NAMES = {"config", "local", "LOCAL.md"}


def sync(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)

    # Copy src → dest (overwrite)
    for item in src.rglob("*"):
        rel = item.relative_to(src)
        parts = rel.parts
        if parts and parts[0] in PRESERVE_NAMES:
            continue  # preserve project-owned paths
        target = dest / rel
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)

    # Remove dest files/dirs not in src (mirror), except preserved
    for item in list(dest.rglob("*")):
        rel = item.relative_to(dest)
        parts = rel.parts
        if parts and parts[0] in PRESERVE_NAMES:
            continue
        src_counterpart = src / rel
        if not src_counterpart.exists():
            if item.is_dir() and not any(item.iterdir()):
                item.rmdir()
            elif item.is_file():
                item.unlink()


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <src> <dest>", file=sys.stderr)
        sys.exit(1)
    src, dest = Path(sys.argv[1]), Path(sys.argv[2])
    if not src.exists():
        print(f"ERROR: src not found: {src}", file=sys.stderr)
        sys.exit(1)
    sync(src, dest)
    print(f"  synced {src} → {dest}")


if __name__ == "__main__":
    main()
