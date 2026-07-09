// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphSlice } from "../model/graph";
import { reachableHierarchyHasSchematicSourceEvidence } from "./hierarchy-source-evidence";
import type { ComparisonSlice } from "./types";

const moduleNode = (
  id: string,
  definitionName: string,
  parameters: GraphNode["parameters"] = {},
): GraphNode => ({
  id,
  kind: "module",
  label: id,
  definitionName,
  parameters,
  ports: [],
  origins: [{ file: "rtl/top.sv", startLine: 2, startColumn: 1 }],
});

const operator = (id: string, file: string): GraphNode => ({
  id,
  kind: "operator",
  label: "Add",
  glyph: "+",
  ports: [],
  origins: [{ file, startLine: 5, startColumn: 1 }],
});

const slice = (snapshotId: string, name: string, nodes: GraphNode[] = []): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-${name}`,
    name,
    instancePath: name,
    definitionName: name,
    parameters: {},
  },
  nodes,
  edges: [],
});

const comparison = (
  reference: GraphSlice,
  candidate: GraphSlice,
  status: "unchanged" | "modified" = "unchanged",
): ComparisonSlice => ({
  reference,
  candidate,
  union: {
    ...candidate,
    snapshotId: `union-${reference.module.name}`,
    nodes: candidate.nodes.map((node) => ({ ...node, id: `union-${node.id}` })),
  },
  nodes: reference.nodes.map((node, index) => ({
    id: `union-${candidate.nodes[index]?.id ?? node.id}`,
    status,
    reference: node,
    candidate: candidate.nodes[index],
  })),
  ports: [],
  edges: [],
  groups: [],
  policy: "conservative",
  heuristicMatchCount: 0,
});

describe("reachable hierarchy source evidence", () => {
  it("finds a graph-affecting source change in a reachable child", async () => {
    const referenceTop = slice("reference", "top", [moduleNode("u_child", "child")]);
    const candidateTop = slice("candidate", "top", [moduleNode("u_child", "child")]);
    const referenceChild = slice("reference", "child", [operator("logic", "rtl/child.sv")]);
    const candidateChild = slice("candidate", "child", [operator("logic", "rtl/child.sv")]);
    const comparePair = vi.fn(async (pair: { reference: GraphSlice; candidate: GraphSlice }) =>
      pair.reference.module.name === "child"
        ? comparison(pair.reference, pair.candidate, "modified")
        : comparison(pair.reference, pair.candidate),
    );
    const loadChildPair = vi.fn(async () => ({
      reference: referenceChild,
      candidate: candidateChild,
    }));

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/child.sv",
          candidatePath: "rtl/child.sv",
          comparePair,
          loadChildPair,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("found");
    expect(comparePair).toHaveBeenCalledTimes(2);
    expect(loadChildPair).toHaveBeenCalledTimes(1);
  });

  it("visits distinct parameter specializations of one child definition", async () => {
    const referenceTop = slice("reference", "top", [
      moduleNode("u_narrow", "child", { WIDTH: 8 }),
      moduleNode("u_wide", "child", { WIDTH: 16 }),
    ]);
    const candidateTop = slice("candidate", "top", [
      moduleNode("u_narrow", "child", { WIDTH: 8 }),
      moduleNode("u_wide", "child", { WIDTH: 16 }),
    ]);
    const childPair = (width: number) => {
      const reference = slice("reference", "child", [
        operator(`logic-${width}`, width === 16 ? "rtl/child.sv" : "rtl/other.sv"),
      ]);
      const candidate = slice("candidate", "child", [
        operator(`logic-${width}`, width === 16 ? "rtl/child.sv" : "rtl/other.sv"),
      ]);
      reference.module.parameters = { WIDTH: width };
      candidate.module.parameters = { WIDTH: width };
      return { reference, candidate };
    };
    const comparePair = vi.fn(async (pair: { reference: GraphSlice; candidate: GraphSlice }) =>
      comparison(
        pair.reference,
        pair.candidate,
        pair.reference.module.parameters.WIDTH === 16 ? "modified" : "unchanged",
      ),
    );
    const loadChildPair = vi.fn(
      async (
        _pair: { reference: GraphSlice; candidate: GraphSlice },
        instance: ComparisonSlice["nodes"][number],
      ) => childPair(Number(instance.reference?.parameters?.WIDTH)),
    );

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/child.sv",
          candidatePath: "rtl/child.sv",
          comparePair,
          loadChildPair,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("found");
    expect(loadChildPair).toHaveBeenCalledTimes(2);
    expect(comparePair).toHaveBeenCalledTimes(3);
  });

  it("proves an unrelated bundled source has no reachable schematic evidence", async () => {
    const referenceTop = slice("reference", "top", [moduleNode("u_child", "child")]);
    const candidateTop = slice("candidate", "top", [moduleNode("u_child", "child")]);
    const referenceChild = slice("reference", "child", [operator("logic", "rtl/child.sv")]);
    const candidateChild = slice("candidate", "child", [operator("logic", "rtl/child.sv")]);
    const comparePair = vi.fn(async (pair: { reference: GraphSlice; candidate: GraphSlice }) =>
      pair.reference.module.name === "child"
        ? comparison(pair.reference, pair.candidate, "modified")
        : comparison(pair.reference, pair.candidate),
    );

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/notes.sv",
          candidatePath: "rtl/notes.sv",
          referenceInventoryPaths: ["rtl/top.sv", "rtl/child.sv", "rtl/notes.sv"],
          candidateInventoryPaths: ["rtl/top.sv", "rtl/child.sv", "rtl/notes.sv"],
          comparePair,
          loadChildPair: vi.fn(async () => ({
            reference: referenceChild,
            candidate: candidateChild,
          })),
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("absent");
    expect(comparePair).toHaveBeenCalledTimes(2);
  });

  it("returns unknown without loading beyond the module-pair limit", async () => {
    const referenceTop = slice("reference", "top", [moduleNode("u_child", "child")]);
    const candidateTop = slice("candidate", "top", [moduleNode("u_child", "child")]);
    const loadChildPair = vi.fn();

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/notes.sv",
          candidatePath: "rtl/notes.sv",
          maximumModulePairs: 1,
          comparePair: async (pair) => comparison(pair.reference, pair.candidate),
          loadChildPair,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("unknown");
    expect(loadChildPair).not.toHaveBeenCalled();
  });

  it("returns unknown when the wall-time limit expires", async () => {
    const referenceTop = slice("reference", "top");
    const candidateTop = slice("candidate", "top");
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(6);

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/notes.sv",
          candidatePath: "rtl/notes.sv",
          timeoutMs: 5,
          now,
          comparePair: async (pair) => comparison(pair.reference, pair.candidate),
          loadChildPair: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("unknown");
  });

  it("aborts in-flight work when the wall-time limit expires", async () => {
    const referenceTop = slice("reference", "top");
    const candidateTop = slice("candidate", "top");
    let comparisonSignal: AbortSignal | undefined;

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/notes.sv",
          candidatePath: "rtl/notes.sv",
          timeoutMs: 10,
          comparePair: (_pair, signal) => {
            comparisonSignal = signal;
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
          loadChildPair: vi.fn(),
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("unknown");
    expect(comparisonSignal?.aborted).toBe(true);
  });

  it("preserves cancellation", async () => {
    const referenceTop = slice("reference", "top");
    const candidateTop = slice("candidate", "top");
    const controller = new AbortController();
    controller.abort();

    await expect(
      reachableHierarchyHasSchematicSourceEvidence(
        {
          root: { reference: referenceTop, candidate: candidateTop },
          referencePath: "rtl/notes.sv",
          candidatePath: "rtl/notes.sv",
          comparePair: async (pair) => comparison(pair.reference, pair.candidate),
          loadChildPair: vi.fn(),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
