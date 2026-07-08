// SPDX-License-Identifier: Apache-2.0

import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { GraphSlice } from "../model/graph";
import {
  comparisonHasSchematicSourceEvidence,
  type SchematicSourceEvidence,
} from "./source-cross-probe";
import type { ComparisonEntity, ComparisonSlice } from "./types";

export interface SourceEvidenceSlicePair {
  reference: GraphSlice;
  candidate: GraphSlice;
}

export interface ReachableHierarchySourceEvidenceOptions<
  TPair extends SourceEvidenceSlicePair = SourceEvidenceSlicePair,
> {
  root: TPair;
  referencePath: string;
  candidatePath: string;
  referenceInventoryPaths?: readonly string[];
  candidateInventoryPaths?: readonly string[];
  maximumModulePairs?: number;
  timeoutMs?: number;
  now?: () => number;
  comparePair: (pair: TPair, signal: AbortSignal) => Promise<ComparisonSlice>;
  loadChildPair: (
    pair: TPair,
    instance: ComparisonEntity<GraphSlice["nodes"][number]>,
    signal: AbortSignal,
  ) => Promise<TPair>;
}

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
};

const pairKey = (pair: SourceEvidenceSlicePair) =>
  JSON.stringify([
    pair.reference.snapshotId,
    pair.reference.module.id,
    pair.candidate.snapshotId,
    pair.candidate.module.id,
  ]);

/**
 * Searches only the paired graph hierarchy reachable from the selected roots.
 * Graph slices are loaded on demand and repeated specializations are visited once;
 * source bodies are never requested by this traversal itself.
 */
export const reachableHierarchyHasSchematicSourceEvidence = async <
  TPair extends SourceEvidenceSlicePair,
>(
  options: ReachableHierarchySourceEvidenceOptions<TPair>,
  signal: AbortSignal,
): Promise<SchematicSourceEvidence> => {
  const referenceInventoryPaths = options.referenceInventoryPaths ?? [options.referencePath];
  const candidateInventoryPaths = options.candidateInventoryPaths ?? [options.candidatePath];
  const maximumModulePairs =
    options.maximumModulePairs ?? RESOURCE_LIMITS.browser.comparison.sourceEvidenceModulePairs;
  const timeoutMs = options.timeoutMs ?? RESOURCE_LIMITS.browser.comparison.sourceEvidenceTimeoutMs;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let deadlineExpired = false;
  const operationController = new AbortController();
  const abortForCaller = () => operationController.abort(signal.reason);
  if (signal.aborted) abortForCaller();
  else signal.addEventListener("abort", abortForCaller, { once: true });
  const timeoutHandle = globalThis.setTimeout(() => {
    deadlineExpired = true;
    operationController.abort(
      new DOMException("Source evidence traversal timed out", "TimeoutError"),
    );
  }, timeoutMs);
  const timedOut = () => deadlineExpired || now() - startedAt >= timeoutMs;
  const queue: TPair[] = [options.root];
  const visited = new Set<string>();
  const queuedDefinitions = new Set<string>();
  let unresolvedRelevantEvidence = false;

  try {
    for (let index = 0; index < queue.length; index += 1) {
      throwIfAborted(signal);
      if (timedOut()) return "unknown";
      const pair = queue[index];
      const key = pairKey(pair);
      if (visited.has(key)) continue;
      visited.add(key);

      const comparison = await options.comparePair(pair, operationController.signal);
      throwIfAborted(signal);
      if (timedOut()) return "unknown";
      const evidence = comparisonHasSchematicSourceEvidence(
        comparison,
        options.referencePath,
        options.candidatePath,
        referenceInventoryPaths,
        candidateInventoryPaths,
      );
      if (timedOut()) return "unknown";
      if (evidence === "found") return "found";
      if (evidence === "unknown") unresolvedRelevantEvidence = true;

      const instances = comparison.nodes
        .filter(
          (entity) =>
            (entity.reference?.kind === "module" && entity.reference.definitionName) ||
            (entity.candidate?.kind === "module" && entity.candidate.definitionName),
        )
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      if (timedOut()) return "unknown";
      for (const instance of instances) {
        throwIfAborted(signal);
        if (timedOut()) return "unknown";
        const definitionKey = JSON.stringify([
          instance.reference?.definitionName ?? null,
          instance.candidate?.definitionName ?? null,
        ]);
        if (queuedDefinitions.has(definitionKey)) continue;
        if (queue.length >= maximumModulePairs) return "unknown";
        queuedDefinitions.add(definitionKey);
        const childPair = await options.loadChildPair(pair, instance, operationController.signal);
        throwIfAborted(signal);
        if (timedOut()) return "unknown";
        queue.push(childPair);
      }
    }
    if (timedOut()) return "unknown";
    return unresolvedRelevantEvidence ? "unknown" : "absent";
  } catch (reason) {
    if (deadlineExpired && !signal.aborted) return "unknown";
    throw reason;
  } finally {
    globalThis.clearTimeout(timeoutHandle);
    signal.removeEventListener("abort", abortForCaller);
  }
};
