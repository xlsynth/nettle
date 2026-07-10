// SPDX-License-Identifier: Apache-2.0

import { normalizePath, pathsReferToSameFile } from "../api/normalize";
import type {
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphSlice,
  JsonValue,
  SourceOrigin,
} from "../model/graph";
import type { SourceDiffHunk } from "./source-diff";
import type { ComparisonEntity, ComparisonSlice } from "./types";

export type ComparisonSourceSide = "reference" | "candidate";
export type SchematicSourceEvidence = "found" | "absent" | "unknown";

export interface ClassifiedSourceDiffHunk extends SourceDiffHunk {
  sourceOnly: boolean;
}

const entities = (comparison: ComparisonSlice) => [
  ...comparison.nodes,
  ...comparison.edges,
  ...comparison.groups,
];

type SourcePathRelationship = "match" | "other" | "unknown";

const pathBaseName = (path: string) => normalizePath(path).split("/").at(-1) ?? "";

const sourcePathRelationship = (
  sourcePath: string,
  selectedPath: string,
  inventoryPaths: readonly string[],
): SourcePathRelationship => {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedSelected = normalizePath(selectedPath);
  // An exact compiler path is authoritative even if another bundled file has the same basename.
  if (normalizedSource === normalizedSelected) return "match";

  const suffixMatches = inventoryPaths.filter((candidate) =>
    pathsReferToSameFile(sourcePath, candidate),
  );
  if (suffixMatches.length === 1) {
    return pathsReferToSameFile(suffixMatches[0], selectedPath) ? "match" : "other";
  }

  // A short compiler origin such as `foo.sv`, or an origin rooted outside the project, may
  // plausibly refer to the selected file. Ambiguity or failure to resolve that relevant origin
  // cannot be used as proof that the source change had no schematic effect.
  const plausiblySelected =
    pathsReferToSameFile(sourcePath, selectedPath) ||
    (pathBaseName(sourcePath) !== "" && pathBaseName(sourcePath) === pathBaseName(selectedPath));
  return plausiblySelected ? "unknown" : "other";
};

const resolvedPathMatches = (
  sourcePath: string,
  selectedPath: string,
  inventoryPaths: readonly string[],
) => sourcePathRelationship(sourcePath, selectedPath, inventoryPaths) === "match";

const originIntersects = (
  origin: SourceOrigin,
  path: string,
  startLine: number,
  endLine: number,
  inventoryPaths: readonly string[],
) => {
  return (
    resolvedPathMatches(origin.file, path, inventoryPaths) &&
    origin.startLine <= endLine &&
    (origin.endLine ?? origin.startLine) >= startLine
  );
};

const stableJsonValue = (value: JsonValue | undefined): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`)
    .join(",")}}`;
};

const moduleParametersDiffer = (comparison: ComparisonSlice) =>
  stableJsonValue(comparison.reference.module.parameters) !==
  stableJsonValue(comparison.candidate.module.parameters);

const slicePathEvidence = (
  slice: GraphSlice,
  path: string,
  inventoryPaths: readonly string[],
): SchematicSourceEvidence => {
  let unresolvedRelevantPath = false;
  for (const file of slice.files ?? []) {
    const relationship = sourcePathRelationship(file.path, path, inventoryPaths);
    if (relationship === "match") return "found";
    if (relationship === "unknown") unresolvedRelevantPath = true;
  }
  return unresolvedRelevantPath ? "unknown" : "absent";
};

const entityIntersects = (
  entity: ComparisonEntity<GraphNode | GraphEdge | GraphGroup>,
  side: ComparisonSourceSide,
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
  inventoryPaths: readonly string[],
) =>
  startLine !== undefined &&
  endLine !== undefined &&
  (entity[side]?.origins ?? []).some((origin) =>
    originIntersects(origin, path, startLine, endLine, inventoryPaths),
  );

interface OriginIndex {
  starts: number[];
  maximumEnds: number[];
  unresolvedRelevantOrigin: boolean;
}

const originIndex = (
  comparison: ComparisonSlice,
  side: ComparisonSourceSide,
  path: string,
  inventoryPaths: readonly string[],
): OriginIndex => {
  let unresolvedRelevantOrigin = false;
  const ranges = entities(comparison)
    .filter(({ status }) => status !== "unchanged")
    .flatMap((entity) => entity[side]?.origins ?? [])
    .filter((origin) => {
      const relationship = sourcePathRelationship(origin.file, path, inventoryPaths);
      if (relationship === "unknown") unresolvedRelevantOrigin = true;
      return relationship === "match";
    })
    .map((origin) => [origin.startLine, origin.endLine ?? origin.startLine] as const)
    .sort(([leftStart, leftEnd], [rightStart, rightEnd]) =>
      leftStart === rightStart ? leftEnd - rightEnd : leftStart - rightStart,
    );
  const starts: number[] = [];
  const maximumEnds: number[] = [];
  let maximumEnd = 0;
  for (const [start, end] of ranges) {
    starts.push(start);
    maximumEnd = Math.max(maximumEnd, end);
    maximumEnds.push(maximumEnd);
  }
  return { starts, maximumEnds, unresolvedRelevantOrigin };
};

