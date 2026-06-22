# syntax=docker/dockerfile:1.8.1@sha256:e87caa74dcb7d46cd820352bfea12591f3dba3ddc4285e19c7dcd13359f7cefd
# check=error=true
# SPDX-License-Identifier: Apache-2.0

# The bundle builder currently targets linux/amd64 because standalone Slang 11
# does not publish a Linux arm64 archive. The viewer image is multi-platform.
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS eda-toolchain
ARG TARGETARCH
ARG SLANG_RELEASE=v11.0
ARG SLANG_ARCHIVE=slang-linux-x86_64.tar.gz
ARG SLANG_SHA256=951a170e10e25e54c91565030acfdfc11c3226714ebf225a18ad4166a898d8a4
ARG SLANG_SOURCE_COMMIT=7ddf4059f79eff508dd486eb42fd650cdf320d52
ARG SLANG_SOURCE_SHA256=1b24be639b4588c5dea5d7bcc60973b999ffa20eb437a39d5369aedc0c7aefc5
ARG OSS_CAD_RELEASE=2026-06-15
ARG OSS_CAD_ARCHIVE=oss-cad-suite-linux-x64-20260615.tgz
ARG OSS_CAD_SHA256=d7adaabcad6a79fa67f12521be3787b7bccef3f92ae72c57fa05fba18d16f55a
# yosys-slang's upstream prebuilt distribution is OSS CAD Suite. Bookworm's
# Yosys is too old for current yosys-slang and does not package the plugin.
RUN test "$TARGETARCH" = "amd64" || \
    (echo "Nettle's builder image currently supports linux/amd64 only" >&2; exit 1)
RUN apt-get update \
  && apt-get install --yes --no-install-recommends bash ca-certificates coreutils curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/toolchain
RUN set -eu; \
    curl --fail --location --retry 3 \
      "https://github.com/MikePopoloski/slang/releases/download/${SLANG_RELEASE}/${SLANG_ARCHIVE}" \
      --output slang.tar.gz; \
    echo "${SLANG_SHA256}  slang.tar.gz" | sha256sum --check --strict; \
    mkdir -p /opt/slang /opt/toolchain-licenses/slang /tmp/slang-source; \
    tar -xzf slang.tar.gz -C /opt/slang; \
    curl --fail --location --retry 3 \
      "https://github.com/MikePopoloski/slang/archive/${SLANG_SOURCE_COMMIT}.tar.gz" \
      --output slang-source.tar.gz; \
    echo "${SLANG_SOURCE_SHA256}  slang-source.tar.gz" | sha256sum --check --strict; \
    tar -xzf slang-source.tar.gz -C /tmp/slang-source --strip-components=1; \
    cp /tmp/slang-source/LICENSE /opt/toolchain-licenses/slang/LICENSE; \
    cp -a /tmp/slang-source/LICENSES /opt/toolchain-licenses/slang/LICENSES; \
    test -x /opt/slang/slang
