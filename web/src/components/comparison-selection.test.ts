// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ComparisonSlice } from "../comparison";
import type { GraphEdge, GraphNode, GraphSlice } from "../model/graph";
import {
  lowSchematicOverlapWarning,
  modulesRequireExplicitPair,
  originalSelectionForOverlay,
  overlaySelectionForOriginal,
} from "./comparison-selection";

const emptySlice = (snapshotId: string): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-top`,
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: {},
  },
  nodes: [],
  edges: [],
});

const node = (id: string): GraphNode => ({ id, kind: "operator", label: id, ports: [] });

const comparisonWithNodes = (
  nodes: ComparisonSlice["nodes"],
  policy: ComparisonSlice["policy"],
): ComparisonSlice => {
  const reference = {
    ...emptySlice("reference"),
    nodes: nodes.flatMap((entry) => (entry.reference ? [entry.reference] : [])),
  };
  const candidate = {
    ...emptySlice("candidate"),
    nodes: nodes.flatMap((entry) => (entry.candidate ? [entry.candidate] : [])),
  };
  return {
    reference,
    candidate,
    union: {
      ...candidate,
      nodes: nodes.flatMap((entry) => {
        const value = entry.candidate ?? entry.reference;
        return value ? [value] : [];
      }),
    },
    nodes,
    ports: [],
    edges: [],
    groups: [],
    policy,
    heuristicMatchCount: policy === "aggressive" ? 1 : 0,
  };
};

describe("comparison selection identity", () => {
  it("keeps the candidate original selected when a heuristic overlay splits", () => {
    const referenceNode = node("reference-node");
    const candidateNode = node("candidate-node");
    const aggressive = comparisonWithNodes(
      [
        {
          id: "paired-overlay",
          status: "modified",
          reference: referenceNode,
          candidate: candidateNode,
          match: {
            method: "heuristic",
            confidence: { score: 0.8, band: "medium", evidence: ["matched neighbors"] },
          },
        },
      ],
      "aggressive",
    );
    const conservative = comparisonWithNodes(
      [
        { id: "removed-overlay", status: "removed", reference: referenceNode },
        { id: "added-overlay", status: "added", candidate: candidateNode },
      ],
      "conservative",
    );

    const original = originalSelectionForOverlay(aggressive, "paired-overlay");

    expect(original).toEqual({ side: "candidate", kind: "node", id: "candidate-node" });
    expect(original && overlaySelectionForOriginal(conservative, original)).toBe("added-overlay");
    expect(lowSchematicOverlapWarning(conservative)).toBe(
      "Low schematic overlap (0% of nodes paired)",
    );
  });

  it("does not restore a colliding edge ID as a node selection", () => {
    const collidingNode = node("shared-original-id");
    const collidingEdge: GraphEdge = {
      id: "shared-original-id",
      sourceNode: "source",
      targetNode: "target",
    };
    const comparison = comparisonWithNodes(
      [{ id: "node-overlay", status: "added", candidate: collidingNode }],
      "conservative",
    );
    comparison.edges = [{ id: "edge-overlay", status: "added", candidate: collidingEdge }];
    comparison.candidate.edges = [collidingEdge];
    comparison.union.edges = [{ ...collidingEdge, id: "edge-overlay" }];

    expect(
      overlaySelectionForOriginal(comparison, {
        side: "candidate",
        kind: "edge",
        id: "shared-original-id",
      }),
    ).toBe("edge-overlay");
    expect(
      overlaySelectionForOriginal(comparison, {
        side: "candidate",
        kind: "node",
        id: "shared-original-id",
      }),
    ).toBe("node-overlay");
  });

  it("requires an explicit pair when exact module names differ", () => {
    const reference = emptySlice("reference").module;
    const candidate = { ...emptySlice("candidate").module, name: "renamed_top" };

    expect(modulesRequireExplicitPair(reference, candidate)).toBe(true);
    expect(modulesRequireExplicitPair(reference, { ...candidate, name: "top" })).toBe(false);
  });
});
