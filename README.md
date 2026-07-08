<!-- SPDX-License-Identifier: Apache-2.0 -->

<img src="assets/nettle_logo_light.png" alt="Nettle split-leaf circuit logo" width="256" height="256">

# Nettle

Nettle (**NETlist Traversal and Topology Layout Explorer**) turns elaborated
Verilog and SystemVerilog into a portable `.nettle` bundle and opens it as an
interactive schematic in a web browser. Use it to understand synthesized RTL
connectivity, navigate or selectively flatten hierarchy, cross-probe source and
schematic objects, and share a reviewable snapshot without sharing a compiler
environment.

Nettle deliberately separates compilation from viewing. The native CLI runs
standalone Slang and Yosys with yosys-slang to normalize a design into a
versioned ZIP + Protobuf bundle. The React viewer validates and renders that
bundle entirely in browser memory. It does not upload the design, call a
project API, or need HDL compiler binaries, making Nettle useful for local
investigation, design review, and static-site deployment.

## Demo

The demo builds `br_counter.nettle` from the manifest-pinned upstream
`br_counter.sv` design and starts the viewer at <http://127.0.0.1:8090>. Choose
one of these paths:

![Nettle rendering the br_counter design](assets/br_counter.png)

| Path                                                                           | What you need                                       | What runs                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------- |
| [Prebuilt container images](#option-1-use-prebuilt-container-images)           | Git, Docker or Podman, and a browser                | Published builder and viewer images from GHCR        |
| [Locally built container images](#option-2-build-the-container-images-locally) | Git, Docker or Podman, a browser, and this checkout | Builder and viewer images built from your checkout   |
| [No containers](#option-3-run-without-containers)                              | Git, the native system dependencies, and a browser  | The CLI and viewer built directly from your checkout |

Run all commands from the repository root.

First prepare the demo corpus. This clones Bedrock-RTL, sparse-checks out the
full Git SHA in `integration_tests/bedrock-rtl/manifest.json`, and keeps the
upstream sources under the ignored `target/` directory:

```sh
scripts/check-design-corpus.py --prepare-only --corpus bedrock-rtl \
  --workspace target/design-corpora
```

### Option 1: use prebuilt container images

These commands pull the published images from GHCR automatically. The builder
image is Linux/amd64 because the pinned standalone Slang release does not
publish a Linux/arm64 archive. The viewer image is multi-platform. Stop the
background viewer afterward with `docker stop nettle-viewer-demo` or
`podman stop nettle-viewer-demo`.

#### Docker Desktop on macOS/arm64

Docker Desktop supplies amd64 emulation for the builder. A checkout below your
macOS home directory is shared with Docker Desktop by default.

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD:/work" -w /work \
  ghcr.io/xlsynth/nettle-builder:latest build \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output br_counter.nettle && \
docker run --rm -d \
  --name nettle-viewer-demo \
  -p 127.0.0.1:8090:8080 \
  ghcr.io/xlsynth/nettle-viewer:latest && \
open http://127.0.0.1:8090
```

#### Docker Engine on Linux/amd64

Use this only when `docker --version` reports Docker Engine. If it begins with
`podman version`, use the Podman command below.

```sh
docker run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  ghcr.io/xlsynth/nettle-builder:latest build \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output br_counter.nettle && \
docker run --rm -d \
  --name nettle-viewer-demo \
  -p 127.0.0.1:8090:8080 \
  ghcr.io/xlsynth/nettle-viewer:latest && \
xdg-open http://127.0.0.1:8090
```

#### Podman on Linux/amd64

The fully qualified GHCR image names avoid Podman's short-name registry prompt.
The user namespace mapping lets the container's UID/GID 10001 account write a
bundle owned by the calling host user; `:Z` supplies the expected SELinux
relabeling.

```sh
podman run --rm --platform linux/amd64 \
  --userns=keep-id:uid=10001,gid=10001 \
  -v "$PWD:/work:Z" -w /work \
  ghcr.io/xlsynth/nettle-builder:latest build \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output br_counter.nettle && \
podman run --rm -d \
  --name nettle-viewer-demo \
  -p 127.0.0.1:8090:8080 \
  ghcr.io/xlsynth/nettle-viewer:latest && \
xdg-open http://127.0.0.1:8090
```

### Option 2: build the container images locally

Build both images from the checkout, then run the matching command from
[Option 1](#option-1-use-prebuilt-container-images) with the local image names
in place of the GHCR image names. This exercises local source changes while
keeping the compiler and viewer dependencies inside containers.

For Docker Desktop on macOS/arm64:

```sh
docker build --platform linux/amd64 \
  -f Dockerfile.builder -t nettle-builder:latest .
docker build --platform linux/arm64 \
  -f Dockerfile.viewer -t nettle-viewer:latest .
```

For Docker Engine on Linux/amd64:

```sh
docker build --platform linux/amd64 \
  -f Dockerfile.builder -t nettle-builder:latest .
docker build --platform linux/amd64 \
  -f Dockerfile.viewer -t nettle-viewer:latest .
```

For either Docker variant, replace
`ghcr.io/xlsynth/nettle-builder:latest` with `nettle-builder:latest` and
`ghcr.io/xlsynth/nettle-viewer:latest` with `nettle-viewer:latest`.

For Podman on Linux/amd64:

```sh
podman build --platform linux/amd64 \
  -f Dockerfile.builder -t localhost/nettle-builder:latest .
podman build --platform linux/amd64 \
  -f Dockerfile.viewer -t localhost/nettle-viewer:latest .
```

For Podman, replace the GHCR image names with
`localhost/nettle-builder:latest` and `localhost/nettle-viewer:latest`,
respectively. The explicit `localhost/` tags avoid Podman's short-name
registry prompt.

### Option 3: run without containers

This path builds and runs Nettle directly on the host. First install the
[native system dependencies](#native-system-requirements), then verify the HDL
compiler toolchain and build Nettle and its static viewer:

```sh
scripts/check-toolchain.sh
cargo build --locked
npm ci
npm run build
```

Build the demo bundle and start the viewer:

```sh
cargo run --locked -- build \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output br_counter.nettle
cargo run --locked -- view --web-root web/dist --port 8090
```

Open <http://127.0.0.1:8090> and choose `br_counter.nettle` in the file picker.
Press Ctrl-C in the terminal to stop the viewer.

## Development

### With containers

See [Option 2](#option-2-build-the-container-images-locally) for image
build and run commands matching each supported host. To run the complete test
suite in its known-good toolchain container, build the builder Dockerfile's
`test` target:

```sh
docker build --platform linux/amd64 \
  -f Dockerfile.builder --target test -t nettle-test .
```

### Native system requirements

Native development works on any host where the required compiler tools are
available. On Linux/amd64, the versions below match the known-good container.
On macOS/arm64 or Linux/arm64, install or build native host versions of Slang
and Yosys with yosys-slang; the pinned standalone Slang Linux release is
amd64-only. Install:

- Rust 1.88 or newer. This checkout selects and validates Rust 1.95.0 through
  `rust-toolchain.toml`.
- standalone Slang 11 or newer. Slang 11.0 is the known-good release. Nettle checks
  for the command-file, top selection, JSON diagnostics/AST, define, undefine,
  and parameter capabilities it uses.
- Yosys with a compatible yosys-slang plugin. Nettle does not claim a numeric
  Yosys/plugin version range because the two components must be a compatible
  pair; it probes `read_slang` and every required plugin capability before
  compiling. The OSS CAD Suite snapshot dated 2026-06-15 is known good.
- Node.js 20.19 or later in the 20.x line, 22.12 or later in the 22.x line, or
  24 or newer, plus npm to build the web viewer. Node.js 24 with npm 11 is the
  known-good configuration.
- A modern web browser to use the viewer. Chromium is additionally required to
  run the browser end-to-end tests.

The [`Dockerfile.builder`](Dockerfile.builder) and
[`Dockerfile.viewer`](Dockerfile.viewer) pins are the source of truth for
known-good toolchains and build environments. They record the exact Slang
release/source commit and checksums, the checksummed OSS CAD Suite artifact,
and the Rust and Node image versions. Nettle never downloads HDL compilers at
runtime. Run `scripts/check-toolchain.sh` after installing native compiler
tools to exercise their capabilities end to end.

Install the locked JavaScript dependencies and build the static viewer:

```sh
npm ci
npm run build
```

Cargo uses the committed `Cargo.lock`; use `--locked` for reproducible native
builds. A typical local development cycle is:

```sh
scripts/check-toolchain.sh
cargo build --locked
cargo test --locked
npm test
npm run dev
```

The development viewer is then available at <http://127.0.0.1:5173>. Use
`cargo build --locked --release` for an optimized native binary.

## Usage

Run commands from the repository root unless noted otherwise.

### Build and view a bundle

Build the included counter:

```sh
cargo run --locked -- build \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output br_counter.nettle
```

The project root defaults to the filelist's parent. Set a wider root when a
filelist reaches sources through `..`; every embedded source must canonicalize
inside that boundary. Nettle embeds only referenced UTF-8 sources up to 4 MiB
and records project-relative paths.

Start the built static viewer and select the bundle in its file picker:

```sh
cargo run --locked -- view --web-root web/dist --port 8090
```

Then open <http://127.0.0.1:8090>. The browser reads the selected file; the
static host never receives it. For frontend development, `npm run dev` serves
the application at <http://127.0.0.1:5173>.

Pass a bundle to open it directly:

```sh
cargo run --locked -- view br_counter.nettle --web-root web/dist --port 8090
```

This copies the bundle into a private, size-bounded anonymous temporary
snapshot, validates that exact copy, and exposes it at a fixed, non-cacheable
route. Anonymous storage has no pathname to orphan and is reclaimed by the
operating system when its final handle closes, including after abrupt process
termination. Keep the default loopback bind for sensitive designs. A
non-loopback bind makes the bundle downloadable by reachable clients and
therefore requires the deployment's normal authentication and TLS protections.

`render` combines build and view while leaving the bundle on disk:

```sh
cargo run --locked -- render \
  --filelist target/design-corpora/bedrock-rtl/br_counter.f \
  --project-root target/design-corpora/bedrock-rtl \
  --top br_counter \
  --output br_counter.nettle \
  --web-root web/dist \
  --port 8090
```

### Compare two elaborated designs

Build the reference and candidate as independent snapshots, then open schematic
diff mode:

```sh
cargo run --locked -- compare reference.nettle candidate.nettle \
  --matching conservative \
  --web-root web/dist \
  --port 8090
```

The command copies and validates both inputs in anonymous delete-on-close
storage before starting the viewer and exposes the private snapshots only
through separate non-cacheable startup routes. The two snapshots can consume
up to twice the configured per-bundle temporary-storage ceiling; the operating
system reclaims them when their final handles close, including after abrupt
termination. The default conservative policy accepts exact and uniquely
determined graph correspondence. Pass
`--matching aggressive`, or switch policy in the viewer, to add visibly marked
heuristic matches for logic whose compiler-generated identities changed.

The viewer constructs one union graph and lays it out once: reference-only
objects are red and dashed, candidate-only objects are green, matched changes
are yellow, and unchanged logic remains neutral. `−`, `+`, and `±` badges keep
status independent of color, while `≈` identifies heuristic correspondence.
The single View menu selects a neutral reference or candidate snapshot, the
complete diff overlay, changes-only presentation, or custom status visibility;
every view reuses the union geometry. Matching is a structural review aid, not
a functional-equivalence result.

Hierarchy navigation and flattening use the same selected policy. Recursive
flattening compares child modules before splicing their union through paired
boundaries, including one-sided instances, and a policy change recomputes the
visible projection. Decoded children are reused while they remain in the
bounded provider caches; evicted modules may be decoded again.

The left pane compares the UTF-8 compilation sources embedded in the two
bundles. This is intentionally a **bundled source diff**, not a complete Git
tree diff: files not included in either snapshot and version-control rename
metadata are unavailable. Different defines, parameters, tops, or compiler
versions are reported separately because they can change the elaborated graph
without changing source text. Diff hunks are labeled `source-only` only after
neither direct source origins nor indirect evidence anywhere in the reachable
paired hierarchy connects them to a schematic change; selecting a
graph-affecting hunk highlights every directly intersecting object in the
visible overlay.

### Parameters, defines, and configuration files

Builder overrides are repeatable, raw single-line SystemVerilog expressions:

```sh
cargo run --locked -- build \
  --filelist project.f \
  --project-root "$PWD" \
  --top top \
  --param WIDTH=16 \
  --define SYNTHESIS \
  --define NUM_HARTS=4 \
  --undefine SIMULATION \
  --output design.nettle
```

Duplicate names, empty values, invalid identifiers, and define/undefine
conflicts are rejected before compilation. Add `--debug-artifacts` only when
raw Yosys JSON, Slang AST JSON, and compiler transcripts are needed; those
artifacts can reveal substantially more project detail.

Larger builds can use YAML:

```yaml
# build.yaml
filelist: filelists/project.f
project_root: .
top: top
output: design.nettle
parameters:
  DEPTH: "32"
  WIDTH: "16"
defines:
  NUM_HARTS: "4"
  SYNTHESIS: null
undefines:
  - SIMULATION
debug_artifacts: false
```

```sh
cargo run --locked -- build --config build.yaml
```

YAML paths are relative to the configuration file; command-line paths are
relative to the current directory. YAML may also set `slang_bin` and
`yosys_bin`. Scalar CLI values override YAML values, while parameter, define,
and undefine collections are combined. Quote expressions and macro values so
YAML preserves them as strings. Unknown fields are rejected. See
[`INPUT_CONFIG_FILE_FORMAT.md`](INPUT_CONFIG_FILE_FORMAT.md) for the complete schema and
merge behavior.

### Inspect and validate bundles

```sh
cargo run --locked -- inspect design.nettle
cargo run --locked -- validate design.nettle
```

`inspect` prints safe summary metadata. `validate` checks archive membership,
resource limits, hashes, Protobuf payloads, source indexes, and module
index/body consistency without extracting files. See
[`NETTLE_FILE_FORMAT.md`](NETTLE_FILE_FORMAT.md) for the normative schema and
compatibility rules.

### Viewer containers and deployment

The viewer image contains only the static web build and a small file server; it
contains no Slang, Yosys, HDL sources, example projects, or default bundle:

```sh
docker run --rm -p 127.0.0.1:8090:8080 \
  ghcr.io/xlsynth/nettle-viewer:latest
```

In a shared deployment, place the static site behind the normal authentication
and HTTPS boundary. Design bytes selected with the file picker remain in each
user's browser.

### Validation

```sh
scripts/check-rust-docs.py
cargo fmt --all --check
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked
cargo test --locked
cargo clippy --all-targets --all-features --locked
npm run lint
npm test
npm run build
npm run test:e2e
scripts/check-toolchain.sh
npm run test:designs
```

The real-toolchain design regressions are opt-in because they require the
external HDL compilers. The Development section shows how to run the complete
suite in the known-good container environment.

## Project documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) describes the software architecture,
  trust boundaries, data flow, and tool design.
- [`NETTLE_FILE_FORMAT.md`](NETTLE_FILE_FORMAT.md) defines the `.nettle` interchange
  format and its security rules.
- [`INPUT_CONFIG_FILE_FORMAT.md`](INPUT_CONFIG_FILE_FORMAT.md) defines the YAML build
  configuration schema and command-line merge behavior.
- [`RESOURCE_LIMITS_FILE_FORMAT.md`](RESOURCE_LIMITS_FILE_FORMAT.md) documents
  the build-time resource-limit policy shared by the native and browser code.

## License

Nettle is licensed under the [Apache License 2.0](LICENSE).

Integration tests indirectly use third-party repositories that are referenced by manifests.
Third-party sources are not committed into this repository. Nevertheless, manifests identify
third-party provenance and applicable license and notice files.
