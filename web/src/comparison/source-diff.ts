// SPDX-License-Identifier: Apache-2.0

import { type Change, diffLines } from "diff";
import { normalizePath } from "../api/normalize";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { SourceLineMapping } from "./types";

export interface SourceLineChange {
  value: string;
  count: number;
  added: boolean;
  removed: boolean;
  referenceStartLine?: number;
  candidateStartLine?: number;
}

export interface CompleteSourceTextDiff {
  status: "complete";
  changes: SourceLineChange[];
  lineMapping: SourceLineMapping;
}

export interface BoundedSourceTextDiff {
  status: "tooLarge";
  reason: "sourceBytes" | "editLength" | "timeout";
  changes: [];
  lineMapping: SourceLineMapping;
}

export type SourceTextDiff = CompleteSourceTextDiff | BoundedSourceTextDiff;

export interface SourceDiffHunk {
  referenceStartLine?: number;
  referenceEndLine?: number;
  candidateStartLine?: number;
  candidateEndLine?: number;
}

export interface SourceDiffOptions {
  timeoutMs?: number;
  maxEditLength?: number;
  maxSourceBytes?: number;
  /**
   * Reference lines whose old-to-new correspondence is needed by graph
   * matching. Source presentation does not need a mapping, so an omitted list
   * deliberately produces an empty map instead of one entry per source line.
   */
  referenceLines?: readonly number[];
}

const emptyMapping = (referencePath: string, candidatePath: string): SourceLineMapping => ({
  referencePath: normalizePath(referencePath),
  candidatePath: normalizePath(candidatePath),
  referenceToCandidate: new Map(),
});

export const sourceBytesTooLargeDiff = (
  referencePath: string,
  candidatePath: string,
): BoundedSourceTextDiff => ({
  status: "tooLarge",
  reason: "sourceBytes",
  changes: [],
  lineMapping: emptyMapping(referencePath, candidatePath),
});

const inputWithinLimit = (text: string, maximum: number) =>
  new TextEncoder().encode(text).length <= maximum;

const completeDiff = (
  referencePath: string,
  candidatePath: string,
  changes: Change[],
  requestedReferenceLines: readonly number[],
): CompleteSourceTextDiff => {
  let referenceLine = 1;
  let candidateLine = 1;
  const referenceToCandidate = new Map<number, number>();
  let requestedIndex = 0;
  const positioned = changes.map((change): SourceLineChange => {
    const result: SourceLineChange = {
      value: change.value,
      count: change.count,
      added: change.added,
      removed: change.removed,
      ...(!change.added ? { referenceStartLine: referenceLine } : {}),
      ...(!change.removed ? { candidateStartLine: candidateLine } : {}),
    };
    if (!change.added && !change.removed) {
      const referenceEnd = referenceLine + change.count - 1;
      while (
        requestedIndex < requestedReferenceLines.length &&
        requestedReferenceLines[requestedIndex] < referenceLine
      ) {
        requestedIndex += 1;
      }
      while (
        requestedIndex < requestedReferenceLines.length &&
        requestedReferenceLines[requestedIndex] <= referenceEnd
      ) {
        const requestedLine = requestedReferenceLines[requestedIndex];
        referenceToCandidate.set(requestedLine, candidateLine + requestedLine - referenceLine);
        requestedIndex += 1;
      }
    }
    if (!change.added) referenceLine += change.count;
    if (!change.removed) candidateLine += change.count;
    return result;
  });
  return {
    status: "complete",
    changes: positioned,
    lineMapping: {
      referencePath: normalizePath(referencePath),
      candidatePath: normalizePath(candidatePath),
      referenceToCandidate,
    },
  };
};

const normalizedReferenceLines = (lines: readonly number[] | undefined): number[] => {
  if (!lines) return [];
  const result = new Set<number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line) || line < 1) {
      throw new Error("Source diff reference lines must be positive safe integers");
    }
    result.add(line);
  }
  return [...result].sort((left, right) => left - right);
};

