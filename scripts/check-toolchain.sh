#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$root/integration_tests/smoke"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/nettle-toolchain.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

for tool in slang yosys; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'ERROR: required executable %q was not found on PATH\n' "$tool" >&2
    exit 1
  fi
done

slang --version
yosys -V

printf '%s\n' \
  "filelist: \"$fixture/project.f\"" \
  "project_root: \"$fixture\"" \
  'top: top' \
  'output: smoke.nettle' \
  >"$scratch/build.yaml"

cargo run --quiet --release --manifest-path "$root/Cargo.toml" -- build \
  --config "$scratch/build.yaml"

cargo run --quiet --release --manifest-path "$root/Cargo.toml" -- \
  validate "$scratch/smoke.nettle"

cargo run --quiet --release --manifest-path "$root/Cargo.toml" -- \
  inspect "$scratch/smoke.nettle"

printf 'Nettle toolchain smoke passed: YAML configured, compiled, bundled, validated, and inspected smoke.nettle.\n'
