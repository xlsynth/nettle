#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Build the Nettle-owned structural diff bundles used by browser integration tests."""

import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "integration_tests/schematic-diff"


def run(command: list[str]) -> None:
    subprocess.run(command, cwd=ROOT, check=True)


def build(project: str, output: Path) -> None:
    project_root = FIXTURE_ROOT / project
    output.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "cargo",
            "run",
            "--quiet",
            "-p",
            "nettle",
            "--",
            "build",
            "--filelist",
            str(project_root / "project.f"),
            "--project-root",
            str(project_root),
            "--top",
            "top",
            "--output",
            str(output),
        ]
    )
    run(
        [
            "cargo",
            "run",
            "--quiet",
            "-p",
            "nettle",
            "--",
            "validate",
            str(output),
        ]
    )


def main() -> int:
    reference = os.environ.get("NETTLE_STRUCTURAL_REFERENCE_FIXTURE")
    candidate = os.environ.get("NETTLE_STRUCTURAL_CANDIDATE_FIXTURE")
    if reference is None or candidate is None:
        raise RuntimeError(
            "NETTLE_STRUCTURAL_REFERENCE_FIXTURE and "
            "NETTLE_STRUCTURAL_CANDIDATE_FIXTURE must be set"
        )
    build("reference", Path(reference).resolve())
    build("candidate", Path(candidate).resolve())
    print("Built and validated structural schematic diff browser fixtures")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
