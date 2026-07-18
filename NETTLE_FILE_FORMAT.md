<!-- SPDX-License-Identifier: Apache-2.0 -->

# `.nettle` Bundle Format

Status: normative for format 1.1

## Purpose

A `.nettle` file is a portable, deterministic snapshot of an elaborated HDL
design. Only the native builder runs Slang and Yosys/yosys-slang. Viewers read
normalized Nettle IR, so they need neither compiler binaries nor access to the
original project or its filesystem.

Each bundle represents exactly one snapshot. Schematic comparison is a viewer
operation over two independently validated bundles; diff status, correspondence
confidence, and union-layout identities are not persisted in format 1.

The format optimizes for long-lived compatibility, independent module loading,
local source cross-probing, deterministic builds, and safe handling of
untrusted archives. It is not a cache of compiler implementation details.

## Container

The file is a ZIP or ZIP64 archive. Readers must use the central directory and
must not extract entries to a filesystem. Entry names are UTF-8 relative paths
using `/`; absolute paths, backslashes, empty components, `.` components, and
`..` components are invalid.

Format 1.1 has this layout:

```text
manifest.json
design/index.pb
design/modules/<module-id>.pb
sources/index.pb
sources/<lowercase-sha256>
diagnostics.pb
debug/yosys.json                 # optional
debug/slang-ast.json             # optional
debug/slang-cst.json             # optional
debug/<tool>-stdout.txt          # optional
debug/<tool>-stderr.txt          # optional
```

`manifest.json` is stored. Protobuf entries are stored because Protobuf is
already compact and they are latency-sensitive. Source and debug entries use
raw DEFLATE. Other compression methods are not part of format 1.

## Manifest

The manifest is UTF-8 JSON with these required camel-case fields:

- `formatVersion`: `{ "major": 1, "minor": 1 }`;
- `producer`: builder name and version;
- `snapshotId` and `top`: design identity;
- `designIndex`, `sourceIndex`, and `diagnostics`: entry names;
- `features`: optional-format features such as `debugArtifacts`; and
- `entries`: every archive entry except the manifest, in path order, with its
  uncompressed byte size, lowercase SHA-256 digest, and `stored` or `deflate`
  compression value.

The archive and manifest entry sets must match exactly. The manifest does not
hash itself. Readers verify an entry before decoding or displaying it.

## Protobuf schema

[`proto/nettle.proto`](proto/nettle.proto)
is the canonical schema and uses package `nettle.bundle.v1`.

- `DesignIndex` identifies all independently loadable module entries and their
  object counts. It also records effective parameters, defines, undefines, and
  compiler provenance.
- Each `GraphSlice` is normalized Nettle IR for one independently navigable
  module/hierarchy slice. It has no dependency on Yosys or Slang JSON syntax.
- `GraphEdge.origins` describes drivers rather than signal declarations. The
  first available tier is used in this order: exact Slang assignment RHS ranges,
  Yosys source-cell ranges, then a source declaration fallback. Conditional or
  otherwise multiply assigned signals can retain multiple ranges in lexical AST
  order.
- `SourceIndex` maps logical source IDs and project-relative display paths to
  content-addressed source entries. Identical contents are stored once. In
  format 1.1, each source can also carry active and inactive elaboration ranges
  for generate constructs. Viewers use active ranges to cross-probe construct
  headers against elaborated graph origins and render inactive branches as
  de-emphasized source.
- `Diagnostics` contains normalized diagnostics and optional source origins.
- JSON-valued parameters and attributes are canonical JSON text inside typed
  `JsonEntry` messages. This preserves the existing IR value domain without
  depending on Protobuf's dynamically typed value messages.

Unknown Protobuf fields must be ignored. Once published, field numbers are
never reused; deleted fields must be marked `reserved` in the schema.

## Sources and privacy

Only files referenced by the elaborated design are bundled. Paths are relative
to the effective project root (explicitly supplied or defaulted to the root
filelist's parent) and never reveal the builder host's absolute directory. Tool
executable paths are reduced to their basename. Raw compiler outputs and
transcripts are absent unless the user explicitly passes `--debug-artifacts`;
such bundles advertise the `debugArtifacts` feature.

Bundles are not encrypted or signed in format 1. SHA-256 detects corruption
and internal inconsistency but is not proof of authorship. Users must protect a
bundle as they would protect its source files.

## Determinism

Given equivalent normalized compiler outputs and build inputs, builders must
produce identical bytes:

- entry names and repeated index records are sorted;
- stable semantic IDs name modules and snapshots;
- ZIP timestamps are the DOS epoch and permissions are fixed to `0644`;
- no wall-clock time, hostname, temporary path, or absolute project path is
  recorded; and
- JSON maps and archive entries use canonical key/path ordering.

Compiler version changes may legitimately change normalized output and bundle
identity.

## Compatibility

The major number is the compatibility boundary. A reader rejects an unknown
major version before decoding design payloads. A reader accepts a newer minor
version of the same major when all required entries and features are understood;
additive Protobuf fields remain compatible through normal unknown-field rules.
An unknown required feature must be rejected rather than silently ignored.

## Required reader limits

Readers treat bundles as untrusted input. Implementations must, before or while
materializing payloads, bound at least:

- archive entry count;
- individual and total uncompressed bytes;
- compression ratio;
- manifest and string sizes;
- graph node, edge, port, origin, and metadata collection sizes; and
- decoded-module/source cache memory.

Current Rust and browser archive limits are a 1 MiB manifest, 100,000 entries,
64 MiB per entry, 1 GiB total uncompressed content, and a 200:1 compression
ratio. The browser additionally bounds decoded module/source caches at 128 MiB
and 32 MiB and enforces graph collection/object limits before rendering. The
exact shared reader limits and their rationale are defined in
[`resource-limits.yaml`](resource-limits.yaml) and documented in
[`RESOURCE_LIMITS_FILE_FORMAT.md`](RESOURCE_LIMITS_FILE_FORMAT.md).
Malformed ZIP, duplicate names, undeclared entries, digest mismatches,
malformed Protobuf, unsafe paths, and inconsistent indexes are fatal.
