// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphPort,
  GraphSlice,
  NodeKind,
} from "../model/graph";
import {
  aggressiveSharedNeighborIndexStats,
  compareGraphSlices,
  confidenceBandForScore,
  MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS,
  MAX_DERIVED_MATCH_EVIDENCE_ITEMS,
  modulePayloadEqual,
  nearestCandidatesByLine,
  selectMutualMaximumPairs,
} from "./matcher";
import type { SourceLineMapping } from "./types";

const port = (id: string, direction: GraphPort["direction"], name = id, width = 1): GraphPort => ({
  id,
  name,
  direction,
  role: "data",
  width,
});

const node = (
  id: string,
  kind: NodeKind,
  label: string,
  options: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  kind,
  label,
  ports: options.ports ?? [port("in", "input"), port("out", "output")],
  ...options,
});

const edge = (
  id: string,
  sourceNode: string,
  targetNode: string,
  options: Partial<GraphEdge> = {},
): GraphEdge => ({
  id,
  sourceNode,
  sourcePort: "out",
  targetNode,
  targetPort: "in",
  width: 1,
  role: "data",
  ...options,
});

const slice = (
  snapshotId: string,
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
  groups: GraphGroup[] = [],
): GraphSlice => ({
  snapshotId,
  module: {
    id: `module-${snapshotId}`,
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: {},
  },
  nodes,
  edges,
  groups,
});

const statusByOriginalId = (result: ReturnType<typeof compareGraphSlices>) =>
  new Map(
    result.nodes.flatMap((entity) => [
      ...(entity.reference ? [[`r:${entity.reference.id}`, entity.status] as const] : []),
      ...(entity.candidate ? [[`c:${entity.candidate.id}`, entity.status] as const] : []),
    ]),
  );

