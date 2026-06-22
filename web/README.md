<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nettle web viewer

`web/` is Nettle's static, browser-local viewer. It validates and decodes a
user-selected `.nettle` bundle in browser memory, then renders its source and
schematic views. It does not upload design data or call a project API. The
optional native host can expose one command-line-selected bundle at
`/startup.nettle`; the viewer fetches it once and applies the same browser
validation path without showing the file picker.

The production build is ordinary static content. `nettle view` and
`Dockerfile.viewer` normally serve only those static files. If `nettle view`
receives a bundle path, it also serves that bundle from a fixed `no-store`
route. The browser then passes it through the normal `File`/`Blob` pipeline.

## Development

Run commands from the repository root so the pinned npm lockfile and workspace
scripts are used:

```sh
npm ci
npm run dev
```

Vite listens on `127.0.0.1:5173` by default. To exercise a production build:

```sh
npm run build
cargo run --locked -- view --web-root web/dist --port 8090
# Or open one validated bundle immediately:
cargo run --locked -- view design.nettle --web-root web/dist --port 8090
```

Open the displayed URL and choose a `.nettle` file. The root README describes
how to build bundles and provides Bedrock-RTL, Ibex, and OpenTitan examples.

## Source layout

- `src/bundle/` validates ZIP structure, manifest membership and hashes,
  decodes Protobuf indexes and module graphs, and composes hierarchy projections.
- `src/api/` defines the viewer-facing workspace contract and normalizes bundle
  data into application models.
- `src/model/` contains TypeScript graph and format types.
- `src/graph/` owns ELK layout, camera state, presentation-only filtering, SVG
  rendering, standard gate and storage glyphs, constant formatting, and
  schematic interaction.
- `src/source/` implements graph/source cross-probing.
- `src/components/` contains the header, bundle picker, source tree, Monaco
  source pane, inspector, and supporting dialogs.
- `src/App.tsx` coordinates opened-bundle state, hierarchy navigation, label and
  signal visibility, selection, and the right-side inspector.

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
never leave the client; a command-line startup bundle is intentionally served
by the native host and is visible to every client able to reach that host.
