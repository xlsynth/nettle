<!-- SPDX-License-Identifier: Apache-2.0 -->

# Ibex test and demo corpus

Run every command in this guide from the repository root.

This manifest selects a pinned, unmodified Ibex source set for an integration
regression and end-user Nettle demo. The sources are not checked into Nettle.

## Third-party boundary and provenance

The runner sparse-checks out the required paths from
[`lowRISC/ibex`](https://github.com/lowRISC/ibex) at commit
`022f084096baed0a9b5ebdf697ed2965f13e8ed8`:

- `rtl/` contains the upstream Ibex RTL tree.
- `vendor/` contains the required lowRISC primitive RTL, generic
  primitive RTL, and functional-coverage macro dependencies.
- `LICENSE` and `NOTICE` provide the upstream Apache-2.0 redistribution terms
  and notices.

The runner uses these files directly from the verified upstream checkout. Only
the Nettle-owned filelist, manifest, and this README live in this directory.

Build the default complete CPU-core bundle from the repository root:

```sh
scripts/check-design-corpus.py --prepare-only --corpus ibex \
  --workspace target/design-corpora
cargo run --locked -- build \
  --filelist target/design-corpora/ibex/ibex_core.f \
  --project-root target/design-corpora/ibex \
  --top ibex_core \
  --output /tmp/ibex_core.nettle
```

Run its real-toolchain regression from the repository root:

```sh
npm run test:designs -- --corpus ibex
```
