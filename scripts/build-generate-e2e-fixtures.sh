#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
xor_output="${NETTLE_GENERATE_XOR_FIXTURE:-/tmp/nettle-generate-xor.nettle}"
or_output="${NETTLE_GENERATE_OR_FIXTURE:-/tmp/nettle-generate-or.nettle}"
fixture="$root/integration_tests/generate"

build_fixture() {
  local output="$1"
  local use_xor="$2"
  cargo run --quiet --release --offline --manifest-path "$root/Cargo.toml" -- build \
    --filelist "$fixture/project.f" \
    --project-root "$fixture" \
    --top top \
    --param "USE_XOR=$use_xor" \
    --output "$output"
  cargo run --quiet --release --offline --manifest-path "$root/Cargo.toml" -- validate "$output"
}

build_fixture "$xor_output" 1
build_fixture "$or_output" 0
