// SPDX-License-Identifier: Apache-2.0

export {
  type ReachableHierarchySourceEvidenceOptions,
  reachableHierarchyHasSchematicSourceEvidence,
  type SourceEvidenceSlicePair,
} from "./hierarchy-source-evidence";
export { compareGraphSlices, MAX_COMPARISON_OBJECTS, modulePayloadEqual } from "./matcher";
export { compareGraphSlicesInWorker } from "./matcher-client";
export type { ExpandComparisonInstanceOptions } from "./projection";
export { expandComparisonInstance, scopeComparisonIdentity } from "./projection";
export type {
  ClassifiedSourceDiffHunk,
  ComparisonSourceSide,
  SchematicSourceEvidence,
} from "./source-cross-probe";
export {
  changedComparisonEntitiesForSourceRange,
  classifySourceDiffHunks,
  comparisonHasSchematicSourceEvidence,
} from "./source-cross-probe";
export type {
  BoundedSourceTextDiff,
  CompleteSourceTextDiff,
  SourceDiffHunk,
  SourceDiffOptions,
  SourceLineChange,
  SourceTextDiff,
} from "./source-diff";
export {
  changedSourceHunks,
  diffSourceTexts,
  diffSourceTextsAsync,
  sourceBytesTooLargeDiff,
} from "./source-diff";
export { diffSourceTextsInWorker } from "./source-diff-client";
export { compareSourceInventories } from "./source-inventory";
export {
  SourceLineMappingResolver,
  type SourceLineMappingResolverOptions,
} from "./source-line-mappings";
export type {
  CompareGraphOptions,
  ComparisonEntity,
  ComparisonPort,
  ComparisonSlice,
  ComparisonWorkspace,
  DiffStatus,
  MatchConfidence,
  MatchConfidenceBand,
  MatchingPolicy,
  MatchMetadata,
  MatchMethod,
  SourceDiffStatus,
  SourceInventoryComparison,
  SourceLineMapping,
} from "./types";
