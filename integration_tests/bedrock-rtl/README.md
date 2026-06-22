<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bedrock-RTL test and demo corpus

Run every command in this guide from the repository root.

This manifest selects seven self-contained, synthesizable SystemVerilog designs
and one generated synthesized-netlist regression from Bedrock-RTL. The upstream
RTL and generated netlist are not checked into Nettle.

## Third-party boundary and provenance

The runner sparse-checks out the required top-level library directories from
[`xlsynth/bedrock-rtl`](https://github.com/xlsynth/bedrock-rtl) at commit
`dff5689eda7d5d0f74404d595fa8994889259fc1`. The manifest also identifies the
upstream `LICENSE`; no upstream source or license copy is stored here.

The subset is the dependency union for `br_counter`,
`br_enc_priority_encoder`, `br_amba_axil2apb`, `br_flow_xbar_rr`,
`br_cdc_fifo_flops`, `br_ram_flops`, and
`br_tracker_reorder_buffer_flops`. The files were selected from the dependency
relationships in the upstream Bazel `verilog_library` targets. The runner uses
the upstream files without modification.

`br_gate_mock.sv` and `br_mux_bin_structured_gates_mock.sv` are upstream
simulation models used to elaborate the CDC FIFO. Do not use them as
implementation cells for synthesis.

Everything in this directory is Nettle-owned integration infrastructure:
filelists, the manifest, the synthesis script, and this README. The generated
netlist remains an Apache-2.0 derivative of the upstream sources and exists only
in the runner workspace.

Each filelist contains its top module, include directory, and preprocessor
define. Paths inside the filelist are relative to the filelist itself because
the command uses Slang's `-F` option:

```sh
slang --std 1800-2017 --single-unit \
  -F target/design-corpora/bedrock-rtl/br_flow_xbar_rr.f
```

`manifest.json` lists the top, define set, representative parameter overrides,
feature coverage, expected visualization purpose, and an importer graph summary
for each example. A caller can append its `parameters` as Slang `-G Name=Value`
arguments.

Build the counter used by the main quickstart as a portable viewer input:

```sh
scripts/check-design-corpus.py --prepare-only --corpus bedrock-rtl \
  --workspace target/design-corpora
cargo run --locked -- build \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output /tmp/br_counter.nettle
```

Open the result in the static browser viewer. The example sources are embedded
in the bundle and are not served from this directory at viewing time.

### Synthesized CDC FIFO netlist

The runner produces a fully synthesized, flattened generic gate netlist for the
representative `Depth=5`, `Width=16`, `RegisterPopOutputs=1` CDC FIFO. The Yosys
recipe uses paths relative to the prepared corpus directory:

```sh
(
  cd target/design-corpora/bedrock-rtl
  yosys -Q -m slang -s scripts/synth_br_cdc_fifo_flops.ys
  sha256sum generated/br_cdc_fifo_flops_synth.v
)
```

Build and immediately view that structural input with:

```sh
cargo run --locked -- render \
  --filelist target/design-corpora/bedrock-rtl/br_cdc_fifo_flops_synth.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_cdc_fifo_flops \
  --output /tmp/br_cdc_fifo_flops_synth.nettle
```

The manifest pins the upstream commit, generator version, parameters, generated
netlist digest, generic cell count, and expected Nettle graph summary.

The generated netlist uses pinned OSS CAD Suite Yosys `0.66+91` (git
`8869ce61d`) with `Depth=5`, `Width=16`, and `RegisterPopOutputs=1`. The recipe
performs generic synthesis, hierarchy flattening, and ABC mapping, then strips
source attributes. The output SHA-256 is
`e1dc0a751e40f2b22f45b54bf710e3eb5f7648e0beba2e07412c29a11b295195`.

## Validation

Run the external-tool regression from the repository root:

```sh
npm run test:designs -- --corpus bedrock-rtl
```

On 2026-06-17, all seven RTL filelists elaborated and lowered at both their
default parameters and the representative parameter values in `manifest.json`
with:

- Slang `11.0.0+7ddf4059f`
- Yosys `0.66+91` with yosys-slang
- SystemVerilog `1800-2017`
- single compilation unit mode

All 14 variants emitted zero Slang diagnostics and produced hierarchical Yosys
JSON. Each imported successfully through Nettle's `ir` module and matched the
manifest's pinned module, node, edge, source-origin, and node-kind counts. The
tests needed no upstream source changes or compatibility patches. The runner
disables yosys-slang's implicit `SYNTHESIS` define so both compiler paths use
the same preprocessor state.

The regression first clones and verifies the manifest-pinned upstream checkout.
It then builds the counter (or the first explicitly selected example) twice
through `nettle build`, validates both bundles, and requires byte-for-byte
identical output. It generates and verifies the synthesized CDC FIFO, builds it
through `nettle render`, verifies the live health and no-store startup-bundle
routes, and leaves a bundle for the browser E2E suite when
`NETTLE_NETLIST_FIXTURE` is set.
