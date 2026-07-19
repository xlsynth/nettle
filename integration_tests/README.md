<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nettle test and demo designs

Run every command in this guide from the repository root.

`integration_tests/` contains the manifests and Nettle-owned test inputs used
for integration testing and end-user demonstrations:

- `bedrock-rtl/`: seven parameterized infrastructure RTL examples plus a CDC
  FIFO synthesis and browser regression;
- `ibex/`: the complete production Ibex RISC-V CPU core;
- `opentitan/`: OpenTitan's AES cryptographic engine;
- `schematic-diff/`: Nettle-owned reference and candidate RTL projects that
  change ports, module instances, connectivity, and operator structure; and
- `generate/`: a parameterized Nettle-owned source-correlation fixture with a
  generate loop and mutually exclusive generate branches; and
- `smoke/`: a tiny Nettle-authored compiler smoke fixture.

No third-party HDL is stored in the Nettle source tree. Each corpus manifest
records an upstream Git repository, a full commit SHA, sparse-checkout paths,
and upstream license locations. The integration runner clones the repository,
checks out that exact SHA in an isolated workspace, and runs the Nettle-owned
filelists against the upstream paths. Update the manifest and README together
when changing a corpus pin.

Each source-tree corpus follows this ownership pattern:

```text
integration_tests/<corpus>/
├── <example>.f         # Nettle-owned compiler inputs
├── manifest.json       # machine-readable provenance and expectations
├── scripts/            # optional Nettle-owned generation recipes
└── README.md           # human-readable provenance and usage
```

The runner stages a selected corpus as:

```text
<workspace>/<corpus>/
├── <example>.f         # copied Nettle-owned inputs
├── <repository-name>/  # sparse checkout at source.commit
├── generated/          # generated test artifacts, never checked in
├── scripts/
└── manifest.json
```

## Demo entry points

| Demo                             | Filelist                                            | Top module          |
| -------------------------------- | --------------------------------------------------- | ------------------- |
| Bedrock-RTL counter              | `<workspace>/bedrock-rtl/br_counter.f`              | `br_counter`        |
| Bedrock-RTL synthesized CDC FIFO | `<workspace>/bedrock-rtl/br_cdc_fifo_flops_synth.f` | `br_cdc_fifo_flops` |
| Ibex CPU core                    | `<workspace>/ibex/ibex_core.f`                      | `ibex_core`         |
| OpenTitan AES cipher core        | `<workspace>/opentitan/aes_cipher_core.f`           | `aes_cipher_core`   |

Prepare persistent demo sources without running the compiler tests:

```sh
scripts/check-design-corpus.py --prepare-only \
  --workspace target/design-corpora
```

The checkout directory is derived from the repository URL, so the staged
corpora contain `bedrock-rtl/bedrock-rtl/`, `ibex/ibex/`, and
`opentitan/opentitan/`. The command is idempotent when the existing checkout
has the expected origin, SHA, and no modifications. Use the staged corpus
directory as `--project-root`; for example, `target/design-corpora/ibex`. The
filelist and repository checkout must remain inside the same project-root
containment boundary.

Run every real-toolchain corpus regression with:

```sh
npm run test:designs
```

The test command creates a temporary workspace, clones every selected manifest
source, verifies its origin and checked-out SHA, and removes the workspace on
completion. Pass `--workspace <path>` to retain or reuse it. The same staged
filelists can be passed to `nettle build` to create demo bundles; each corpus
README provides a copy-paste command. Use `nettle render` with the same build
arguments to write the bundle and immediately serve it in the local viewer.

The Docker integration target additionally compiles both `schematic-diff/`
projects and opens them in comparison mode. Browser assertions cover interface
additions and removals, one-sided instances, changed operators and wiring, and
non-overlapping, endpoint-connected union geometry under both matching
policies. These checks intentionally inspect semantic SVG geometry rather than
pixel screenshots or exact ELK coordinates.
