<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenTitan test and demo corpus

Run every command in this guide from the repository root.

This manifest selects a pinned, unmodified OpenTitan AES source set for an
integration regression and end-user Nettle demo. The sources are not checked
into Nettle.

## Third-party boundary and provenance

The runner sparse-checks out the required paths from
[`lowRISC/opentitan`](https://github.com/lowRISC/opentitan) at commit
`fde05de428d1d3a0613c088a5ccd3a64434559c3`:

- `hw/ip/` contains the upstream AES RTL plus the primitive, generic-primitive,
  and EDN package dependency trees required by `aes_cipher_core`.
- `LICENSE` contains the upstream Apache-2.0 license.

The runner uses these files directly from the verified upstream checkout. Only
the Nettle-owned filelist, manifest, and this README live in this directory.

Build the AES cipher-core bundle from the repository root:

```sh
scripts/check-design-corpus.py --prepare-only --corpus opentitan \
  --workspace target/design-corpora
cargo run --locked -- build \
  --filelist target/design-corpora/opentitan/aes_cipher_core.f \
  --project-root target/design-corpora/opentitan \
  --top aes_cipher_core \
  --output /tmp/aes_cipher_core.nettle
```

Run the real-toolchain regression from the repository root:

```sh
npm run test:designs -- --corpus opentitan
```
