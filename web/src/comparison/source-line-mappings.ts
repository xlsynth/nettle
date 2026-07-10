// SPDX-License-Identifier: Apache-2.0

import { normalizePath } from "../api/normalize";
import type { WorkspaceProvider } from "../bundle/provider";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { GraphSlice } from "../model/graph";
import { diffSourceTextsInWorker } from "./source-diff-client";
import type { SourceInventoryComparison, SourceLineMapping } from "./types";

type SourceProvider = Pick<WorkspaceProvider, "getSource">;
type SourceSide = "reference" | "candidate";

export interface SourceLineMappingResolverOptions {
  referenceProvider: SourceProvider;
  candidateProvider: SourceProvider;
  sources: readonly SourceInventoryComparison[];
  concurrency?: number;
}

const abortError = () => new DOMException("The operation was aborted", "AbortError");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError();
};

type IndexedSource = SourceInventoryComparison | null;

const indexValue = (
  index: Map<string, IndexedSource>,
  key: string,
  source: SourceInventoryComparison,
) => {
  if (!index.has(key)) {
    index.set(key, source);
  } else if (index.get(key)?.id !== source.id) {
    index.set(key, null);
  }
};

/** Resolves only exact paths or suffixes which identify one inventory entry. */
class SourcePathIndex {
  private readonly exact = new Map<string, IndexedSource>();
  private readonly suffix = new Map<string, IndexedSource>();

  constructor(sources: readonly SourceInventoryComparison[], side: SourceSide) {
    for (const source of sources) {
      const file = source[side];
      if (!file) continue;
      const path = normalizePath(file.path);
      indexValue(this.exact, path, source);
      const parts = path.split("/").filter(Boolean);
      for (let start = 0; start < parts.length; start += 1) {
        indexValue(this.suffix, parts.slice(start).join("/"), source);
      }
    }
  }

  resolve(originPath: string): SourceInventoryComparison | undefined {
    const normalized = normalizePath(originPath);
    if (this.exact.has(normalized)) return this.exact.get(normalized) ?? undefined;

    // Absolute compiler paths commonly end in a project-relative bundle path,
    // while some producers emit only a suffix of the bundle path. Both forms
    // are accepted only if their combined evidence names one inventory entry.
    const parts = normalized.split("/").filter(Boolean);
    const matches = new Map<string, SourceInventoryComparison>();
    let ambiguous = false;
    for (let start = 0; start < parts.length; start += 1) {
      const suffix = parts.slice(start).join("/");
      if (!this.exact.has(suffix)) continue;
      const source = this.exact.get(suffix);
      if (source) matches.set(source.id, source);
      else ambiguous = true;
    }

    const relative = parts.join("/");
    if (this.suffix.has(relative)) {
      const source = this.suffix.get(relative);
      if (source) matches.set(source.id, source);
      else ambiguous = true;
    }
    return !ambiguous && matches.size === 1 ? [...matches.values()][0] : undefined;
  }
}

const referencedLinesBySource = (slice: GraphSlice, side: SourceSide, paths: SourcePathIndex) => {
  const result = new Map<string, { source: SourceInventoryComparison; lines: Set<number> }>();
  for (const entity of [...slice.nodes, ...slice.edges, ...(slice.groups ?? [])]) {
    for (const origin of entity.origins ?? []) {
      const source = paths.resolve(origin.file);
      if (!source?.[side]) continue;
      let usage = result.get(source.id);
      if (!usage) {
        usage = { source, lines: new Set() };
        result.set(source.id, usage);
      }
      usage.lines.add(origin.startLine);
    }
  }
  return result;
};

interface QueuedTask {
  start: () => void;
  abort: () => void;
  signal?: AbortSignal;
}

/** One limiter shared by every source request in a comparison workspace. */
class TaskLimiter {
  private active = 0;
  private readonly queue: QueuedTask[] = [];

  constructor(private readonly maximum: number) {}

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const queued: QueuedTask = {
        signal,
        abort: () => {
          if (started) return;
          const index = this.queue.indexOf(queued);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener("abort", queued.abort);
          reject(abortError());
        },
        start: () => {
          if (signal?.aborted) {
            queued.abort();
            return;
          }
          started = true;
          signal?.removeEventListener("abort", queued.abort);
          this.active += 1;
          void operation()
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              this.pump();
            });
        },
      };
      signal?.addEventListener("abort", queued.abort, { once: true });
      this.queue.push(queued);
      this.pump();
    });
  }

  private pump() {
    while (this.active < this.maximum && this.queue.length > 0) {
      this.queue.shift()?.start();
    }
  }
}