describe("compareGraphSlices", () => {
  it("compares module payloads without snapshot-local identity or hierarchy placement", () => {
    const reference = {
      id: "reference-module-id",
      name: "top",
      instancePath: "reference.top",
      definitionName: "top_impl",
      parameters: { WIDTH: 8, OPTIONS: { signed: true, mode: "fast" } },
      compilerProvenance: { snapshot: "reference", tool: "yosys-a" },
    };
    const candidate = {
      id: "candidate-module-id",
      name: "top",
      instancePath: "candidate.top",
      definitionName: "top_impl",
      parameters: { OPTIONS: { mode: "fast", signed: true }, WIDTH: 8 },
      compilerProvenance: { snapshot: "candidate", tool: "yosys-b" },
    };

    expect(modulePayloadEqual(reference, candidate)).toBe(true);
    expect(
      modulePayloadEqual(reference, {
        ...candidate,
        parameters: { ...candidate.parameters, WIDTH: 16 },
      }),
    ).toBe(false);
    expect(modulePayloadEqual(reference, { ...candidate, definitionName: "replacement" })).toBe(
      false,
    );
    expect(modulePayloadEqual(reference, { ...candidate, name: "renamed_top" })).toBe(false);
  });

  it("classifies heuristic confidence at the documented boundaries", () => {
    expect(confidenceBandForScore(0.65)).toBe("low");
    expect(confidenceBandForScore(0.749)).toBe("low");
    expect(confidenceBandForScore(0.75)).toBe("medium");
    expect(confidenceBandForScore(0.849)).toBe("medium");
    expect(confidenceBandForScore(0.85)).toBe("high");
    expect(confidenceBandForScore(1)).toBe("high");
  });

  it("builds a collision-safe union and classifies exact changes", () => {
    const reference = slice(
      "r",
      [
        node("input", "input", "a", { ports: [port("out", "output")] }),
        node("logic", "operator", "Add", { glyph: "+" }),
        node("removed", "register", "old"),
      ],
      [edge("wire", "input", "logic")],
    );
    const candidate = slice(
      "c",
      [
        node("input", "input", "a", { ports: [port("out", "output")] }),
        node("logic", "operator", "Add", { glyph: "+", parameters: { OFFSET: 1 } }),
        node("added", "register", "new"),
      ],
      [edge("wire", "input", "logic", { width: 8 })],
    );

    const result = compareGraphSlices(reference, candidate);
    const statuses = statusByOriginalId(result);
    expect(statuses.get("r:input")).toBe("unchanged");
    expect(statuses.get("r:logic")).toBe("modified");
    expect(statuses.get("r:removed")).toBe("removed");
    expect(statuses.get("c:added")).toBe("added");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].status).toBe("modified");
    expect(result.union.nodes.map(({ id }) => new Set([id]).size)).toEqual([1, 1, 1, 1]);
    expect(new Set(result.union.nodes.map(({ id }) => id)).size).toBe(result.union.nodes.length);
    const unionNodeIds = new Set(result.union.nodes.map(({ id }) => id));
    expect(result.union.edges.every((item) => unionNodeIds.has(item.sourceNode))).toBe(true);
    expect(result.union.edges.every((item) => unionNodeIds.has(item.targetNode))).toBe(true);
    expect(reference.nodes[1].label).toBe("Add");
  });

  it("does not let crossed legacy IDs pair operators with conflicting semantics", () => {
    const reference = slice(
      "r",
      [
        node("input", "input", "a", { ports: [port("out", "output")] }),
        node("reference-not", "operator", "Logical not", { glyph: "!" }),
        node("crossed-id", "operator", "Logical and", { glyph: "&&" }),
        node("output", "output", "y", { ports: [port("in", "input")] }),
      ],
      [
        edge("reference-input", "input", "reference-not"),
        edge("reference-middle", "reference-not", "crossed-id"),
        edge("reference-output", "crossed-id", "output"),
      ],
    );
    const candidate = slice(
      "c",
      [
        node("input", "input", "a", { ports: [port("out", "output")] }),
        node("crossed-id", "operator", "Logical not", { glyph: "!" }),
        node("candidate-and", "operator", "Logical and", { glyph: "&&" }),
        node("output", "output", "y", { ports: [port("in", "input")] }),
      ],
      [
        edge("candidate-input", "input", "crossed-id"),
        edge("candidate-middle", "crossed-id", "candidate-and"),
        edge("candidate-output", "candidate-and", "output"),
      ],
    );

    const result = compareGraphSlices(reference, candidate);
    const byReference = new Map(result.nodes.map((entity) => [entity.reference?.id, entity]));

    expect(byReference.get("reference-not")?.candidate?.id).toBe("crossed-id");
    expect(byReference.get("reference-not")?.match?.method).toBe("structural");
    expect(byReference.get("crossed-id")?.candidate?.id).toBe("candidate-and");
    expect(byReference.get("crossed-id")?.match?.method).toBe("structural");
    expect(result.nodes).toHaveLength(4);
    expect(new Set(result.union.nodes.map(({ id }) => id))).toHaveLength(4);
    expect(result.nodes.every(({ status }) => status === "unchanged")).toBe(true);
  });

  it("defers a changed operator with a shared legacy ID to unique source matching", () => {
    const reference = slice("r", [
      node("shared-id", "operator", "Add", {
        glyph: "+",
        origins: [{ file: "old/top.sv", startLine: 5, startColumn: 1 }],
      }),
    ]);
    const candidate = slice("c", [
      node("shared-id", "operator", "Subtract", {
        glyph: "−",
        origins: [{ file: "new/top.sv", startLine: 6, startColumn: 1 }],
      }),
    ]);
    const mapping: SourceLineMapping = {
      referencePath: "old/top.sv",
      candidatePath: "new/top.sv",
      referenceToCandidate: new Map([[5, 6]]),
    };

    const result = compareGraphSlices(reference, candidate, { sourceLineMappings: [mapping] });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].status).toBe("modified");
    expect(result.nodes[0].match?.method).toBe("sourceMapped");
  });

  it("does not conflate delimiter-containing names in conservative tuple keys", () => {
    const referenceNode = node("reference-module", "module", "a:b", {
      definitionName: "c",
      ports: [],
    });
    const candidateNode = node("candidate-module", "module", "a", {
      definitionName: "b:c",
      ports: [],
    });
    const referenceGroup: GraphGroup = {
      id: "reference-group",
      name: "a:b",
      definitionName: "c",
      parameters: {},
      childNodeIds: [referenceNode.id],
    };
    const candidateGroup: GraphGroup = {
      id: "candidate-group",
      name: "a",
      definitionName: "b:c",
      parameters: {},
      childNodeIds: [candidateNode.id],
    };

    const result = compareGraphSlices(
      slice("reference", [referenceNode], [], [referenceGroup]),
      slice("candidate", [candidateNode], [], [candidateGroup]),
    );

    expect(result.nodes.map(({ status }) => status).sort()).toEqual(["added", "removed"]);
    expect(result.groups.map(({ status }) => status).sort()).toEqual(["added", "removed"]);
    expect([...result.nodes, ...result.groups].every(({ match }) => match === undefined)).toBe(
      true,
    );
  });

  it("heuristically pairs an ordered operator changed to a commutative operator", () => {
    const reference = slice("r", [
      node("shared-legacy-id", "operator", "Subtract", {
        glyph: "−",
        ports: [
          { ...port("a", "input", "A", 5), index: 0 },
          { ...port("b", "input", "B", 5), index: 1 },
          port("y", "output", "Y", 5),
        ],
        origins: [{ file: "old/top.sv", startLine: 11, startColumn: 1 }],
      }),
    ]);
    const candidate = slice("c", [
      node("shared-legacy-id", "operator", "Add", {
        glyph: "+",
        ports: [
          port("a", "input", "A", 5),
          port("b", "input", "B", 5),
          port("y", "output", "Y", 5),
        ],
        origins: [{ file: "new/top.sv", startLine: 13, startColumn: 1 }],
      }),
    ]);
    const mapping: SourceLineMapping = {
      referencePath: "old/top.sv",
      candidatePath: "new/top.sv",
      referenceToCandidate: new Map([[10, 12]]),
    };

    const withoutMappedSource = compareGraphSlices(reference, candidate, {
      policy: "aggressive",
    });
    const withMappedSource = compareGraphSlices(reference, candidate, {
      policy: "aggressive",
      sourceLineMappings: [mapping],
    });

    expect(withoutMappedSource.nodes.map(({ status }) => status).sort()).toEqual([
      "added",
      "removed",
    ]);
    expect(withMappedSource.nodes).toHaveLength(1);
    expect(withMappedSource.nodes[0].status).toBe("modified");
    expect(withMappedSource.nodes[0].match?.method).toBe("heuristic");
    expect(withMappedSource.nodes[0].match?.confidence.evidence).toContain("ports 0.80");
  });

  it("applies named, mapped-source, and iterative structural anchors", () => {
    const reference = slice(
      "r",
      [
        node("ref-input", "input", "a", { ports: [port("out", "output")] }),
        node("ref-source", "operator", "Old", {
          origins: [{ file: "rtl/top.sv", startLine: 10, startColumn: 1 }],
        }),
        node("ref-struct", "register", "old-register"),
      ],
      [edge("ref-link", "ref-input", "ref-struct")],
    );
    const candidate = slice(
      "c",
      [
        node("cand-input", "input", "a", { ports: [port("out", "output")] }),
        node("cand-source", "operator", "New", {
          origins: [{ file: "src/top.sv", startLine: 12, startColumn: 1 }],
        }),
        node("cand-struct", "register", "new-register"),
      ],
      [edge("cand-link", "cand-input", "cand-struct")],
    );
    const mapping: SourceLineMapping = {
      referencePath: "rtl/top.sv",
      candidatePath: "src/top.sv",
      referenceToCandidate: new Map([[10, 12]]),
    };

    const result = compareGraphSlices(reference, candidate, { sourceLineMappings: [mapping] });
    const methods = new Map(
      result.nodes.map((entity) => [entity.reference?.id, entity.match?.method] as const),
    );
    expect(methods.get("ref-input")).toBe("named");
    expect(methods.get("ref-source")).toBe("sourceMapped");
    expect(methods.get("ref-struct")).toBe("structural");
  });

  it("propagates a unique structural frontier through a long shifted-ID chain", () => {
    const nodeCount = 2_000;
    const makeChain = (side: "reference" | "candidate", reverse: boolean) => {
      const id = (index: number) =>
        index === 0 ? "shared-anchor" : `${side}-${String(index).padStart(4, "0")}`;
      const nodes = Array.from({ length: nodeCount }, (_, index) =>
        node(id(index), index === 0 ? "input" : "operator", index === 0 ? "data" : side, {
          glyph: index === 0 ? undefined : "+",
          ports:
            index === 0 ? [port("out", "output")] : [port("in", "input"), port("out", "output")],
        }),
      );
      const edges = Array.from({ length: nodeCount - 1 }, (_, index) =>
        edge(`${side}-edge-${index}`, id(index), id(index + 1)),
      );
      return slice(side, reverse ? nodes.reverse() : nodes, reverse ? edges.reverse() : edges);
    };

    const forward = compareGraphSlices(
      makeChain("reference", false),
      makeChain("candidate", false),
    );
    const reordered = compareGraphSlices(
      makeChain("reference", true),
      makeChain("candidate", true),
    );
    const pairings = (comparison: typeof forward) =>
      comparison.nodes.map(({ reference, candidate, match }) => [
        reference?.id,
        candidate?.id,
        match?.method,
      ]);

    expect(forward.nodes).toHaveLength(nodeCount);
    expect(forward.nodes.filter(({ match }) => match?.method === "structural")).toHaveLength(
      nodeCount - 1,
    );
    expect(forward.nodes.every(({ reference, candidate }) => reference && candidate)).toBe(true);
    expect(pairings(reordered)).toEqual(pairings(forward));
  });

  it("does not structurally pair nodes from different glyph classes", () => {
    const reference = slice(
      "r",
      [
        node("anchor", "input", "a", { ports: [port("out", "output")] }),
        node("ref-op", "operator", "add", { glyph: "+" }),
      ],
      [edge("ref-edge", "anchor", "ref-op")],
    );
    const candidate = slice(
      "c",
      [
        node("anchor", "input", "a", { ports: [port("out", "output")] }),
        node("cand-op", "operator", "multiply", { glyph: "×" }),
      ],
      [edge("cand-edge", "anchor", "cand-op")],
    );

    const result = compareGraphSlices(reference, candidate);

    expect(result.nodes.map(({ status }) => status).sort()).toEqual([
      "added",
      "removed",
      "unchanged",
    ]);
    expect(result.nodes.find(({ reference }) => reference?.id === "ref-op")?.match).toBeUndefined();
  });

  it("uses approximate changed-line locations only for aggressive source matching", () => {
    const reference = slice("r", [
      node("reference-op", "operator", "old operation", {
        origins: [{ file: "old/top.sv", startLine: 11, startColumn: 1 }],
      }),
    ]);
    const candidate = slice("c", [
      node("candidate-op", "operator", "new operation", {
        origins: [{ file: "new/top.sv", startLine: 13, startColumn: 1 }],
      }),
    ]);
    const mapping: SourceLineMapping = {
      referencePath: "old/top.sv",
      candidatePath: "new/top.sv",
      referenceToCandidate: new Map([[10, 12]]),
    };

    const conservative = compareGraphSlices(reference, candidate, {
      sourceLineMappings: [mapping],
    });
    const aggressive = compareGraphSlices(reference, candidate, {
      policy: "aggressive",
      sourceLineMappings: [mapping],
    });

    expect(conservative.nodes.map(({ status }) => status).sort()).toEqual(["added", "removed"]);
    expect(aggressive.nodes).toHaveLength(1);
    expect(aggressive.nodes[0].match?.method).toBe("heuristic");
    expect(aggressive.nodes[0].match?.confidence.evidence).toContain("source 1.00");
  });

  it("leaves ambiguity literal in conservative mode and resolves it visibly in aggressive mode", () => {
    const origin = (line: number) => [{ file: "rtl/top.sv", startLine: line, startColumn: 1 }];
    const reference = slice(
      "r",
      [
        node("anchor", "input", "a", { ports: [port("out", "output")] }),
        node("r1", "operator", "old-left", { origins: origin(10) }),
        node("r2", "operator", "old-right", { origins: origin(30) }),
      ],
      [edge("r-e1", "anchor", "r1"), edge("r-e2", "anchor", "r2")],
    );
    const candidate = slice(
      "c",
      [
        node("anchor", "input", "a", { ports: [port("out", "output")] }),
        node("c1", "operator", "new-left", { origins: origin(11) }),
        node("c2", "operator", "new-right", { origins: origin(31) }),
      ],
      [edge("c-e1", "anchor", "c1"), edge("c-e2", "anchor", "c2")],
    );
    const mapping: SourceLineMapping = {
      referencePath: "rtl/top.sv",
      candidatePath: "rtl/top.sv",
      referenceToCandidate: new Map([
        [9, 10],
        [29, 30],
      ]),
    };

    const conservative = compareGraphSlices(reference, candidate, {
      sourceLineMappings: [mapping],
    });
    expect(conservative.nodes.filter(({ status }) => status === "removed")).toHaveLength(2);
    expect(conservative.nodes.filter(({ status }) => status === "added")).toHaveLength(2);
    expect(conservative.heuristicMatchCount).toBe(0);

    const aggressive = compareGraphSlices(reference, candidate, {
      policy: "aggressive",
      sourceLineMappings: [mapping],
    });
    expect(aggressive.heuristicMatchCount).toBe(4);
    expect(
      aggressive.nodes
        .filter(({ match }) => match?.method === "heuristic")
        .map(({ match }) => match?.confidence.score),
    ).toEqual([expect.any(Number), expect.any(Number)]);
    expect(
      aggressive.nodes
        .filter(({ match }) => match?.method === "heuristic")
        .every(({ match }) => (match?.confidence.score ?? 0) >= 0.65),
    ).toBe(true);
    expect(aggressive.edges.every(({ match }) => match?.method === "heuristic")).toBe(true);
    expect(
      aggressive.edges.every(({ match }) =>
        match?.confidence.evidence.includes(
          "edge correspondence depends on heuristic node correspondence",
        ),
      ),
    ).toBe(true);
    expect(
      aggressive.ports
        .filter(({ referenceNodeId }) => referenceNodeId === "r1" || referenceNodeId === "r2")
        .every(({ match }) => match?.method === "heuristic"),
    ).toBe(true);
  });

  it("keeps a clearly better late-ID non-exact-port candidate from an oversized bucket", () => {
    const origins = [{ file: "rtl/top.sv", startLine: 10, startColumn: 1 }];
    const reference = slice("r", [node("reference", "operator", "shared operation", { origins })]);
    const candidates = Array.from({ length: 40 }, (_, index) => {
      const id = `candidate-${String(index).padStart(2, "0")}`;
      return node(id, "operator", "shared operation", {
        origins,
        ports:
          index === 39
            ? [port("in", "input"), port("out", "output"), port("extra", "input")]
            : [{ id: "wrong", name: "wrong", direction: "input", role: "clock" }],
      });
    });

    const result = compareGraphSlices(reference, slice("c", candidates), {
      policy: "aggressive",
      sourceLineMappings: [
        {
          referencePath: "rtl/top.sv",
          candidatePath: "rtl/top.sv",
          referenceToCandidate: new Map([[9, 9]]),
        },
      ],
    });

    const matched = result.nodes.find(({ reference: value }) => value?.id === "reference");
    expect(matched?.candidate?.id).toBe("candidate-39");
    expect(matched?.candidate?.ports).toHaveLength(3);
    expect(matched?.candidate?.ports).not.toEqual(matched?.reference?.ports);
    expect(matched?.match?.method).toBe("heuristic");
    expect(matched?.match?.confidence.score).toBeGreaterThanOrEqual(0.65);
  });

  it("bounds aggressive work for a high-cardinality identical source and semantic bucket", () => {
    const nodeCount = 512;
    const origins = [{ file: "rtl/generated.sv", startLine: 1, startColumn: 1 }];
    const makeNodes = (side: "reference" | "candidate") =>
      Array.from({ length: nodeCount }, (_, index) =>
        node(`${side}-${String(index).padStart(3, "0")}`, "operator", "identical", {
          glyph: "+",
          origins,
        }),
      );

    const options = {
      policy: "aggressive" as const,
      sourceLineMappings: [
        {
          referencePath: "rtl/generated.sv",
          candidatePath: "rtl/generated.sv",
          referenceToCandidate: new Map([[1, 1]]),
        },
      ],
    };
    const result = compareGraphSlices(
      slice("r", makeNodes("reference")),
      slice("c", makeNodes("candidate").reverse()),
      options,
    );
    const reordered = compareGraphSlices(
      slice("r", makeNodes("reference").reverse()),
      slice("c", makeNodes("candidate")),
      options,
    );
    const paired = result.nodes.filter(({ reference, candidate }) => reference && candidate);

    // Rotating bounded pages cover the entire tied bucket without giving any
    // reference an unbounded candidate list.
    expect(paired).toHaveLength(nodeCount);
    expect(paired.every(({ match }) => match?.method === "heuristic")).toBe(true);
    expect(result.nodes.filter(({ status }) => status === "removed")).toHaveLength(0);
    expect(result.nodes.filter(({ status }) => status === "added")).toHaveLength(0);
    expect(new Set(paired.map(({ candidate }) => candidate?.id))).toHaveLength(nodeCount);
    const pairings = (comparison: typeof result) =>
      comparison.nodes
        .filter(({ reference, candidate }) => reference && candidate)
        .map(({ reference, candidate }) => `${reference?.id}:${candidate?.id}`);
    expect(pairings(reordered)).toEqual(pairings(result));
  });

  it("bounds the shared-neighbor index for a high-port star", () => {
    const anchorCount = 96;
    const targetCount = 2;
    const targetPortCount = 512;
    const anchors = Array.from({ length: anchorCount }, (_, index) =>
      node(`anchor-${String(index).padStart(3, "0")}`, "register", `anchor ${index}`),
    );
    const targets = (side: "reference" | "candidate") =>
      Array.from({ length: targetCount }, (_, targetIndex) =>
        node(`${side}-target-${targetIndex}`, "operator", "identical stage", {
          glyph: "+",
          definitionName: "generated_stage",
          ports: Array.from({ length: targetPortCount }, (_, portIndex) => ({
            ...port(`data-${String(portIndex).padStart(3, "0")}`, "input"),
            index: portIndex,
          })),
        }),
      );
    const starEdges = (side: "reference" | "candidate") =>
      Array.from({ length: targetCount }, (_, targetIndex) =>
        anchors.map((anchor, anchorIndex) =>
          edge(
            `${side}-edge-${targetIndex}-${anchorIndex}`,
            anchor.id,
            `${side}-target-${targetIndex}`,
            {
              sourcePort: undefined,
              targetPort: undefined,
            },
          ),
        ),
      ).flat();
    const referenceTargets = targets("reference");
    const candidateTargets = targets("candidate");
    const candidate = slice("candidate", [...anchors, ...candidateTargets], starEdges("candidate"));
    const relationshipCount = anchorCount * targetCount;
    const stats = aggressiveSharedNeighborIndexStats(
      candidate,
      new Set(candidateTargets.map(({ id }) => id)),
      new Set(anchors.map(({ id }) => id)),
    );

    expect(stats).toMatchObject({
      bucketCount: anchorCount,
      relationshipCount,
      entryCount: relationshipCount + anchorCount,
    });
    expect(stats.entryCount).toBeLessThanOrEqual(stats.maximumEntryCount);
    expect(stats.entryCount).toBeLessThan(relationshipCount * targetPortCount);

    const result = compareGraphSlices(
      slice("reference", [...anchors, ...referenceTargets], starEdges("reference")),
      candidate,
      { policy: "aggressive" },
    );
    const matchedTargets = result.nodes.filter(({ reference }) =>
      reference?.id.startsWith("reference-target-"),
    );
    expect(matchedTargets).toHaveLength(targetCount);
    expect(
      matchedTargets.map(({ reference, candidate: matched, match }) => [
        reference?.id,
        matched?.id,
        match?.method,
      ]),
    ).toEqual([
      ["reference-target-0", "candidate-target-0", "heuristic"],
      ["reference-target-1", "candidate-target-1", "heuristic"],
    ]);
  });

  it("propagates heuristic neighbor anchors beyond four scoring waves", () => {
    const nodeCount = 7;
    const makeChain = (side: "reference" | "candidate") => {
      const id = (index: number) => `${side}-${index}`;
      const nodes = Array.from({ length: nodeCount }, (_, index) =>
        node(id(index), "operator", "stage", {
          glyph: "+",
          definitionName: "stage",
          origins:
            index === 0
              ? [
                  {
                    file: side === "reference" ? "old/top.sv" : "new/top.sv",
                    startLine: side === "reference" ? 10 : 11,
                    startColumn: 1,
                  },
                ]
              : [],
        }),
      );
      const edges = Array.from({ length: nodeCount - 1 }, (_, index) =>
        edge(`${side}-edge-${index}`, id(index), id(index + 1)),
      );
      return slice(side, nodes, edges);
    };
    const mapping: SourceLineMapping = {
      referencePath: "old/top.sv",
      candidatePath: "new/top.sv",
      referenceToCandidate: new Map([[9, 10]]),
    };

    const result = compareGraphSlices(makeChain("reference"), makeChain("candidate"), {
      policy: "aggressive",
      sourceLineMappings: [mapping],
    });
    const nodePairs = result.nodes.filter(({ reference, candidate }) => reference && candidate);

    expect(nodePairs).toHaveLength(nodeCount);
    expect(nodePairs.every(({ match }) => match?.method === "heuristic")).toBe(true);
    expect(
      nodePairs.find(({ reference }) => reference?.id === `reference-${nodeCount - 1}`)?.candidate
        ?.id,
    ).toBe(`candidate-${nodeCount - 1}`);
  });

  it("selects the nearest 32 source candidates from a pre-sorted line index", () => {
    const candidates = Array.from({ length: 80 }, (_, index) =>
      node(`candidate-${String(index).padStart(2, "0")}`, "operator", `candidate ${index}`),
    );
    const buckets = [80, 90, 110, 120].map((line, bucketIndex) => ({
      line,
      candidates: candidates.slice(bucketIndex * 20, bucketIndex * 20 + 20),
    }));
    const bruteForce = buckets
      .flatMap((bucket) =>
        bucket.candidates.map((candidate) => ({
          candidate,
          distance: Math.abs(bucket.line - 100),
        })),
      )
      .sort(
        (left, right) =>
          left.distance - right.distance ||
          (left.candidate.id < right.candidate.id
            ? -1
            : left.candidate.id > right.candidate.id
              ? 1
              : 0),
      )
      .slice(0, 32)
      .map(({ candidate }) => candidate.id);

    const selected = nearestCandidatesByLine(buckets, 100).map(({ id }) => id);

    expect(selected).toHaveLength(32);
    expect(selected).toEqual(bruteForce);
  });

  it("batches equal-score mutual maxima deterministically and one-to-one", () => {
    const references = Array.from({ length: 8 }, (_, index) => ({ id: `r${index}` }));
    const candidates = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}` }));
    const pairs = references.flatMap((reference) =>
      candidates.map((candidate) => ({ reference, candidate, score: 0.8 })),
    );

    const forward = selectMutualMaximumPairs(pairs);
    const reversed = selectMutualMaximumPairs([...pairs].reverse());

    expect(forward).toHaveLength(8);
    expect(new Set(forward.map(({ reference }) => reference.id))).toHaveLength(8);
    expect(new Set(forward.map(({ candidate }) => candidate.id))).toHaveLength(8);
    expect(forward.map(({ reference, candidate }) => `${reference.id}:${candidate.id}`)).toEqual([
      "r0:c0",
      "r1:c1",
      "r2:c2",
      "r3:c3",
      "r4:c4",
      "r5:c5",
      "r6:c6",
      "r7:c7",
    ]);
    expect(reversed).toEqual(forward);

    const unicodeReferences = [{ id: "ä" }, { id: "Z" }];
    const unicodeCandidates = [{ id: "ä" }, { id: "Z" }];
    const unicodePairs = unicodeReferences.flatMap((reference) =>
      unicodeCandidates.map((candidate) => ({ reference, candidate, score: 0.8 })),
    );
    expect(
      selectMutualMaximumPairs(unicodePairs).map(
        ({ reference, candidate }) => `${reference.id}:${candidate.id}`,
      ),
    ).toEqual(["Z:Z", "ä:ä"]);
  });

  it("combines matched-neighbor and fan-in/fan-out agreement in the 20% score component", () => {
    const origin = (line: number) => [{ file: "rtl/top.sv", startLine: line, startColumn: 1 }];
    const target = (id: string, line: number) =>
      node(id, "operator", "operation", {
        glyph: "+",
        definitionName: "operation",
        origins: origin(line),
      });
    const reference = slice(
      "r",
      [target("reference-target", 10), node("reference-peer", "register", "peer")],
      [edge("reference-edge", "reference-target", "reference-peer")],
    );
    const matchingFanCandidate = slice(
      "c-good",
      [target("candidate-target", 11), node("candidate-peer", "primitive", "peer")],
      [edge("candidate-edge", "candidate-target", "candidate-peer")],
    );
    const differingFanCandidate = slice(
      "c-bad",
      [target("candidate-target", 11), node("candidate-peer", "primitive", "peer")],
      [edge("candidate-edge", "candidate-peer", "candidate-target")],
    );
    const mapping: SourceLineMapping = {
      referencePath: "rtl/top.sv",
      candidatePath: "rtl/top.sv",
      referenceToCandidate: new Map([[9, 10]]),
    };

    const heuristicTarget = (candidate: GraphSlice) =>
      compareGraphSlices(reference, candidate, {
        policy: "aggressive",
        sourceLineMappings: [mapping],
      }).nodes.find(({ reference: value }) => value?.id === "reference-target");
    const matching = heuristicTarget(matchingFanCandidate);
    const differing = heuristicTarget(differingFanCandidate);

    expect(matching?.match?.method).toBe("heuristic");
    expect(differing?.match?.method).toBe("heuristic");
    expect(matching?.match?.confidence.evidence).toContain(
      "neighbors 0.50 (matched 0.00, fan 1.00)",
    );
    expect(differing?.match?.confidence.evidence).toContain(
      "neighbors 0.00 (matched 0.00, fan 0.00)",
    );
    expect(
      (matching?.match?.confidence.score ?? 0) - (differing?.match?.confidence.score ?? 0),
    ).toBeCloseTo(0.1);
  });

  it("represents rewiring as removed and added edges", () => {
    const shared = [node("a", "register", "a"), node("b", "register", "b")];
    const reference = slice("r", shared, [edge("e", "a", "b")]);
    const candidate = slice("c", shared, [edge("e", "b", "a")]);

    const result = compareGraphSlices(reference, candidate);
    expect(result.edges.map(({ status }) => status).sort()).toEqual(["added", "removed"]);
  });

  it("pairs ports and groups while retaining before/after values", () => {
    const referenceNode = node("n", "module", "u", {
      definitionName: "child",
      ports: [port("p", "input", "data", 1)],
    });
    const candidateNode = node("n", "module", "u", {
      definitionName: "child",
      ports: [port("p", "input", "data", 8), port("new", "output")],
    });
    const referenceGroup: GraphGroup = {
      id: "g",
      name: "u",
      definitionName: "child",
      parameters: {},
      childNodeIds: ["n"],
    };
    const candidateGroup = { ...referenceGroup, parameters: { WIDTH: 8 } };

    const result = compareGraphSlices(
      slice("r", [referenceNode], [], [referenceGroup]),
      slice("c", [candidateNode], [], [candidateGroup]),
    );
    expect(result.ports.map(({ status }) => status).sort()).toEqual(["added", "modified"]);
    expect(result.groups[0]).toMatchObject({ status: "modified" });
    expect(result.union.groups?.[0].childNodeIds).toEqual([result.union.nodes[0].id]);
  });

  it("marks an unchanged group heuristic when its child correspondence is heuristic", () => {
    const referenceNode = node("reference-child", "operator", "stage", {
      glyph: "+",
      definitionName: "stage",
      origins: [{ file: "old/top.sv", startLine: 10, startColumn: 1 }],
    });
    const candidateNode = node("candidate-child", "operator", "stage", {
      glyph: "+",
      definitionName: "stage",
      origins: [{ file: "new/top.sv", startLine: 11, startColumn: 1 }],
    });
    const referenceGroup: GraphGroup = {
      id: "group",
      name: "logic",
      definitionName: "logic",
      parameters: {},
      childNodeIds: [referenceNode.id],
    };
    const candidateGroup: GraphGroup = {
      ...referenceGroup,
      childNodeIds: [candidateNode.id],
    };
    const mapping: SourceLineMapping = {
      referencePath: "old/top.sv",
      candidatePath: "new/top.sv",
      referenceToCandidate: new Map([[9, 10]]),
    };

    const result = compareGraphSlices(
      slice("r", [referenceNode], [], [referenceGroup]),
      slice("c", [candidateNode], [], [candidateGroup]),
      { policy: "aggressive", sourceLineMappings: [mapping] },
    );

    expect(result.nodes[0].match?.method).toBe("heuristic");
    expect(result.groups[0].status).toBe("unchanged");
    expect(result.groups[0].match?.method).toBe("heuristic");
    expect(result.groups[0].match?.confidence.score).toBeLessThanOrEqual(
      result.nodes[0].match?.confidence.score ?? 0,
    );
    expect(result.groups[0].match?.confidence.evidence).toContain(
      "group correspondence depends on heuristic node correspondence",
    );
    expect(result.groups[0].match?.confidence.evidence).toHaveLength(
      MAX_DERIVED_MATCH_EVIDENCE_ITEMS,
    );
    expect(
      result.groups[0].match?.confidence.evidence.every(
        (item) => item.length <= MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS,
      ),
    ).toBe(true);
  });

  it("is deterministic under collection reordering and enforces the union budget", () => {
    const nodes = [node("a", "register", "a"), node("b", "register", "b")];
    const reference = slice("r", nodes, [edge("e", "a", "b")]);
    const candidate = slice("c", nodes, [edge("e", "a", "b")]);
    const forward = compareGraphSlices(reference, candidate);
    const reversed = compareGraphSlices(
      slice("r", [...nodes].reverse(), [edge("e", "a", "b")]),
      slice("c", [...nodes].reverse(), [edge("e", "a", "b")]),
    );
    expect(forward.union.nodes).toEqual(reversed.union.nodes);
    expect(forward.nodes).toEqual(reversed.nodes);
    expect(() => compareGraphSlices(reference, candidate, { maximumObjects: 1 })).toThrow(
      "exceeding budget 1",
    );
  });

  it("enforces port and retained-origin limits on the combined union", () => {
    const origins = (line: number) => [
      { file: "top.sv", startLine: line, startColumn: 1 },
      { file: "top.sv", startLine: line, startColumn: 2 },
    ];
    const reference = slice("r", [
      node("reference-only", "register", "reference", {
        ports: [port("reference-in", "input"), port("reference-out", "output")],
        origins: origins(1),
      }),
    ]);
    const candidate = slice("c", [
      node("candidate-only", "register", "candidate", {
        ports: [port("candidate-in", "input"), port("candidate-out", "output")],
        origins: origins(2),
      }),
    ]);

    expect(reference.nodes[0].ports).toHaveLength(2);
    expect(candidate.nodes[0].ports).toHaveLength(2);
    expect(() =>
      compareGraphSlices(reference, candidate, { maximumPorts: 3, maximumOrigins: 10 }),
    ).toThrow("Comparison union graph has 4 ports, exceeding budget 3");
    expect(() =>
      compareGraphSlices(reference, candidate, { maximumPorts: 10, maximumOrigins: 3 }),
    ).toThrow("Comparison union graph has 4 origins, exceeding budget 3");
  });

  it("does not use unresolved or absent source paths as aggressive evidence", () => {
    const reference = slice("r", [
      node("reference-op", "operator", "Add", {
        glyph: "+",
        origins: [{ file: "top.sv", startLine: 10, startColumn: 1 }],
      }),
    ]);
    const candidate = slice("c", [
      node("candidate-op", "operator", "Add", {
        glyph: "+",
        origins: [{ file: "top.sv", startLine: 10, startColumn: 1 }],
      }),
    ]);
    const ambiguousMappings: SourceLineMapping[] = ["first", "second"].map((directory) => ({
      referencePath: `rtl/${directory}/top.sv`,
      candidatePath: `rtl/${directory}/top.sv`,
      referenceToCandidate: new Map([[10, 10]]),
    }));
    const failedMapping: SourceLineMapping = {
      referencePath: "top.sv",
      candidatePath: "top.sv",
      referenceToCandidate: new Map(),
    };

    for (const sourceLineMappings of [[], ambiguousMappings, [failedMapping]]) {
      const result = compareGraphSlices(reference, candidate, {
        policy: "aggressive",
        sourceLineMappings,
      });

      expect(result.nodes.map(({ status }) => status).sort()).toEqual(["added", "removed"]);
      expect(result.heuristicMatchCount).toBe(0);
    }
  });

  it("never pairs incompatible node kinds even in aggressive mode", () => {
    const reference = slice("r", [
      node("old", "operator", "same", {
        origins: [{ file: "top.sv", startLine: 1, startColumn: 1 }],
      }),
    ]);
    const candidate = slice("c", [
      node("new", "register", "same", {
        origins: [{ file: "top.sv", startLine: 1, startColumn: 1 }],
      }),
    ]);
    const result = compareGraphSlices(reference, candidate, { policy: "aggressive" });
    expect(result.nodes.map(({ status }) => status).sort()).toEqual(["added", "removed"]);
  });
});
