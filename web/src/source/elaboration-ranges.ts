// SPDX-License-Identifier: Apache-2.0

import { normalizePath } from "../api/normalize";
import type { GraphSlice, SourceElaborationRange } from "../model/graph";

const rangeKey = (range: SourceElaborationRange) =>
  JSON.stringify([range.file, range.startLine, range.startColumn, range.endLine, range.endColumn]);

const compareRanges = (left: SourceElaborationRange, right: SourceElaborationRange) =>
  left.file.localeCompare(right.file) ||
  left.startLine - right.startLine ||
  left.startColumn - right.startColumn ||
  left.endLine - right.endLine ||
  left.endColumn - right.endColumn;

export const mergeElaborationRanges = (
  left: readonly SourceElaborationRange[] | undefined,
  right: readonly SourceElaborationRange[] | undefined,
  maximum: number,
): SourceElaborationRange[] | undefined => {
  // Preserve the absence of slice-scoped metadata so pre-release projections
  // continue to use their source-index ranges.
  if (left === undefined && right === undefined) return undefined;
  const merged = new Map<string, SourceElaborationRange>();
  for (const ranges of [left, right]) {
    for (const range of ranges ?? []) {
      const key = rangeKey(range);
      const existing = merged.get(key);
      if (existing) {
        existing.active ||= range.active;
        continue;
      }
      if (merged.size >= maximum) {
        throw new Error(
          `Projected graph would have ${merged.size + 1} elaboration ranges, exceeding budget ${maximum}`,
        );
      }
      merged.set(key, { ...range });
    }
  }
  return [...merged.values()].sort(compareRanges);
};

export const elaborationRangesForSource = (
  slice: GraphSlice,
  path: string,
  fallback: readonly SourceElaborationRange[] = [],
): SourceElaborationRange[] => {
  if (slice.elaborationRanges === undefined) return [...fallback];
  const normalizedPath = normalizePath(path);
  return slice.elaborationRanges.filter((range) => normalizePath(range.file) === normalizedPath);
};
