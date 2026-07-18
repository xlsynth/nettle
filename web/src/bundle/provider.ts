// SPDX-License-Identifier: Apache-2.0

import type {
  ApiGraphSlice,
  GraphSliceRequest,
  ProjectResponse,
  SourceInventoryEntry,
  SourceResponse,
  TreeResponse,
} from "../api/contracts";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import { flattenSelected, flattenSlice, MAX_PROJECTION_OBJECTS } from "./projection";
import {
  type BundleDesignIndex,
  type BundleSourceFile,
  DESIGN_INDEX_DECODE_LIMITS,
  decodeDesignIndex,
  decodeDiagnostics,
  decodeGraphSlice,
  decodeSourceIndex,
  GRAPH_DECODE_LIMITS,
  projectResponseFromBundle,
  SOURCE_INDEX_DECODE_LIMITS,
} from "./protobuf";
import { NettleBundle } from "./zip";

const MAX_GRAPH_OBJECTS = Math.min(GRAPH_DECODE_LIMITS.graphObjects, MAX_PROJECTION_OBJECTS);
const MAX_MODULES = DESIGN_INDEX_DECODE_LIMITS.modules;
const MAX_SOURCES = SOURCE_INDEX_DECODE_LIMITS.sources;
const MAX_NODES = GRAPH_DECODE_LIMITS.nodes;
const MAX_EDGES = GRAPH_DECODE_LIMITS.edges;
const MAX_PORTS = GRAPH_DECODE_LIMITS.ports;
const MAX_ORIGINS = GRAPH_DECODE_LIMITS.origins;
const MAX_MODULE_CACHE_BYTES = RESOURCE_LIMITS.browser.cache.modulesBytes;
const MAX_SOURCE_CACHE_BYTES = RESOURCE_LIMITS.browser.cache.sourcesBytes;
export const MAX_BUNDLE_LOAD_CONCURRENCY = RESOURCE_LIMITS.browser.load.entryConcurrency;
export interface BundleCacheLimits {
  modulesBytes: number;
  sourcesBytes: number;
}
export const DEFAULT_BUNDLE_CACHE_LIMITS = {
  modulesBytes: MAX_MODULE_CACHE_BYTES,
  sourcesBytes: MAX_SOURCE_CACHE_BYTES,
} as const;
export const COMPARISON_BUNDLE_CACHE_LIMITS = {
  modulesBytes: Math.floor(MAX_MODULE_CACHE_BYTES / 2),
  sourcesBytes: Math.floor(MAX_SOURCE_CACHE_BYTES / 2),
} as const;
export const MAX_SOURCE_PATH_DEPTH = RESOURCE_LIMITS.bundle.sourcePathComponents;
export const MAX_SOURCE_PATH_BYTES = RESOURCE_LIMITS.bundle.archive.entryPathBytes;
const pathEncoder = new TextEncoder();

interface CacheEntry<T> {
  value: T;
  bytes: number;
}

/** @internal Byte-accounted cache used by decoded bundle data. */
export class ByteLru<T> {
  private readonly values = new Map<string, CacheEntry<T>>();
  private total = 0;

  constructor(private readonly maximum: number) {}

  get(key: string) {
    const found = this.values.get(key);
    if (!found) return undefined;
    this.values.delete(key);
    this.values.set(key, found);
    return found.value;
  }

  set(key: string, value: T, bytes: number) {
    const previous = this.values.get(key);
    if (previous) this.total -= previous.bytes;
    this.values.delete(key);
    if (bytes > this.maximum) return;
    this.values.set(key, { value, bytes });
    this.total += bytes;
    while (this.total > this.maximum && this.values.size > 1) {
      const oldest = this.values.entries().next().value as [string, CacheEntry<T>] | undefined;
      if (!oldest) break;
      this.values.delete(oldest[0]);
      this.total -= oldest[1].bytes;
    }
  }
}

const abortError = () => new DOMException("The operation was aborted", "AbortError");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? abortError();
};

interface QueuedLoad {
  start: () => void;
}

class LoadLimiter {
  private active = 0;
  private readonly queue: QueuedLoad[] = [];

  constructor(private readonly maximum: number) {}

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      const job: QueuedLoad = {
        start: () => {
          if (settled) return;
          if (signal.aborted) {
            settled = true;
            signal.removeEventListener("abort", abort);
            reject(signal.reason ?? abortError());
            return;
          }
          started = true;
          signal.removeEventListener("abort", abort);
          this.active += 1;
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              settled = true;
              this.active -= 1;
              this.drain();
            });
        },
      };
      const abort = () => {
        if (started || settled) return;
        settled = true;
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason ?? abortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.maximum) {
      const job = this.queue.shift();
      if (!job) return;
      job.start();
    }
  }
}