interface InFlightMapping {
  controller: AbortController;
  promise: Promise<SourceLineMapping | null>;
  settled: boolean;
  waiters: number;
}

interface CompletedMapping {
  value: SourceLineMapping | null;
  weight: number;
}

const MAX_COMPLETED_MAPPING_REQUESTS =
  RESOURCE_LIMITS.browser.comparison.sourceDiffConcurrency * 64;
const MAX_COMPLETED_MAPPING_LINES = RESOURCE_LIMITS.bundle.protobuf.graphObjects;

const waitForMapping = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

const mappingRequestKey = (sourceId: string, lines: readonly number[]) =>
  JSON.stringify([sourceId, lines]);

const identityMapping = (
  source: SourceInventoryComparison,
  referenceLines: readonly number[],
): SourceLineMapping | undefined => {
  if (!source.reference || !source.candidate) return undefined;
  return {
    referencePath: normalizePath(source.reference.path),
    candidatePath: normalizePath(source.candidate.path),
    referenceToCandidate: new Map(referenceLines.map((line) => [line, line] as const)),
    pathPaired: true,
  };
};

const pathOnlyMapping = (source: SourceInventoryComparison): SourceLineMapping | undefined => {
  if (!source.reference || !source.candidate) return undefined;
  return {
    referencePath: normalizePath(source.reference.path),
    candidatePath: normalizePath(source.candidate.path),
    referenceToCandidate: new Map(),
    pathPaired: true,
  };
};

/**
 * Resolves source-line correspondences only for origin lines used by a graph
 * pair. Exact or uniquely resolved source paths prevent conservative matching
 * from guessing between duplicate basenames. Source work for all concurrent
 * hierarchy requests shares one limiter, and identical in-flight requests are
 * reference counted so one aborted consumer cannot cancel another.
 */
export class SourceLineMappingResolver {
  private readonly referenceProvider: SourceProvider;
  private readonly candidateProvider: SourceProvider;
  private readonly referencePaths: SourcePathIndex;
  private readonly candidatePaths: SourcePathIndex;
  private readonly limiter: TaskLimiter;
  private readonly concurrency: number;
  private readonly completedByRequest = new Map<string, CompletedMapping>();
  private completedMappingWeight = 0;
  private readonly inFlight = new Map<string, InFlightMapping>();
  private readonly completedByPair = new WeakMap<
    GraphSlice,
    WeakMap<GraphSlice, readonly SourceLineMapping[]>
  >();