const indexIntersects = (
  index: OriginIndex,
  startLine: number | undefined,
  endLine: number | undefined,
) => {
  if (startLine === undefined || endLine === undefined) return false;
  let low = 0;
  let high = index.starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((index.starts[middle] ?? Number.POSITIVE_INFINITY) <= endLine) low = middle + 1;
    else high = middle;
  }
  const lastStartAtOrBeforeEnd = low - 1;
  return (
    lastStartAtOrBeforeEnd >= 0 &&
    (index.maximumEnds[lastStartAtOrBeforeEnd] ?? Number.NEGATIVE_INFINITY) >= startLine
  );
};

const sourceEvidence = (
  comparison: ComparisonSlice,
  referencePath: string,
  candidatePath: string,
  referenceInventoryPaths: readonly string[],
  candidateInventoryPaths: readonly string[],
) => {
  const referenceOrigins = originIndex(
    comparison,
    "reference",
    referencePath,
    referenceInventoryPaths,
  );
  const candidateOrigins = originIndex(
    comparison,
    "candidate",
    candidatePath,
    candidateInventoryPaths,
  );
  // Origins usually point at the operator or net expression, not at declarations which
  // indirectly changed their elaboration. If this module has a changed object elsewhere in
  // the same file, claiming that a non-overlapping hunk is source-only would be misleading.
  const sameFileSchematicChange =
    referenceOrigins.starts.length > 0 || candidateOrigins.starts.length > 0;
  // Module parameter defaults are semantic schematic payload even when the importer has no
  // source range for the declaration itself. Limit this fallback to files referenced by the
  // visible module so an unrelated documentation-only bundled source stays source-only.
  const referenceModulePath = moduleParametersDiffer(comparison)
    ? slicePathEvidence(comparison.reference, referencePath, referenceInventoryPaths)
    : "absent";
  const candidateModulePath = moduleParametersDiffer(comparison)
    ? slicePathEvidence(comparison.candidate, candidatePath, candidateInventoryPaths)
    : "absent";
  const parameterChangeInModuleFile =
    referenceModulePath === "found" || candidateModulePath === "found";
  const unresolvedRelevantEvidence =
    referenceOrigins.unresolvedRelevantOrigin ||
    candidateOrigins.unresolvedRelevantOrigin ||
    referenceModulePath === "unknown" ||
    candidateModulePath === "unknown";
  const indirect = sameFileSchematicChange || parameterChangeInModuleFile;
  const status: SchematicSourceEvidence = indirect
    ? "found"
    : unresolvedRelevantEvidence
      ? "unknown"
      : "absent";
  return {
    referenceOrigins,
    candidateOrigins,
    indirect,
    status,
  };
};

/** Returns every changed overlay object intersecting a selected source range. */
export const changedComparisonEntitiesForSourceRange = (
  comparison: ComparisonSlice,
  side: ComparisonSourceSide,
  path: string,
  startLine: number,
  endLine: number,
  inventoryPaths: readonly string[] = [path],
) =>
  entities(comparison)
    .filter(
      (entity) =>
        entity.status !== "unchanged" &&
        entityIntersects(entity, side, path, startLine, endLine, inventoryPaths),
    )
    .map(({ id }) => id);

/** Returns found, absent, or unknown conservative evidence for one compared module. */
export const comparisonHasSchematicSourceEvidence = (
  comparison: ComparisonSlice,
  referencePath: string,
  candidatePath: string,
  referenceInventoryPaths: readonly string[] = [referencePath],
  candidateInventoryPaths: readonly string[] = [candidatePath],
) =>
  sourceEvidence(
    comparison,
    referencePath,
    candidatePath,
    referenceInventoryPaths,
    candidateInventoryPaths,
  ).status;

/** Marks hunks source-only only when no direct or conservative indirect schematic evidence exists. */
export const classifySourceDiffHunks = (
  comparison: ComparisonSlice,
  referencePath: string,
  candidatePath: string,
  hunks: readonly SourceDiffHunk[],
  referenceInventoryPaths: readonly string[] = [referencePath],
  candidateInventoryPaths: readonly string[] = [candidatePath],
): ClassifiedSourceDiffHunk[] => {
  const evidence = sourceEvidence(
    comparison,
    referencePath,
    candidatePath,
    referenceInventoryPaths,
    candidateInventoryPaths,
  );
  return hunks.map((hunk) => ({
    ...hunk,
    sourceOnly:
      evidence.status === "absent" &&
      !indexIntersects(evidence.referenceOrigins, hunk.referenceStartLine, hunk.referenceEndLine) &&
      !indexIntersects(evidence.candidateOrigins, hunk.candidateStartLine, hunk.candidateEndLine),
  }));
};
