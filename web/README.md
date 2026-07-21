<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nettle web viewer

`web/` is Nettle's shared browser viewer. It validates and decodes one or two
user-selected `.nettle` bundles in browser memory, then renders source and
schematic views or a presentation-only comparison. Its `static` build is
browser-local and exposes no hosted actions. Its `hosted` build additionally
offers explicit bundle sharing and queued source compilation through the native
service. The native host can also expose one command-line-selected bundle at
`/startup.nettle`, or a comparison descriptor plus separate reference and
candidate routes. Every bundle uses the same browser validation path as the
file picker.

The production build is ordinary static content. `nettle view` in the unified
`nettle` image normally serves only those static files. `nettle view` may
serve one bundle from a fixed `no-store` route. `nettle compare` serves a
`no-store` descriptor at `/startup-comparison.json` and two fixed `no-store`
bundle routes. The native host first copies each selected archive into a
private, size-bounded anonymous temporary snapshot and validates that exact
copy, so later source-path changes cannot affect a running route. Comparison
can retain two such snapshots; they have no pathname to orphan and are
reclaimed by the operating system when their final handles close, including
after abrupt termination. The browser passes every hosted bundle through the
normal `File`/`Blob` validation pipeline.

## Development

Run commands from the repository root so the pinned npm lockfile and workspace
scripts are used:

```sh
npm ci
npm run dev
```

Local development defaults to the full `hosted` landing page. Set
`NETTLE_PUBLIC_MODE=static` to exercise the GitHub Pages landing page; other
values fail the build. Vite listens on `127.0.0.1:8090` by default. To exercise
a production build:

```sh
NETTLE_PUBLIC_MODE=hosted npm run build
# Or build the static public demo:
NETTLE_PUBLIC_MODE=static npm run build
cargo run --locked -- view --web-root web/dist --port 8090
# Or open one validated bundle immediately:
cargo run --locked -- view design.nettle --web-root web/dist --port 8090
# Or compare two independently validated bundles:
cargo run --locked -- compare reference.nettle candidate.nettle \
  --matching conservative --web-root web/dist --port 8090
```

Open the displayed URL and choose a `.nettle` file. The root README describes
how to build bundles and provides Bedrock-RTL, Ibex, and OpenTitan examples.

## Source layout

- `src/bundle/` validates ZIP structure, manifest membership and hashes,
  decodes Protobuf indexes and module graphs, and composes hierarchy projections.
- `src/api/` defines the viewer-facing workspace contract and normalizes bundle
  data into application models.
- `src/comparison/` owns source inventory pairing, bounded line mapping,
  conservative/aggressive graph correspondence, union-graph construction, and
  comparison-aware hierarchy projection. Its records are presentation-only and
  never alter the bundle schema.
- `src/model/` contains TypeScript graph and format types.
- `src/graph/` owns ELK layout, camera state, presentation-only filtering, SVG
  rendering, standard gate and storage glyphs, constant formatting, and
  schematic interaction.
- `src/source/` implements graph/source cross-probing.
- `src/components/` contains the header, open/compare dialog, source tree,
  ordinary and diff Monaco panes, workspace views, inspector, and supporting
  controls.
- `src/App.tsx` owns atomic installation of an empty, single-bundle, or
  comparison workspace. The workspace views coordinate hierarchy, presentation,
  selection, and the right-side inspector.

Module graphs and source bodies are decoded lazily and retained in bounded
caches. Clock/reset visibility, label modes, and constant radix are presentation
operations; they must not recompile, re-layout solely for signal hiding, or
read additional bundle data unnecessarily. Layout profiles are explicit
topology inputs; `auto` selects the fast overview at 2,000 graph objects.

## Validation

```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

Unit tests use Vitest and Testing Library. End-to-end tests use a deterministic
bundle produced by the Rust writer and open it through Chromium's real file
input. Set `NETTLE_CHROMIUM_PATH=/path/to/chromium` when Playwright's bundled
browser is unavailable.

Performance fixtures and browser benchmarks are available separately:

```sh
npm run bench:graph
npm run bench:browser
```

## Security and compatibility

Treat bundle contents as untrusted input. Readers must enforce the limits and
cross-entry checks in `../NETTLE_FILE_FORMAT.md`; code must not generically extract
ZIP paths, inject source text as HTML, execute bundle content, or persist bundle
bytes in browser storage. Unknown bundle major versions and unknown required
features are rejected. Additive Protobuf fields within a supported major
version remain forward-compatible.

Native/browser compatibility limits come from the build-time
`../resource-limits.yaml` policy documented in
`../RESOURCE_LIMITS_FILE_FORMAT.md`; they are not runtime configurable.

The browser viewer is not an authentication boundary. Hosted deployments should
provide normal HTTPS, CSP, and ingress authentication. Picker-selected bundles
never leave the client. A command-line startup bundle, or either side of a
command-line comparison, is intentionally served by the native host and is
visible to every client able to reach that host. Every startup descriptor and
bundle response is non-cacheable.
