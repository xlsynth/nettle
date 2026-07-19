// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ApiGraphSlice, ProjectResponse } from "../api/contracts";
import type { BundleDesignIndex, BundleSourceFile } from "./protobuf";
import type { NettleBundle } from "./zip";

const protobufMocks = vi.hoisted(() => ({ decodeGraphSlice: vi.fn() }));

vi.mock("./protobuf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./protobuf")>()),
  decodeGraphSlice: protobufMocks.decodeGraphSlice,
}));

import {
  ByteLru,
  COMPARISON_BUNDLE_CACHE_LIMITS,
  DEFAULT_BUNDLE_CACHE_LIMITS,
  LocalBundleProvider,
  MAX_BUNDLE_LOAD_CONCURRENCY,
  MAX_SOURCE_PATH_BYTES,
  MAX_SOURCE_PATH_DEPTH,
  makeTree,
} from "./provider";

const source = (path: string): BundleSourceFile => ({
  id: path,
  path,
  entry: "sources/digest",
  sha256: "digest",
  size: 0,
  elaborationRanges: [],
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const snapshotId = "snapshot";
const moduleSummary: BundleDesignIndex["modules"][number] = {
  id: "module-top",
  name: "top",
  definitionName: "top",
  instancePath: "top",
  nodeCount: 0,
  edgeCount: 0,
  entry: "design/modules/top.pb",
};
const index: BundleDesignIndex = {
  schemaMajor: 1,
  schemaMinor: 0,
  snapshotId,
  top: "top",
  tops: ["top"],
  modules: [moduleSummary],
};
const project: ProjectResponse = {
  schemaVersion: 1,
  status: "ready",
  snapshotId,
  projectRoot: "",
  top: "top",
  tops: ["top"],
  modules: [moduleSummary],
  diagnostics: [],
};
const topSlice: ApiGraphSlice = {
  snapshotId,
  module: {
    id: moduleSummary.id,
    name: moduleSummary.name,
    definitionName: moduleSummary.definitionName,
    instancePath: moduleSummary.instancePath,
  },
  nodes: [],
  edges: [],
};

const makeProvider = (
  read: (entry: string, signal?: AbortSignal) => Promise<Uint8Array>,
  sources: BundleSourceFile[] = [],
) =>
  Reflect.construct(LocalBundleProvider, [
    "fixture.nettle",
    { read } as unknown as NettleBundle,
    index,
    sources,
    project,
    DEFAULT_BUNDLE_CACHE_LIMITS,
  ]) as LocalBundleProvider;

describe("bundle source tree limits", () => {
  it("does not retain a single entry larger than its byte budget", () => {
    const cache = new ByteLru<string>(4);
    cache.set("oversized", "value", 5);
    expect(cache.get("oversized")).toBeUndefined();
    cache.set("fits", "ok", 4);
    expect(cache.get("fits")).toBe("ok");
  });

  it("splits the existing cache budget evenly between compared bundles", () => {
    expect(COMPARISON_BUNDLE_CACHE_LIMITS.modulesBytes * 2).toBe(
      DEFAULT_BUNDLE_CACHE_LIMITS.modulesBytes,
    );
    expect(COMPARISON_BUNDLE_CACHE_LIMITS.sourcesBytes * 2).toBe(
      DEFAULT_BUNDLE_CACHE_LIMITS.sourcesBytes,
    );
  });

  it("rejects paths that would create excessively deep trees", () => {
    const path = `${Array.from({ length: MAX_SOURCE_PATH_DEPTH }, () => "d").join("/")}/file.sv`;
    expect(() => makeTree([source(path)])).toThrow("exceeds the supported depth");
  });

  it("preserves ordinary nested source paths", () => {
    expect(makeTree([source("rtl/blocks/top.sv")])).toEqual({
      root: "",
      entries: [
        {
          name: "rtl",
          path: "rtl",
          kind: "directory",
          children: [
            {
              name: "blocks",
              path: "rtl/blocks",
              kind: "directory",
              children: [
                {
                  name: "top.sv",
                  path: "rtl/blocks/top.sv",
                  kind: "file",
                  fileId: "rtl/blocks/top.sv",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each(["../rtl/top.sv", "rtl//top.sv", "/rtl/top.sv", "rtl\\top.sv", "rtl/./top.sv"])(
    "rejects unsafe source path %s",
    (path) => {
      expect(() => makeTree([source(path)])).toThrow("is unsafe");
    },
  );

  it("rejects source paths over the shared byte limit", () => {
    expect(() => makeTree([source("a".repeat(MAX_SOURCE_PATH_BYTES + 1))])).toThrow("is unsafe");
  });
});

describe("bundle load cancellation", () => {
  it("rejects an already obsolete eager bundle open before ZIP validation starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      LocalBundleProvider.open(
        new File(["not read"], "obsolete.nettle"),
        DEFAULT_BUNDLE_CACHE_LIMITS,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a sole source waiter and does not publish its abandoned result", async () => {
    const bytes = new TextEncoder().encode("module top; endmodule\n");
    const reads: Array<ReturnType<typeof deferred<Uint8Array>>> = [];
    const signals: AbortSignal[] = [];
    const read = vi.fn((_entry: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      const next = deferred<Uint8Array>();
      reads.push(next);
      return next.promise;
    });
    const provider = makeProvider(read, [
      {
        id: "top-source",
        path: "rtl/top.sv",
        entry: "sources/top.sv",
        sha256: "digest",
        size: bytes.length,
        elaborationRanges: [],
      },
    ]);
    const controller = new AbortController();

    const obsolete = provider.getSource("top-source", controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0]?.aborted).toBe(true);
    reads[0].resolve(bytes);

    const retry = provider.getSource("top-source");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    reads[1].resolve(bytes);
    await expect(retry).resolves.toMatchObject({ content: "module top; endmodule\n" });
    await expect(provider.getSource("top-source")).resolves.toMatchObject({
      content: "module top; endmodule\n",
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects an obsolete source caller while a shared read completes and populates the cache", async () => {
    const bytes = new TextEncoder().encode("module top; endmodule\n");
    const sourceRead = deferred<Uint8Array>();
    const read = vi.fn((_entry: string) => sourceRead.promise);
    const provider = makeProvider(read, [
      {
        id: "top-source",
        path: "rtl/top.sv",
        entry: "sources/top.sv",
        sha256: "digest",
        size: bytes.length,
        elaborationRanges: [],
      },
    ]);
    const obsoleteController = new AbortController();

    const obsolete = provider.getSource("top-source", obsoleteController.signal);
    const surviving = provider.getSource("top-source");
    obsoleteController.abort();

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    expect(read).toHaveBeenCalledTimes(1);

    sourceRead.resolve(bytes);
    await expect(surviving).resolves.toMatchObject({ content: "module top; endmodule\n" });
    await expect(provider.getSource("top-source")).resolves.toMatchObject({
      content: "module top; endmodule\n",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects an obsolete module caller while a shared decode completes and populates the cache", async () => {
    const moduleRead = deferred<Uint8Array>();
    const read = vi.fn((_entry: string) => moduleRead.promise);
    const provider = makeProvider(read);
    protobufMocks.decodeGraphSlice.mockReset();
    protobufMocks.decodeGraphSlice.mockReturnValue(topSlice);
    const obsoleteController = new AbortController();

    const obsolete = provider.getGraphSlice({ moduleName: "top" }, obsoleteController.signal);
    const surviving = provider.getGraphSlice({ moduleName: "top" });
    obsoleteController.abort();

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(protobufMocks.decodeGraphSlice).not.toHaveBeenCalled();

    moduleRead.resolve(new Uint8Array([1, 2, 3]));
    await expect(surviving).resolves.toEqual(topSlice);
    await expect(provider.getGraphSlice({ moduleName: "top" })).resolves.toEqual(topSlice);
    expect(read).toHaveBeenCalledTimes(1);
    expect(protobufMocks.decodeGraphSlice).toHaveBeenCalledTimes(1);
  });

  it("does not decode or cache a module after its last waiter aborts", async () => {
    const reads: Array<ReturnType<typeof deferred<Uint8Array>>> = [];
    const read = vi.fn((_entry: string) => {
      const next = deferred<Uint8Array>();
      reads.push(next);
      return next.promise;
    });
    const provider = makeProvider(read);
    protobufMocks.decodeGraphSlice.mockReset();
    protobufMocks.decodeGraphSlice.mockReturnValue(topSlice);
    const controller = new AbortController();

    const obsolete = provider.getGraphSlice({ moduleName: "top" }, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    reads[0].resolve(new Uint8Array([1, 2, 3]));

    const retry = provider.getGraphSlice({ moduleName: "top" });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(protobufMocks.decodeGraphSlice).not.toHaveBeenCalled();
    reads[1].resolve(new Uint8Array([1, 2, 3]));
    await expect(retry).resolves.toEqual(topSlice);
    await expect(provider.getGraphSlice({ moduleName: "top" })).resolves.toEqual(topSlice);
    expect(read).toHaveBeenCalledTimes(2);
    expect(protobufMocks.decodeGraphSlice).toHaveBeenCalledTimes(1);
  });

  it("bounds rapid obsolete module and source loads with one provider-wide limit", async () => {
    const sources = Array.from(
      { length: MAX_BUNDLE_LOAD_CONCURRENCY * 3 },
      (_, index): BundleSourceFile => ({
        id: `source-${index}`,
        path: `rtl/source-${index}.sv`,
        entry: `sources/source-${index}.sv`,
        sha256: `digest-${index}`,
        size: 1,
        elaborationRanges: [],
      }),
    );
    let active = 0;
    let peak = 0;
    const read = vi.fn((_entry: string, signal?: AbortSignal) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<Uint8Array>((_resolve, reject) => {
        const abort = () => {
          active -= 1;
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const provider = makeProvider(read, sources);
    const controllers = Array.from({ length: sources.length + 1 }, () => new AbortController());
    const loads = [
      provider.getGraphSlice({ moduleName: "top" }, controllers[0].signal),
      ...sources.map((entry, index) => provider.getSource(entry.id, controllers[index + 1].signal)),
    ];

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(MAX_BUNDLE_LOAD_CONCURRENCY));
    for (const controller of controllers) controller.abort();
    const results = await Promise.allSettled(loads);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(peak).toBe(MAX_BUNDLE_LOAD_CONCURRENCY);
    expect(read).toHaveBeenCalledTimes(MAX_BUNDLE_LOAD_CONCURRENCY);
    expect(active).toBe(0);
  });
});
