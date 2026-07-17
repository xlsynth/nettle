<!-- SPDX-License-Identifier: Apache-2.0 -->

# Nettle resource limits file format

[`resource-limits.yaml`](resource-limits.yaml) is the build-time single source
of truth for resource ceilings enforced by Nettle's Rust and TypeScript code.
It is repository policy, not an end-user or runtime configuration file. Nettle
does not accept a limits-file command-line option, and bundles cannot alter
these values.

The Rust build script validates the YAML and generates Rust constants in
Cargo's output directory. `scripts/generate-resource-limits.mjs` validates the
same YAML and generates `web/src/generated/resource-limits.ts`. Web build,
test, and lint commands fail if the committed TypeScript output is stale.

## Schema

The root mapping has `schemaVersion`, `bundle`, `native`, and `browser` fields.
Unknown or missing fields, non-positive values, unsafe JavaScript integers, and
unsupported schema versions are rejected during generation.

### Cross-language bundle limits

These values are a security and portability contract. Rust and TypeScript must
use the same value so a bundle accepted by native validation is not processed
under a different browser resource policy.

| YAML path                         | Default      | Purpose and rationale                                                                                                |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bundle.archive.eocdSearchBytes`  | 65,557 bytes | Covers the fixed ZIP EOCD record plus the maximum 65,535-byte ZIP comment.                                           |
| `bundle.archive.entryPathBytes`   | 1,024 bytes  | Bounds path parsing and comparison while remaining far above normal portable archive paths.                          |
| `bundle.archive.manifestBytes`    | 1 MiB        | The manifest is compact metadata; 1 MiB permits large indexes without allowing it to dominate memory.                |
| `bundle.archive.entryCount`       | 100,004      | Accommodates maximum module/source slices plus the four fixed bundle entries while bounding archive metadata.        |
| `bundle.archive.entryBytes`       | 64 MiB       | Bounds any one decompression/read allocation; large design graphs remain independently addressable.                  |
| `bundle.archive.totalBytes`       | 1 GiB        | Bounds expanded content and each anonymous native startup snapshot; comparison may retain two snapshots.             |
| `bundle.archive.compressionRatio` | 200:1        | Rejects extreme compression bombs while allowing highly repetitive HDL and JSON.                                     |
| `bundle.protobuf.stringBytes`     | 4 MiB        | Bounds individual decoded strings and JSON metadata values; ordinary names and source paths are many orders smaller. |
| `bundle.protobuf.modules`         | 50,000       | Bounds design-index navigation and module maps.                                                                      |
| `bundle.protobuf.sources`         | 50,000       | Bounds source indexes and browser file trees.                                                                        |
| `bundle.protobuf.graphObjects`    | 150,000      | Bounds the combined nodes, edges, and groups materialized for one graph.                                             |
| `bundle.protobuf.nodes`           | 50,000       | Bounds per-module node allocation and rendering work.                                                                |
| `bundle.protobuf.edges`           | 100,000      | Allows roughly two edges per maximum-size node set while bounding layout/rendering work.                             |
| `bundle.protobuf.groups`          | 50,000       | Bounds hierarchy and transparent-boundary structures.                                                                |
| `bundle.protobuf.graphFiles`      | 50,000       | Cannot exceed the supported source-index scale.                                                                      |
| `bundle.protobuf.ports`           | 250,000      | Allows an average of five ports per maximum-size node set while bounding nested allocations.                         |
| `bundle.protobuf.origins`         | 500,000      | Allows several provenance ranges per graph object while bounding cross-probe indexes.                                |
| `bundle.protobuf.metadataEntries` | 500,000      | Bounds parameter and attribute maps before object construction.                                                      |
| `bundle.protobuf.buildItems`      | 100,000      | Bounds combined build parameters, defines, undefines, and tool records.                                              |
| `bundle.protobuf.diagnostics`     | 100,000      | Retains substantial compiler feedback while bounding diagnostic allocation and display work.                         |
| `bundle.sourcePathComponents`     | 64           | Bounds recursive file-tree depth; real project layouts are expected to be substantially shallower.                   |

### Native build limits

These values protect compiler orchestration and import paths. They do not need
TypeScript equivalents because the browser never executes these operations.

| YAML path                              | Default      | Purpose and rationale                                                                           |
| -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `native.builder.sourceBytes`           | 4 MiB        | Bounds each embedded HDL source; unusually large generated sources should be split or excluded. |
| `native.builder.hostedSourceBytes`     | 32 MiB       | Bounds cumulative source bytes retained and encoded by one untrusted hosted build.              |
| `native.compiler.errorOutputBytes`     | 32 KiB       | Keeps displayed failure messages actionable and bounded.                                        |
| `native.compiler.processOutputBytes`   | 4 MiB/stream | Retains useful transcripts while continuously draining larger child-process output.             |
| `native.compiler.diagnosticsJsonBytes` | 64 MiB       | Matches the maximum bundle-entry scale and bounds diagnostics parsing.                          |
| `native.compiler.modelJsonBytes`       | 256 MiB      | Allows large compiler models while preventing unbounded AST/netlist reads.                      |
| `native.filelist.depth`                | 64           | Prevents stack exhaustion from deeply nested acyclic filelists.                                 |
| `native.filelist.files`                | 10,000       | Bounds repeated and broad nested-filelist expansion.                                            |
| `native.filelist.bytes`                | 64 MiB       | Bounds cumulative filelist text retained and tokenized.                                         |
| `native.filelist.tokens`               | 250,000      | Supports very large projects while bounding normalized argument collections.                    |
| `native.yosysImport.endpointPairs`     | 1,000,000    | Bounds driver-by-sink Cartesian-product work during connectivity import.                        |

### Browser-only limits

These values bound browser memory or display formatting. They do not change
bundle validity, except that projection is always capped by the shared graph
object limit rather than defining a second value.

| YAML path                                      | Default  | Purpose and rationale                                                                           |
| ---------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `browser.cache.modulesBytes`                   | 128 MiB  | Keeps several decoded module graphs hot without retaining an entire large bundle.               |
| `browser.cache.sourcesBytes`                   | 32 MiB   | Supports normal source navigation while bounding decoded source text.                           |
| `browser.load.entryConcurrency`                | 4        | Bounds module and source entry reads and decompressions shared by one bundle provider.          |
| `browser.comparison.sourceDiffTimeoutMs`       | 2,000 ms | Bounds one source-file diff computation so adversarial input cannot monopolize comparison work. |
| `browser.comparison.sourceDiffMaxEditLength`   | 100,000  | Bounds Myers edit search for highly dissimilar source files.                                    |
| `browser.comparison.sourceDiffConcurrency`     | 4        | Bounds concurrent source-pair mapping tasks across one comparison workspace.                    |
| `browser.comparison.sourceMappingFiles`        | 64       | Bounds modified source pairs inspected for one visible graph comparison.                        |
| `browser.comparison.sourceEvidenceModulePairs` | 512      | Bounds reachable module pairs decoded for source-only evidence and hierarchy change indexing.   |
| `browser.comparison.sourceEvidenceTimeoutMs`   | 5,000 ms | Bounds reachable-hierarchy work; exhaustion leaves source evidence or change status unknown.    |
| `browser.comparison.matcherTimeoutMs`          | 5,000 ms | Terminates a graph-matcher worker that cannot reach its deterministic fixed point promptly.     |
| `browser.comparison.fuzzyCandidatesPerNode`    | 32       | Prevents aggressive matching from degenerating into an all-pairs graph comparison.              |
| `browser.display.decimalConversionBits`        | 4,096    | Avoids expensive `BigInt` conversion of extremely wide binary values.                           |
| `browser.display.formattableConstantBits`      | 65,536   | Avoids constructing enormous reformatted literals in the inspector.                             |
| `browser.display.metadataDepth`                | 64       | Prevents recursive JSON stringification stack exhaustion.                                       |
| `browser.display.metadataNodes`                | 10,000   | Bounds iterative metadata traversal before display.                                             |
| `browser.display.metadataCharacters`           | 128 KiB  | Prevents inspector strings from duplicating large decoded metadata.                             |

## Changing limits

Change values only in `resource-limits.yaml`, update the rationale here, then
run:

```sh
npm run generate:limits
npm run check:limits
cargo test --locked
npm test
npm run build
```

Raising a `bundle` value changes the common reader compatibility envelope and
requires review of both native and browser allocation behavior. Lowering one
can make previously valid bundles unreadable and is therefore also a format
compatibility decision.
