// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SourceResponse } from "../api/contracts";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { GraphNode, GraphSlice } from "../model/graph";
import { compareGraphSlices } from "./matcher";
import { SourceLineMappingResolver } from "./source-line-mappings";
import type { SourceInventoryComparison } from "./types";

const node = (id: string, line: number, file = "rtl/child.sv"): GraphNode => ({
  id,
  kind: "operator",
  label: "Add",
  glyph: "+",
  ports: [
    { id: "in", name: "in", direction: "input", role: "data" },
    { id: "out", name: "out", direction: "output", role: "data" },
  ],
  origins: [{ file, startLine: line, startColumn: 1 }],
});

const slice = (snapshotId: string, nodes: GraphNode[]): GraphSlice => ({
  snapshotId,
  module: {
    id: `module-${snapshotId}`,
    name: "u_child",
    instancePath: "top.u_child",
    definitionName: "child",
    parameters: {},
  },
  nodes,
  edges: [],
});

const source = (fileId: string, content: string, path = "rtl/child.sv"): SourceResponse => ({
  fileId,
  path,
  version: fileId,
  content,
  elaborationRanges: [],
});

describe("SourceLineMappingResolver", () => {
  it("lazily reuses child-pair mappings so hierarchy preview and navigation agree", async () => {
    const sources: SourceInventoryComparison[] = [
      {
        id: "child-source-pair",
        status: "modified",
        reference: {
          id: "reference-child",
          path: "rtl/child.sv",
          sha256: "reference-digest",
          size: 23,
        },
        candidate: {
          id: "candidate-child",
          path: "rtl/child.sv",
          sha256: "candidate-digest",
          size: 32,
        },
      },
    ];
    const referenceGetSource = vi
      .fn()
      .mockResolvedValue(source("reference-child", "alpha\nleft\nright\nomega\n"));
    const candidateGetSource = vi
      .fn()
      .mockResolvedValue(source("candidate-child", "alpha\ninserted\nleft\nright\nomega\n"));
    const resolver = new SourceLineMappingResolver({
      referenceProvider: { getSource: referenceGetSource },
      candidateProvider: { getSource: candidateGetSource },
      sources,
    });

    const unrelatedReference = slice("unrelated-reference", [node("r-other", 1, "top.sv")]);
    const unrelatedCandidate = slice("unrelated-candidate", [node("c-other", 1, "top.sv")]);
    expect(await resolver.resolve(unrelatedReference, unrelatedCandidate)).toEqual([]);
    expect(referenceGetSource).not.toHaveBeenCalled();
    expect(candidateGetSource).not.toHaveBeenCalled();

    const reference = slice("reference", [node("r-left", 2), node("r-right", 3)]);
    const candidate = slice("candidate", [node("c-left", 3), node("c-right", 4)]);
    const withoutMappings = compareGraphSlices(reference, candidate);
    expect(withoutMappings.nodes.filter(({ match }) => match).length).toBe(0);

    const previewMappings = await resolver.resolve(reference, candidate);
    const navigationMappings = await resolver.resolve(reference, candidate);
    expect(navigationMappings).toBe(previewMappings);
    expect(referenceGetSource).toHaveBeenCalledOnce();
    expect(candidateGetSource).toHaveBeenCalledOnce();
    expect([...previewMappings[0].referenceToCandidate]).toEqual([
      [2, 3],
      [3, 4],
    ]);

    const preview = compareGraphSlices(reference, candidate, {
      sourceLineMappings: previewMappings,
    });
    const navigated = compareGraphSlices(reference, candidate, {
      sourceLineMappings: navigationMappings,
    });
    expect(preview.nodes.map(({ match }) => match?.method)).toEqual([
      "sourceMapped",
      "sourceMapped",
    ]);
    expect(navigated.nodes).toEqual(preview.nodes);
  });

  it("retains same-file evidence when every referenced source line changed", async () => {
    const sources: SourceInventoryComparison[] = [
      {
        id: "changed-line-pair",
        status: "modified",
        reference: {
          id: "reference-changed-line",
          path: "rtl/child.sv",
          sha256: "reference-digest",
          size: 4,
        },
        candidate: {
          id: "candidate-changed-line",
          path: "rtl/child.sv",
          sha256: "candidate-digest",
          size: 9,
        },
      },
    ];
    const resolver = new SourceLineMappingResolver({
      referenceProvider: {
        getSource: vi.fn().mockResolvedValue(source("reference-changed-line", "add\n")),
      },
      candidateProvider: {
        getSource: vi.fn().mockResolvedValue(source("candidate-changed-line", "subtract\n")),
      },
      sources,
    });
    const referenceNode = { ...node("reference-op", 1), label: "Add", glyph: "+" };
    const candidateNode = { ...node("candidate-op", 1), label: "Subtract", glyph: "−" };
    const reference = slice("reference-changed-line", [referenceNode]);
    const candidate = slice("candidate-changed-line", [candidateNode]);

    const mappings = await resolver.resolve(reference, candidate);
    expect(mappings).toHaveLength(1);
    expect([...mappings[0].referenceToCandidate]).toEqual([]);
    expect(
      compareGraphSlices(reference, candidate, {
        policy: "aggressive",
        sourceLineMappings: mappings,
      }).nodes,
    ).toEqual([
      expect.objectContaining({
        status: "modified",
        match: expect.objectContaining({ method: "heuristic" }),
      }),
    ]);
  });

  it("uses identity mappings for unchanged and exact-renamed sources without loading bodies", async () => {
    const sources: SourceInventoryComparison[] = [
      {
        id: "unchanged-pair",
        status: "unchanged",
        reference: {
          id: "reference-unchanged",
          path: "rtl/common.sv",
          sha256: "common-digest",
          size: 10,
        },
        candidate: {
          id: "candidate-unchanged",
          path: "rtl/common.sv",
          sha256: "common-digest",
          size: 10,
        },
      },
      {
        id: "renamed-pair",
        status: "renamed",
        reference: {
          id: "reference-renamed",
          path: "rtl/old_name.sv",
          sha256: "renamed-digest",
          size: 10,
        },
        candidate: {
          id: "candidate-renamed",
          path: "rtl/new_name.sv",
          sha256: "renamed-digest",
          size: 10,
        },
      },
    ];
    const referenceGetSource = vi.fn();
    const candidateGetSource = vi.fn();
    const resolver = new SourceLineMappingResolver({
      referenceProvider: { getSource: referenceGetSource },
      candidateProvider: { getSource: candidateGetSource },
      sources,
    });
    const reference = slice("reference", [
      node("r-common", 7, "rtl/common.sv"),
      node("r-renamed", 11, "rtl/old_name.sv"),
    ]);
    const candidate = slice("candidate", [
      node("c-common", 7, "rtl/common.sv"),
      node("c-renamed", 11, "rtl/new_name.sv"),
    ]);

    const mappings = await resolver.resolve(reference, candidate);
    expect(referenceGetSource).not.toHaveBeenCalled();
    expect(candidateGetSource).not.toHaveBeenCalled();
    expect(mappings).toHaveLength(2);
    expect(mappings.map((mapping) => [...mapping.referenceToCandidate])).toEqual([
      [[11, 11]],
      [[7, 7]],
    ]);
    expect(
      compareGraphSlices(reference, candidate, { sourceLineMappings: mappings }).nodes.map(
        ({ match }) => match?.method,
      ),
    ).toEqual(["sourceMapped", "sourceMapped"]);
  });

  it("preserves path-only evidence for oversized modified sources without loading bodies", async () => {
    const oversized = RESOURCE_LIMITS.native.builder.sourceBytes + 1;
    const sources: SourceInventoryComparison[] = [
      {
        id: "oversized-pair",
        status: "modified",
        reference: {
          id: "reference-oversized",
          path: "rtl/oversized.sv",
          sha256: "reference-digest",
          size: oversized,
        },
        candidate: {
          id: "candidate-oversized",
          path: "rtl/oversized.sv",
          sha256: "candidate-digest",
          size: oversized,
        },
      },
    ];
    const referenceGetSource = vi.fn();
    const candidateGetSource = vi.fn();
    const resolver = new SourceLineMappingResolver({
      referenceProvider: { getSource: referenceGetSource },
      candidateProvider: { getSource: candidateGetSource },
      sources,
    });

    const mappings = await resolver.resolve(
      slice("reference-oversized", [node("r", 1, "rtl/oversized.sv")]),
      slice("candidate-oversized", [node("c", 1, "rtl/oversized.sv")]),
    );
    expect(mappings).toEqual([
      expect.objectContaining({
        referencePath: "rtl/oversized.sv",
        candidatePath: "rtl/oversized.sv",
      }),
    ]);
    expect([...mappings[0].referenceToCandidate]).toEqual([]);
    expect(referenceGetSource).not.toHaveBeenCalled();
    expect(candidateGetSource).not.toHaveBeenCalled();
  });

  it("omits ambiguous suffix origins but resolves an exact project-relative path", async () => {
    const sources: SourceInventoryComparison[] = ["a", "b"].map((directory) => ({
      id: `${directory}-pair`,
      status: "modified" as const,
      reference: {
        id: `reference-${directory}`,
        path: `rtl/${directory}/foo.sv`,
        sha256: `reference-${directory}-digest`,
        size: 5,
      },
      candidate: {
        id: `candidate-${directory}`,
        path: `rtl/${directory}/foo.sv`,
        sha256: `candidate-${directory}-digest`,
        size: 5,
      },
    }));
    const response = (fileId: string) => {
      const directory = fileId.endsWith("-a") ? "a" : "b";
      return source(fileId, "same\n", `rtl/${directory}/foo.sv`);
    };
    const referenceGetSource = vi.fn(async (fileId: string) => response(fileId));
    const candidateGetSource = vi.fn(async (fileId: string) => response(fileId));
    const resolver = new SourceLineMappingResolver({
      referenceProvider: { getSource: referenceGetSource },
      candidateProvider: { getSource: candidateGetSource },
      sources,
    });

    expect(
      await resolver.resolve(
        slice("ambiguous-reference", [node("r", 1, "foo.sv")]),
        slice("ambiguous-candidate", [node("c", 1, "foo.sv")]),
      ),
    ).toEqual([]);
    expect(referenceGetSource).not.toHaveBeenCalled();
    expect(candidateGetSource).not.toHaveBeenCalled();

    const exact = await resolver.resolve(
      slice("exact-reference", [node("r", 1, "/workspace/project/rtl/a/foo.sv")]),
      slice("exact-candidate", [node("c", 1, "rtl/a/foo.sv")]),
    );
    expect(exact).toHaveLength(1);
    expect(referenceGetSource).toHaveBeenCalledTimes(1);
    expect(referenceGetSource).toHaveBeenCalledWith("reference-a", expect.anything());
    expect(candidateGetSource).toHaveBeenCalledWith("candidate-a", expect.anything());
  });

  it("shares one concurrency limit and preserves shared work when one waiter aborts", async () => {
    const sources: SourceInventoryComparison[] = [1, 2].map((index) => ({
      id: `pair-${index}`,
      status: "modified" as const,
      reference: {
        id: `reference-${index}`,
        path: `rtl/file_${index}.sv`,
        sha256: `reference-${index}-digest`,
        size: 2,
      },
      candidate: {
        id: `candidate-${index}`,
        path: `rtl/file_${index}.sv`,
        sha256: `candidate-${index}-digest`,
        size: 11,
      },
    }));
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const load = async (fileId: string) => {
      const index = fileId.endsWith("-1") ? 1 : 2;
      if (index === 1) await firstGate;
      const isCandidate = fileId.startsWith("candidate");
      return source(fileId, isCandidate ? "inserted\nline\n" : "line\n", `rtl/file_${index}.sv`);
    };
    const referenceGetSource = vi.fn(load);
    const candidateGetSource = vi.fn(load);
    const resolver = new SourceLineMappingResolver({
      referenceProvider: { getSource: referenceGetSource },
      candidateProvider: { getSource: candidateGetSource },
      sources,
      concurrency: 1,
    });
    const reference = slice("reference", [
      node("r1", 1, "rtl/file_1.sv"),
      node("r2", 1, "rtl/file_2.sv"),
    ]);
    const candidate = slice("candidate", [
      node("c1", 2, "rtl/file_1.sv"),
      node("c2", 2, "rtl/file_2.sv"),
    ]);
    const cancelled = new AbortController();
    const surviving = new AbortController();
    const first = resolver.resolve(reference, candidate, cancelled.signal);
    const second = resolver.resolve(reference, candidate, surviving.signal);
    await Promise.resolve();
    await Promise.resolve();

    expect(referenceGetSource.mock.calls.map(([id]) => id)).toEqual(["reference-1"]);
    expect(candidateGetSource.mock.calls.map(([id]) => id)).toEqual(["candidate-1"]);
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();

    const mappings = await second;
    expect(mappings).toHaveLength(2);
    expect(referenceGetSource.mock.calls.map(([id]) => id)).toEqual(["reference-1", "reference-2"]);
    expect(candidateGetSource.mock.calls.map(([id]) => id)).toEqual(["candidate-1", "candidate-2"]);
  });

  it("bounds completed source-mapping requests with an LRU", async () => {
    const requestCount = RESOURCE_LIMITS.browser.comparison.sourceDiffConcurrency * 64 + 1;
    const sources: SourceInventoryComparison[] = Array.from(
      { length: requestCount },
      (_, index) => ({
        id: `pair-${index}`,
        status: "modified" as const,
        reference: {
          id: `reference-${index}`,
          path: `rtl/file_${index}.sv`,
          sha256: `reference-${index}-digest`,
          size: 4,
        },
        candidate: {
          id: `candidate-${index}`,
          path: `rtl/file_${index}.sv`,
          sha256: `candidate-${index}-digest`,
          size: 4,
        },
      }),
    );
    const body = (fileId: string) => {
      const index = fileId.split("-").at(-1) as string;
      const side = fileId.startsWith("reference") ? "old" : "new";
      return source(fileId, `${side}\n`, `rtl/file_${index}.sv`);
    };
    const referenceGetSource = vi.fn(async (fileId: string) => body(fileId));
    const candidateGetSource = vi.fn(async (fileId: string) => body(fileId));
    const resolver = new SourceLineMappingResolver({
      referenceProvider: { getSource: referenceGetSource },
      candidateProvider: { getSource: candidateGetSource },
      sources,
    });

    for (let index = 0; index < requestCount; index += 1) {
      const file = `rtl/file_${index}.sv`;
      await resolver.resolve(
        slice(`reference-${index}`, [node(`r-${index}`, 1, file)]),
        slice(`candidate-${index}`, [node(`c-${index}`, 1, file)]),
      );
    }
    await resolver.resolve(
      slice("reference-reloaded", [node("r-reloaded", 1, "rtl/file_0.sv")]),
      slice("candidate-reloaded", [node("c-reloaded", 1, "rtl/file_0.sv")]),
    );

    expect(referenceGetSource.mock.calls.filter(([id]) => id === "reference-0")).toHaveLength(2);
    expect(candidateGetSource.mock.calls.filter(([id]) => id === "candidate-0")).toHaveLength(2);
  });
});
