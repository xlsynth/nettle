// SPDX-License-Identifier: Apache-2.0

import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { GraphPort, GraphSlice } from "../model/graph";
import { compareGraphSlices } from "./matcher";
import type { GraphMatcherWorkerRequest, GraphMatcherWorkerResponse } from "./matcher.worker";
import type { CompareGraphOptions, ComparisonSlice } from "./types";

const abortError = () => new DOMException("The operation was aborted", "AbortError");

export const GRAPH_MATCHER_TIMEOUT_MS = RESOURCE_LIMITS.browser.comparison.matcherTimeoutMs;
export const MAX_SYNCHRONOUS_MATCHER_WORK =
  RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode ** 2;

const matcherWork = (slice: GraphSlice) =>
  slice.nodes.length +
  slice.edges.length +
  (slice.groups?.length ?? 0) +
  slice.nodes.reduce((count, node) => count + node.ports.length + (node.origins?.length ?? 0), 0) +
  slice.edges.reduce((count, edge) => count + (edge.origins?.length ?? 0), 0) +
  (slice.groups ?? []).reduce((count, group) => count + (group.origins?.length ?? 0), 0);

const sourceMappingWork = (options: CompareGraphOptions) =>
  (options.sourceLineMappings ?? []).reduce(
    (count, mapping) => count + 1 + mapping.referenceToCandidate.size,
    0,
  );

const matcherTimeoutError = () => {
  const error = new Error(
    `Graph matching exceeded ${GRAPH_MATCHER_TIMEOUT_MS} ms; retry with conservative matching or a smaller visible hierarchy`,
  );
  error.name = "TimeoutError";
  return error;
};

const matcherWorkerUnavailableError = (work: number) => {
  const error = new Error(
    `Graph matching needs a worker for ${work} work items; synchronous fallback is limited to ${MAX_SYNCHRONOUS_MATCHER_WORK}`,
  );
  error.name = "MatcherWorkerUnavailableError";
  return error;
};

/** Reuses caller-owned input graphs instead of retaining worker-cloned snapshots. */
export const rebindComparisonInputs = (
  comparison: ComparisonSlice,
  reference: GraphSlice,
  candidate: GraphSlice,
): ComparisonSlice => {
  const referenceNodes = new Map(reference.nodes.map((node) => [node.id, node]));
  const candidateNodes = new Map(candidate.nodes.map((node) => [node.id, node]));
  const referenceEdges = new Map(reference.edges.map((edge) => [edge.id, edge]));
  const candidateEdges = new Map(candidate.edges.map((edge) => [edge.id, edge]));
  const referenceGroups = new Map((reference.groups ?? []).map((group) => [group.id, group]));
  const candidateGroups = new Map((candidate.groups ?? []).map((group) => [group.id, group]));
  const indexPorts = (nodes: GraphSlice["nodes"]) =>
    new Map(
      nodes.map((node) => [node.id, new Map(node.ports.map((port) => [port.id, port]))] as const),
    );
  const referencePorts = indexPorts(reference.nodes);
  const candidatePorts = indexPorts(candidate.nodes);
  const port = (
    ports: ReadonlyMap<string, ReadonlyMap<string, GraphPort>>,
    nodeId: string | undefined,
    portId: string,
  ) => ports.get(nodeId ?? "")?.get(portId);
  return {
    ...comparison,
    reference,
    candidate,
    nodes: comparison.nodes.map((entity) => ({
      ...entity,
      reference: entity.reference ? referenceNodes.get(entity.reference.id) : undefined,
      candidate: entity.candidate ? candidateNodes.get(entity.candidate.id) : undefined,
    })),
    ports: comparison.ports.map((entity) => ({
      ...entity,
      reference: entity.reference
        ? port(referencePorts, entity.referenceNodeId, entity.reference.id)
        : undefined,
      candidate: entity.candidate
        ? port(candidatePorts, entity.candidateNodeId, entity.candidate.id)
        : undefined,
    })),
    edges: comparison.edges.map((entity) => ({
      ...entity,
      reference: entity.reference ? referenceEdges.get(entity.reference.id) : undefined,
      candidate: entity.candidate ? candidateEdges.get(entity.candidate.id) : undefined,
    })),
    groups: comparison.groups.map((entity) => ({
      ...entity,
      reference: entity.reference ? referenceGroups.get(entity.reference.id) : undefined,
      candidate: entity.candidate ? candidateGroups.get(entity.candidate.id) : undefined,
    })),
  };
};

const compareWithoutWorker = (
  reference: GraphSlice,
  candidate: GraphSlice,
  options: CompareGraphOptions,
  signal?: AbortSignal,
): Promise<ComparisonSlice> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    queueMicrotask(() => {
      if (settled || signal?.aborted) {
        abort();
        return;
      }
      try {
        const result = compareGraphSlices(reference, candidate, options);
        if (settled || signal?.aborted) {
          abort();
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
  });

/**
 * Runs graph correspondence and union construction in a disposable Vite
 * worker. Graph slices and source-line `Map`s are sent with structured clone.
 * Aborting or crossing the generated wall-time ceiling terminates the worker,
 * so obsolete or adversarial requests cannot consume unbounded browser CPU or
 * publish a stale result. Workerless environments only run a small,
 * deterministically bounded synchronous fallback.
 */
export const compareGraphSlicesInWorker = (
  reference: GraphSlice,
  candidate: GraphSlice,
  options: CompareGraphOptions = {},
  signal?: AbortSignal,
): Promise<ComparisonSlice> => {
  if (signal?.aborted) return Promise.reject(abortError());
  if (typeof Worker === "undefined") {
    const work = matcherWork(reference) + matcherWork(candidate) + sourceMappingWork(options);
    if (work > MAX_SYNCHRONOUS_MATCHER_WORK) {
      return Promise.reject(matcherWorkerUnavailableError(work));
    }
    return compareWithoutWorker(reference, candidate, options, signal);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./matcher.worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      if (timeout !== undefined) clearTimeout(timeout);
      worker.terminate();
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abort = () => finish(() => reject(abortError()));
    timeout = setTimeout(
      () => finish(() => reject(matcherTimeoutError())),
      GRAPH_MATCHER_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "Graph matcher worker failed")));
    };
    worker.onmessage = (event: MessageEvent<GraphMatcherWorkerResponse>) => {
      finish(() => {
        if ("error" in event.data) {
          const error = new Error(event.data.error.message);
          error.name = event.data.error.name;
          reject(error);
        } else {
          resolve(rebindComparisonInputs(event.data.result, reference, candidate));
        }
      });
    };
    try {
      worker.postMessage({ reference, candidate, options } satisfies GraphMatcherWorkerRequest);
    } catch (error) {
      finish(() => reject(error));
    }
  });
};
