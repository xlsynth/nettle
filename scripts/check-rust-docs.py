#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Require an inner doc comment after the SPDX header in every Rust source."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


def first_non_license_content_line(path: Path) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and stripped != "// SPDX-License-Identifier: Apache-2.0":
            return stripped
    return ""


def main() -> int:
    paths = [ROOT / "build.rs", *sorted((ROOT / "src").rglob("*.rs"))]
    missing = [
        path.relative_to(ROOT)
        for path in paths
        if not first_non_license_content_line(path).startswith("//!")
    ]
    if missing:
        for path in missing:
            print(
                f"ERROR: {path} must place a //! module doc comment after its SPDX header",
                file=sys.stderr,
            )
        return 1
    print(f"Validated module documentation in {len(paths)} Rust source files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