RUN set -eu; \
    curl --fail --location --retry 3 \
      "https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${OSS_CAD_RELEASE}/${OSS_CAD_ARCHIVE}" \
      --output oss-cad-suite.tgz; \
    echo "${OSS_CAD_SHA256}  oss-cad-suite.tgz" | sha256sum --check --strict; \
    mkdir -p /tmp/oss-cad-suite /opt/oss-cad-suite/bin /opt/oss-cad-suite/lib \
      /opt/oss-cad-suite/libexec /opt/oss-cad-suite/share \
      /opt/oss-cad-suite/license; \
    tar -xzf oss-cad-suite.tgz -C /tmp/oss-cad-suite --strip-components=1; \
    cp /tmp/oss-cad-suite/bin/yosys /opt/oss-cad-suite/bin/yosys; \
    cp /tmp/oss-cad-suite/bin/yosys-abc /opt/oss-cad-suite/bin/yosys-abc; \
    cp /tmp/oss-cad-suite/libexec/yosys /opt/oss-cad-suite/libexec/yosys; \
    cp /tmp/oss-cad-suite/libexec/yosys-abc /opt/oss-cad-suite/libexec/yosys-abc; \
    cp /tmp/oss-cad-suite/lib/yosys-abc /opt/oss-cad-suite/lib/yosys-abc; \
    cp -a /tmp/oss-cad-suite/share/yosys /opt/oss-cad-suite/share/yosys; \
    cp -a /tmp/oss-cad-suite/license/. /opt/oss-cad-suite/license/; \
    for library in ld-linux-x86-64.so.2 libc.so.6 libffi.so.8 libgcc_s.so.1 \
      libm.so.6 libreadline.so.8 libstdc++.so.6 libtcl8.6.so libtinfo.so.6 libz.so.1; do \
        cp -L "/tmp/oss-cad-suite/lib/${library}" "/opt/oss-cad-suite/lib/${library}"; \
    done; \
    /opt/slang/slang --version; \
    /opt/oss-cad-suite/bin/yosys -Q -m slang -p "help read_slang" >/dev/null

FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS rust-builder
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY build.rs ./
COPY resource-limits.yaml ./
COPY proto proto
COPY src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/src/target \
  cargo build --locked --release --bin nettle \
  && cp target/release/nettle /tmp/nettle

FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS builder
RUN apt-get update \
  && apt-get install --yes --no-install-recommends bash ca-certificates coreutils libgcc-s1 passwd \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /home/nettle --uid 10001 --user-group nettle
COPY --from=rust-builder /tmp/nettle /usr/local/bin/nettle
COPY --from=eda-toolchain /opt/slang /opt/slang
COPY --from=eda-toolchain /opt/oss-cad-suite /opt/oss-cad-suite
COPY --from=eda-toolchain /opt/toolchain-licenses /opt/nettle/third-party-licenses
RUN chmod 0555 /usr/local/bin/nettle /opt/slang/slang \
  && chown -R nettle:nettle /home/nettle
ENV HOME=/home/nettle \
  PATH=/opt/oss-cad-suite/bin:/opt/slang:/usr/local/bin:/usr/bin:/bin
USER nettle
WORKDIR /work
ENTRYPOINT ["nettle"]

# Shared environment for the integration-only and comprehensive test targets.
# The precompiled Slang and yosys-slang distributions currently have Linux
# amd64 binaries only; add linux/arm64 when both upstream toolchains provide it.
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS test-base
ARG TARGETARCH
RUN test "$TARGETARCH" = "amd64" || \
    (echo "Nettle's test image currently supports linux/amd64 only" >&2; exit 1)
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash ca-certificates chromium coreutils jq python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=eda-toolchain /opt/slang /opt/slang
COPY --from=eda-toolchain /opt/oss-cad-suite /opt/oss-cad-suite
ENV PATH=/opt/oss-cad-suite/bin:/opt/slang:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
  NETTLE_CHROMIUM_PATH=/usr/bin/chromium \
  NETTLE_NETLIST_FIXTURE=/tmp/br_cdc_fifo_flops_synth.nettle \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm \
  npm ci

# CI builds this target after the standalone cargo and npm unit-test jobs. It
# clones each manifest-pinned design corpus, then exercises the real HDL
# toolchain and browser flows without repeating either unit-test suite.
FROM test-base AS integration-tests
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  scripts/check-toolchain.sh \
  && npm run test:designs \
  && npm run test:e2e

# Retain a single target for developers who want every validation check in one
# reproducible image. The integration-tests base has already run the real HDL
# compiler, design-corpus, and browser regressions.
FROM integration-tests AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  scripts/check-rust-docs.py \
  && cargo fmt --all --check \
  && RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked \
  && cargo test --locked \
  && cargo clippy --all-targets --all-features --locked -- -D warnings \
  && npm run lint \
  && npm test \
  && npm run build

# Keep the compact builder as the default final image. The comprehensive test
# environment is built only when --target test is requested.
FROM builder AS release