  constructor(options: SourceLineMappingResolverOptions) {
    this.referenceProvider = options.referenceProvider;
    this.candidateProvider = options.candidateProvider;
    this.referencePaths = new SourcePathIndex(options.sources, "reference");
    this.candidatePaths = new SourcePathIndex(options.sources, "candidate");
    const concurrency =
      options.concurrency ?? RESOURCE_LIMITS.browser.comparison.sourceDiffConcurrency;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Source diff concurrency must be a positive safe integer");
    }
    this.concurrency = concurrency;
    this.limiter = new TaskLimiter(concurrency);
  }

  private cachedPair(reference: GraphSlice, candidate: GraphSlice) {
    return this.completedByPair.get(reference)?.get(candidate);
  }

  private cachePair(
    reference: GraphSlice,
    candidate: GraphSlice,
    mappings: readonly SourceLineMapping[],
  ) {
    let byCandidate = this.completedByPair.get(reference);
    if (!byCandidate) {
      byCandidate = new WeakMap();
      this.completedByPair.set(reference, byCandidate);
    }
    byCandidate.set(candidate, mappings);
  }

  private completedMapping(key: string): CompletedMapping | undefined {
    const cached = this.completedByRequest.get(key);
    if (!cached) return undefined;
    this.completedByRequest.delete(key);
    this.completedByRequest.set(key, cached);
    return cached;
  }

  private cacheCompletedMapping(key: string, value: SourceLineMapping | null) {
    const previous = this.completedByRequest.get(key);
    if (previous) this.completedMappingWeight -= previous.weight;
    this.completedByRequest.delete(key);
    const weight = Math.max(1, value?.referenceToCandidate.size ?? 0);
    if (weight > MAX_COMPLETED_MAPPING_LINES) return;
    this.completedByRequest.set(key, { value, weight });
    this.completedMappingWeight += weight;
    while (
      this.completedByRequest.size > MAX_COMPLETED_MAPPING_REQUESTS ||
      this.completedMappingWeight > MAX_COMPLETED_MAPPING_LINES
    ) {
      const oldest = this.completedByRequest.entries().next().value as
        | [string, CompletedMapping]
        | undefined;
      if (!oldest) break;
      this.completedByRequest.delete(oldest[0]);
      this.completedMappingWeight -= oldest[1].weight;
    }
  }

  private startMapping(
    key: string,
    source: SourceInventoryComparison,
    referenceLines: readonly number[],
  ): InFlightMapping {
    const controller = new AbortController();
    const entry: InFlightMapping = {
      controller,
      promise: Promise.resolve(null),
      settled: false,
      waiters: 0,
    };
    entry.promise = this.limiter.run(async () => {
      const referenceSource = source.reference;
      const candidateSource = source.candidate;
      if (!referenceSource || !candidateSource) return null;
      const [referenceBody, candidateBody] = await Promise.all([
        this.referenceProvider.getSource(referenceSource.id, controller.signal),
        this.candidateProvider.getSource(candidateSource.id, controller.signal),
      ]);
      const diff = await diffSourceTextsInWorker(
        referenceBody.path,
        candidateBody.path,
        referenceBody.content,
        candidateBody.content,
        { referenceLines },
        controller.signal,
      );
      // Even a bounded text diff still proves which inventory paths are paired.
      // Aggressive matching can use that weaker same-file evidence without
      // treating it as an exact conservative line correspondence.
      return { ...diff.lineMapping, pathPaired: true };
    }, controller.signal);
    entry.promise.then(
      (mapping) => {
        entry.settled = true;
        this.cacheCompletedMapping(key, mapping);
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      },
      () => {
        entry.settled = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, entry);
    return entry;
  }

  private async mappingForSource(
    source: SourceInventoryComparison,
    referenceLinesInput: readonly number[],
    signal?: AbortSignal,
  ): Promise<SourceLineMapping | undefined> {
    throwIfAborted(signal);
    const referenceSource = source.reference;
    const candidateSource = source.candidate;
    if (!referenceSource || !candidateSource) return undefined;
    const referenceLines = [...new Set(referenceLinesInput)].sort((left, right) => left - right);
    if (
      referenceSource.sha256 === candidateSource.sha256 &&
      (source.status === "unchanged" || source.status === "renamed")
    ) {
      return identityMapping(source, referenceLines);
    }
    if (source.status !== "modified") return undefined;
    const sourceByteLimit = RESOURCE_LIMITS.native.builder.sourceBytes;
    if (referenceSource.size > sourceByteLimit || candidateSource.size > sourceByteLimit) {
      return pathOnlyMapping(source);
    }

    const key = mappingRequestKey(source.id, referenceLines);
    const completed = this.completedMapping(key);
    if (completed) return completed.value ?? undefined;
    const entry = this.inFlight.get(key) ?? this.startMapping(key, source, referenceLines);
    entry.waiters += 1;
    try {
      return (await waitForMapping(entry.promise, signal)) ?? undefined;
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    }
  }

  async resolve(
    reference: GraphSlice,
    candidate: GraphSlice,
    signal?: AbortSignal,
  ): Promise<readonly SourceLineMapping[]> {
    throwIfAborted(signal);
    const cached = this.cachedPair(reference, candidate);
    if (cached) return cached;

    const referenceUsage = referencedLinesBySource(reference, "reference", this.referencePaths);
    const candidateUsage = referencedLinesBySource(candidate, "candidate", this.candidatePaths);
    const relevant = [...referenceUsage.values()]
      .filter(
        ({ source }) =>
          candidateUsage.has(source.id) &&
          source.reference !== undefined &&
          source.candidate !== undefined,
      )
      .sort((left, right) =>
        left.source.id < right.source.id ? -1 : left.source.id > right.source.id ? 1 : 0,
      )
      .slice(0, RESOURCE_LIMITS.browser.comparison.sourceMappingFiles);
    const resolved: Array<SourceLineMapping | undefined> = new Array(relevant.length);
    let next = 0;
    const worker = async () => {
      while (next < relevant.length) {
        throwIfAborted(signal);
        const index = next;
        next += 1;
        const { source, lines } = relevant[index];
        resolved[index] = await this.mappingForSource(source, [...lines], signal);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, relevant.length) }, () => worker()),
    );
    throwIfAborted(signal);
    const mappings = resolved.filter(
      (mapping): mapping is SourceLineMapping => mapping !== undefined,
    );
    this.cachePair(reference, candidate, mappings);
    return mappings;
  }
}
