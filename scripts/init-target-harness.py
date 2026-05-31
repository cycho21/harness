#!/usr/bin/env python3
"""Initialize the target harness into a project's current working directory.

Run this script from the project root that should receive the harness files:

    python /path/to/harness/scripts/init-target-harness.py

By default the script copies only missing files from this repository's ``target/``
template and never overwrites files that already exist in the destination.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
from typing import Iterable

DEFAULT_EXCLUDES = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".DS_Store",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def iter_files(source: Path) -> Iterable[Path]:
    for path in sorted(source.rglob("*")):
        if any(part in DEFAULT_EXCLUDES for part in path.parts):
            continue
        if path.is_file():
            yield path


def is_relative_to(path: Path, other: Path) -> bool:
    try:
        path.relative_to(other)
        return True
    except ValueError:
        return False


def copy_harness(source: Path, dest: Path, *, force: bool, dry_run: bool) -> tuple[int, int, int]:
    copied = skipped = overwritten = 0
    source = source.resolve()
    dest = dest.resolve()

    if not source.exists() or not source.is_dir():
        raise SystemExit(f"Source template directory not found: {source}")
    if source == dest:
        raise SystemExit("Destination is the source target/ directory; choose a project root instead.")
    if is_relative_to(source, dest):
        raise SystemExit("Refusing to initialize into a parent of the source template directory.")

    for src in iter_files(source):
        rel = src.relative_to(source)
        dst = dest / rel

        if dst.exists() and not force:
            print(f"skip       {rel}")
            skipped += 1
            continue

        action = "overwrite" if dst.exists() else "copy"
        print(f"{action:<10} {rel}")

        if not dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

        if action == "overwrite":
            overwritten += 1
        else:
            copied += 1

    return copied, skipped, overwritten


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy the company target harness template into a project cwd."
    )
    parser.add_argument(
        "--dest",
        type=Path,
        default=Path.cwd(),
        help="Project root to initialize (default: current working directory).",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=repo_root() / "target",
        help="Harness template directory (default: repository target/).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing destination files. Default is to skip them.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned changes without writing files.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    dest = args.dest.resolve()
    source = args.source.resolve()

    print(f"source: {source}")
    print(f"dest:   {dest}")
    if args.dry_run:
        print("mode:   dry-run")

    copied, skipped, overwritten = copy_harness(
        source,
        dest,
        force=args.force,
        dry_run=args.dry_run,
    )

    print(
        f"\nDone. copied={copied} overwritten={overwritten} skipped={skipped}"
    )
    print("Next: run `pi` from the destination project root.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