/** Groups adjacent additions and removals into source-diff hunks. */
export const changedSourceHunks = (diff: CompleteSourceTextDiff): SourceDiffHunk[] => {
  const hunks: SourceDiffHunk[] = [];
  let current: SourceDiffHunk | undefined;
  const extend = (side: "reference" | "candidate", start: number, count: number) => {
    current ??= {};
    const startKey = `${side}StartLine` as const;
    const endKey = `${side}EndLine` as const;
    current[startKey] = Math.min(current[startKey] ?? start, start);
    current[endKey] = Math.max(current[endKey] ?? start, start + Math.max(1, count) - 1);
  };
  const flush = () => {
    if (current) hunks.push(current);
    current = undefined;
  };
  for (const change of diff.changes) {
    if (!change.added && !change.removed) {
      flush();
      continue;
    }
    if (change.removed && change.referenceStartLine !== undefined) {
      extend("reference", change.referenceStartLine, change.count);
    }
    if (change.added && change.candidateStartLine !== undefined) {
      extend("candidate", change.candidateStartLine, change.count);
    }
  }
  flush();
  return hunks;
};

const limitsFor = (options: SourceDiffOptions) => ({
  timeout: options.timeoutMs ?? RESOURCE_LIMITS.browser.comparison.sourceDiffTimeoutMs,
  maxEditLength:
    options.maxEditLength ?? RESOURCE_LIMITS.browser.comparison.sourceDiffMaxEditLength,
  maxSourceBytes: options.maxSourceBytes ?? RESOURCE_LIMITS.native.builder.sourceBytes,
});

/** Synchronous bounded line diff, suitable for a dedicated worker. */
export const diffSourceTexts = (
  referencePath: string,
  candidatePath: string,
  referenceText: string,
  candidateText: string,
  options: SourceDiffOptions = {},
): SourceTextDiff => {
  const limits = limitsFor(options);
  const referenceLines = normalizedReferenceLines(options.referenceLines);
  if (
    !inputWithinLimit(referenceText, limits.maxSourceBytes) ||
    !inputWithinLimit(candidateText, limits.maxSourceBytes)
  ) {
    return sourceBytesTooLargeDiff(referencePath, candidatePath);
  }
  const startedAt = performance.now();
  const changes = diffLines(referenceText, candidateText, {
    timeout: limits.timeout,
    maxEditLength: limits.maxEditLength,
  });
  if (!changes) {
    return {
      status: "tooLarge",
      reason: performance.now() - startedAt >= limits.timeout ? "timeout" : "editLength",
      changes: [],
      lineMapping: emptyMapping(referencePath, candidatePath),
    };
  }
  return completeDiff(referencePath, candidatePath, changes, referenceLines);
};

/**
 * Event-loop-friendly bounded diff used when no worker is installed. An abort
 * rejects the caller promptly; the diff library may finish its already queued
 * internal work, but its stale result is ignored.
 */
export const diffSourceTextsAsync = (
  referencePath: string,
  candidatePath: string,
  referenceText: string,
  candidateText: string,
  options: SourceDiffOptions = {},
  signal?: AbortSignal,
): Promise<SourceTextDiff> => {
  const limits = limitsFor(options);
  let referenceLines: number[];
  try {
    referenceLines = normalizedReferenceLines(options.referenceLines);
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    !inputWithinLimit(referenceText, limits.maxSourceBytes) ||
    !inputWithinLimit(candidateText, limits.maxSourceBytes)
  ) {
    return Promise.resolve(sourceBytesTooLargeDiff(referencePath, candidatePath));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const startedAt = performance.now();
    diffLines(referenceText, candidateText, {
      timeout: limits.timeout,
      maxEditLength: limits.maxEditLength,
      callback: (changes) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return;
        if (!changes) {
          resolve({
            status: "tooLarge",
            reason: performance.now() - startedAt >= limits.timeout ? "timeout" : "editLength",
            changes: [],
            lineMapping: emptyMapping(referencePath, candidatePath),
          });
          return;
        }
        resolve(completeDiff(referencePath, candidatePath, changes, referenceLines));
      },
    });
  });
};