interface PendingLoad<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

const waitForSharedLoad = <T>(
  pending: PendingLoad<T>,
  signal: AbortSignal | undefined,
  abandon: () => void,
): Promise<T> => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  pending.waiters += 1;
  return new Promise<T>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", abort);
      pending.waiters -= 1;
      if (pending.waiters === 0 && !pending.settled) abandon();
    };
    const abort = () => {
      release();
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    pending.promise.then(
      (value) => {
        if (signal?.aborted) {
          abort();
          return;
        }
        release();
        resolve(value);
      },
      (reason: unknown) => {
        release();
        reject(reason);
      },
    );
  });
};

export const makeTree = (files: BundleSourceFile[]): TreeResponse => {
  interface MutableTree {
    directories: Map<string, MutableTree>;
    files: BundleSourceFile[];
  }
  const root: MutableTree = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    if (
      !file.path ||
      pathEncoder.encode(file.path).length > MAX_SOURCE_PATH_BYTES ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Source path ${JSON.stringify(file.path)} is unsafe`);
    }
    if (parts.length > MAX_SOURCE_PATH_DEPTH) {
      throw new Error(
        `Source path ${JSON.stringify(file.path)} exceeds the supported depth ${MAX_SOURCE_PATH_DEPTH}`,
      );
    }
    let current = root;
    for (const directory of parts.slice(0, -1)) {
      let child = current.directories.get(directory);
      if (!child) {
        child = { directories: new Map(), files: [] };
        current.directories.set(directory, child);
      }
      current = child;
    }
    current.files.push(file);
  }
  const entries = (node: MutableTree, prefix: string): TreeResponse["entries"] => [
    ...[...node.directories.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => ({
        name,
        path: prefix ? `${prefix}/${name}` : name,
        kind: "directory" as const,
        children: entries(child, prefix ? `${prefix}/${name}` : name),
      })),
    ...[...node.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        name: file.path.split("/").at(-1) ?? file.path,
        path: file.path,
        kind: "file" as const,
        fileId: file.id,
      })),
  ];
  return { root: "", entries: entries(root, "") };
};

export interface WorkspaceProvider {
  getProject(signal?: AbortSignal): Promise<ProjectResponse>;
  getTree(signal?: AbortSignal): Promise<TreeResponse>;
  getSourceInventory(signal?: AbortSignal): Promise<SourceInventoryEntry[]>;
  getSource(fileId: string, signal?: AbortSignal): Promise<SourceResponse>;
  getGraphSlice(request: GraphSliceRequest, signal?: AbortSignal): Promise<ApiGraphSlice>;
}

export class LocalBundleProvider implements WorkspaceProvider {
  private readonly modules: ByteLru<ApiGraphSlice>;
  private readonly sourceContents: ByteLru<string>;
  private readonly moduleLoads = new Map<string, PendingLoad<ApiGraphSlice>>();
  private readonly sourceLoads = new Map<string, PendingLoad<string>>();
  private readonly loadLimiter = new LoadLimiter(MAX_BUNDLE_LOAD_CONCURRENCY);
  private readonly modulesById: ReadonlyMap<string, BundleDesignIndex["modules"][number]>;
  private readonly modulesByName: ReadonlyMap<string, BundleDesignIndex["modules"][number]>;
  private readonly sourcesById: ReadonlyMap<string, BundleSourceFile>;
  private readonly project: ProjectResponse;
  private readonly tree: TreeResponse;
  private readonly sourceInventory: SourceInventoryEntry[];

  private constructor(
    readonly fileName: string,
    private readonly bundle: NettleBundle,
    private readonly index: BundleDesignIndex,
    sources: BundleSourceFile[],
    project: ProjectResponse,
    cacheLimits: BundleCacheLimits,
  ) {
    this.modules = new ByteLru<ApiGraphSlice>(cacheLimits.modulesBytes);
    this.sourceContents = new ByteLru<string>(cacheLimits.sourcesBytes);
    this.modulesById = new Map(index.modules.map((module) => [module.id, module]));
    this.modulesByName = new Map(
      index.modules.flatMap((module) => [
        [module.name, module] as const,
        [module.definitionName, module] as const,
      ]),
    );
    this.sourcesById = new Map(sources.map((source) => [source.id, source]));
    this.project = project;
    this.tree = makeTree(sources);
    this.sourceInventory = sources.map(({ id, path, sha256, size }) => ({
      id,
      path,
      sha256,
      size,
    }));
  }

  static async open(
    file: File,
    cacheLimits: BundleCacheLimits = DEFAULT_BUNDLE_CACHE_LIMITS,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    if (!file.name.toLowerCase().endsWith(".nettle")) {
      throw new Error("Select a .nettle bundle");
    }
    if (
      !Number.isSafeInteger(cacheLimits.modulesBytes) ||
      cacheLimits.modulesBytes <= 0 ||
      !Number.isSafeInteger(cacheLimits.sourcesBytes) ||
      cacheLimits.sourcesBytes <= 0
    ) {
      throw new Error("Bundle cache limits must be positive safe integers");
    }
    const bundle = await NettleBundle.open(file, signal);
    throwIfAborted(signal);
    const [indexBytes, sourceBytes, diagnosticBytes] = await Promise.all([
      bundle.read(bundle.manifest.designIndex, signal),
      bundle.read(bundle.manifest.sourceIndex, signal),
      bundle.read(bundle.manifest.diagnostics, signal),
    ]);
    throwIfAborted(signal);
    const index = decodeDesignIndex(indexBytes);
    throwIfAborted(signal);
    const sources = decodeSourceIndex(sourceBytes);
    throwIfAborted(signal);
    const diagnostics = decodeDiagnostics(diagnosticBytes);
    throwIfAborted(signal);
    if (
      index.schemaMajor !== bundle.manifest.formatVersion.major ||
      index.snapshotId !== bundle.manifest.snapshotId ||
      index.top !== bundle.manifest.top
    ) {
      throw new Error("Bundle design index does not match its manifest");
    }
    if (!index.modules.some((module) => module.name === index.top)) {
      throw new Error(`Bundle does not contain its top module ${index.top}`);
    }
    if (index.modules.length === 0 || index.modules.length > MAX_MODULES) {
      throw new Error(`Bundle module count ${index.modules.length} is outside the supported range`);
    }
    const moduleIds = new Set<string>();
    const moduleNames = new Set<string>();
    for (const module of index.modules) {
      throwIfAborted(signal);
      if (
        !module.id ||
        !module.name ||
        !module.entry.startsWith("design/modules/") ||
        !module.entry.endsWith(".pb") ||
        moduleIds.has(module.id) ||
        moduleNames.has(module.name) ||
        !bundle.declaration(module.entry)
      ) {
        throw new Error(`Bundle has an invalid or duplicate module index entry ${module.name}`);
      }
      moduleIds.add(module.id);
      moduleNames.add(module.name);
    }
    if (sources.length > MAX_SOURCES) {
      throw new Error(`Bundle source count ${sources.length} exceeds the supported limit`);
    }
    const sourceIds = new Set<string>();
    const sourcePaths = new Set<string>();
    for (const source of sources) {
      throwIfAborted(signal);
      const declaration = bundle.declaration(source.entry);
      if (
        !source.id ||
        !source.path ||
        !source.entry.startsWith("sources/") ||
        sourceIds.has(source.id) ||
        sourcePaths.has(source.path) ||
        !declaration ||
        declaration.size !== source.size ||
        declaration.sha256 !== source.sha256
      ) {
        throw new Error(`Bundle has an invalid or duplicate source index entry ${source.path}`);
      }
      sourceIds.add(source.id);
      sourcePaths.add(source.path);
    }
    const project = projectResponseFromBundle(index, diagnostics);
    throwIfAborted(signal);
    return new LocalBundleProvider(file.name, bundle, index, sources, project, cacheLimits);
  }

  async getProject(signal?: AbortSignal) {
    throwIfAborted(signal);
    return structuredClone(this.project);
  }

  async getTree(signal?: AbortSignal) {
    throwIfAborted(signal);
    return structuredClone(this.tree);
  }

  async getSourceInventory(signal?: AbortSignal) {
    throwIfAborted(signal);
    return structuredClone(this.sourceInventory);
  }

  async getSource(fileId: string, signal?: AbortSignal): Promise<SourceResponse> {
    throwIfAborted(signal);
    const source = this.sourcesById.get(fileId);
    if (!source) throw new Error(`Source ${fileId} is not in this bundle`);
    let content = this.sourceContents.get(source.entry);
    if (content === undefined) {
      content = await this.sharedLoad(
        this.sourceLoads,
        source.entry,
        async (loadSignal) => {
          const bytes = await this.bundle.read(source.entry, loadSignal);
          throwIfAborted(loadSignal);
          if (bytes.length !== source.size) {
            throw new Error(`Source ${source.path} has an invalid size`);
          }
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          throwIfAborted(loadSignal);
          this.sourceContents.set(source.entry, decoded, bytes.length);
          return decoded;
        },
        signal,
      );
      throwIfAborted(signal);
    }
    return {
      fileId: source.id,
      path: source.path,
      version: source.sha256,
      content,
      elaborationRanges: structuredClone(source.elaborationRanges),
    };
  }

  async getGraphSlice(request: GraphSliceRequest, signal?: AbortSignal): Promise<ApiGraphSlice> {
    throwIfAborted(signal);
    if (request.snapshotId && request.snapshotId !== this.index.snapshotId) {
      throw new Error("The requested snapshot is not active");
    }
    const summary = request.moduleId
      ? this.modulesById.get(request.moduleId)
      : request.moduleName
        ? this.modulesByName.get(request.moduleName)
        : request.instancePath
          ? this.index.modules.find((module) => module.instancePath === request.instancePath)
          : this.modulesByName.get(this.index.top);
    if (!summary) throw new Error("The requested module is not in this bundle");
    const base = await this.loadModule(summary.entry, signal);
    const loadDefinition = async (name: string) => {
      const child = this.modulesByName.get(name);
      return child ? this.loadModule(child.entry, signal) : undefined;
    };
    const budget = Math.min(request.budget ?? MAX_GRAPH_OBJECTS, MAX_GRAPH_OBJECTS);
    const projected = request.flattenDepth
      ? await flattenSlice(base, request.flattenDepth, loadDefinition, budget)
      : request.transparentInstanceIds?.length
        ? await flattenSelected(base, request.transparentInstanceIds, loadDefinition, budget)
        : structuredClone(base);
    const objectCount =
      projected.nodes.length + projected.edges.length + (projected.groups?.length ?? 0);
    if (objectCount > budget) {
      throw new Error(`Projected graph has ${objectCount} objects, exceeding budget ${budget}`);
    }
    throwIfAborted(signal);
    return projected;
  }

  private async loadModule(entry: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const cached = this.modules.get(entry);
    if (cached) return structuredClone(cached);
    const slice = await this.sharedLoad(
      this.moduleLoads,
      entry,
      (loadSignal) => this.decodeModule(entry, loadSignal),
      signal,
    );
    throwIfAborted(signal);
    return structuredClone(slice);
  }

  private sharedLoad<T>(
    loads: Map<string, PendingLoad<T>>,
    entry: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    let pending = loads.get(entry);
    if (!pending) {
      const controller = new AbortController();
      const created: PendingLoad<T> = {
        controller,
        promise: this.loadLimiter.run(() => load(controller.signal), controller.signal),
        waiters: 0,
        settled: false,
      };
      created.promise = created.promise.finally(() => {
        created.settled = true;
        if (loads.get(entry) === created) loads.delete(entry);
      });
      loads.set(entry, created);
      pending = created;
    }
    return waitForSharedLoad(pending, signal, () => {
      pending.controller.abort();
      if (loads.get(entry) === pending) loads.delete(entry);
    });
  }

  private async decodeModule(entry: string, signal: AbortSignal) {
    throwIfAborted(signal);
    const summary = this.index.modules.find((module) => module.entry === entry);
    if (!summary) throw new Error(`Module entry ${entry} is not indexed`);
    const bytes = await this.bundle.read(entry, signal);
    throwIfAborted(signal);
    const slice = decodeGraphSlice(bytes);
    for (const node of slice.nodes) {
      if (
        node.kind === "moduleInstance" &&
        (!node.definitionName || !this.modulesByName.has(node.definitionName))
      ) {
        throw new Error(`Module instance ${node.id} references a missing definition`);
      }
    }
    for (const file of slice.files ?? []) {
      const source = this.sourcesById.get(file.id);
      if (!source || source.path !== file.path) {
        throw new Error(`Graph source reference ${file.path} does not match the source index`);
      }
    }
    if (
      slice.snapshotId !== this.index.snapshotId ||
      slice.module.id !== summary.id ||
      slice.module.name !== summary.name ||
      slice.nodes.length !== summary.nodeCount ||
      slice.edges.length !== summary.edgeCount
    ) {
      throw new Error(`Module ${summary.name} does not match the design index`);
    }
    const portCount = slice.nodes.reduce((count, node) => count + node.ports.length, 0);
    const originCount =
      slice.nodes.reduce((count, node) => count + (node.origins?.length ?? 0), 0) +
      slice.edges.reduce((count, edge) => count + (edge.origins?.length ?? 0), 0) +
      (slice.groups ?? []).reduce((count, group) => count + (group.origins?.length ?? 0), 0);
    if (
      slice.nodes.length > MAX_NODES ||
      slice.edges.length > MAX_EDGES ||
      portCount > MAX_PORTS ||
      originCount > MAX_ORIGINS ||
      slice.nodes.length + slice.edges.length + (slice.groups?.length ?? 0) > MAX_GRAPH_OBJECTS
    ) {
      throw new Error(`Module ${summary.name} exceeds browser graph resource limits`);
    }
    throwIfAborted(signal);
    this.modules.set(entry, slice, bytes.length);
    return slice;
  }
}
