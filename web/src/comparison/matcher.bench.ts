// SPDX-License-Identifier: Apache-2.0

import { bench, describe } from "vitest";
import { makeLayeredBenchmarkSlice } from "../graph/benchmark-fixture";
import type { GraphEdge, GraphNode, GraphSlice } from "../model/graph";
import { compareGraphSlices } from "./matcher";
import type { SourceLineMapping } from "./types";

const graphSlice = (
  snapshotId: string,
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
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
  groups: [],
});

const shiftedChain = (nodeCount: number, side: "reference" | "candidate") => {
  const id = (index: number) =>
    index === 0 ? "shared-anchor" : `${side}-${String(index).padStart(5, "0")}`;
  return graphSlice(
    `chain-${side}`,
    Array.from({ length: nodeCount }, (_, index) => ({
      id: id(index),
      kind: index === 0 ? ("input" as const) : ("operator" as const),
      label: index === 0 ? "data" : side,
      glyph: index === 0 ? undefined : "+",
      ports: [],
    })),
    Array.from({ length: nodeCount - 1 }, (_, index) => ({
      id: `${side}-edge-${index}`,
      sourceNode: id(index),
      targetNode: id(index + 1),
    })),
  );
};

const identicalBucket = (nodeCount: number, side: "reference" | "candidate") =>
  graphSlice(
    `bucket-${side}`,
    Array.from({ length: nodeCount }, (_, index) => ({
      id: `${side}-${String(index).padStart(5, "0")}`,
      kind: "operator" as const,
      label: "identical",
      glyph: "+",
      definitionName: "generated_cell",
      ports: [],
      origins: [{ file: "rtl/generated.sv", startLine: 1, startColumn: 1 }],
    })),
  );

const approximateIdentityMapping = (path: string): SourceLineMapping => ({
  referencePath: path,
  candidatePath: path,
  // No graph entity uses this exact line, so conservative source matching
  // remains inactive while aggressive proximity projects every line equally.
  referenceToCandidate: new Map([[1_000_000, 1_000_000]]),
});

const reference = makeLayeredBenchmarkSlice(49_000);
const HEURISTIC_NODE_COUNT = 512;
reference.nodes.push(
  ...Array.from({ length: HEURISTIC_NODE_COUNT }, (_, index) => ({
    id: `heuristic-reference-${index}`,
    kind: "operator" as const,
    label: `renamed_stage_${index}`,
    glyph: "~",
    definitionName: "renamed_cell",
    ports: [],
    origins: [{ file: "rtl/heuristic.sv", startLine: index + 1, startColumn: 1 }],
  })),
);
const candidate = structuredClone(reference);
candidate.snapshotId = "benchmark-candidate";
candidate.module = {
  ...candidate.module,
  id: "benchmark-candidate",
};
for (const node of candidate.nodes.slice(-HEURISTIC_NODE_COUNT)) {
  node.id = node.id.replace("heuristic-reference-", "heuristic-candidate-");
}

describe("near-limit schematic comparison", () => {
  for (const policy of ["conservative", "aggressive"] as const) {
    bench(
      `${policy}: ${reference.nodes.length.toLocaleString()} nodes / ${reference.edges.length.toLocaleString()} edges`,
      () => {
        const comparison = compareGraphSlices(reference, candidate, {
          policy,
          sourceLineMappings: [approximateIdentityMapping("rtl/heuristic.sv")],
        });
        const expectedHeuristics = policy === "aggressive" ? HEURISTIC_NODE_COUNT : 0;
        if (comparison.heuristicMatchCount !== expectedHeuristics) {
          throw new Error(
            `${policy} matched ${comparison.heuristicMatchCount} heuristic entities; expected ${expectedHeuristics}`,
          );
        }
      },
      {
        iterations: 1,
        warmupIterations: 0,
        time: 0,
        warmupTime: 0,
      },
    );
  }
});

describe("adversarial schematic comparison", () => {
  const chainNodeCount = 10_000;
  const referenceChain = shiftedChain(chainNodeCount, "reference");
  const candidateChain = shiftedChain(chainNodeCount, "candidate");
  bench(
    `conservative shifted-ID chain: ${chainNodeCount.toLocaleString()} nodes`,
    () => {
      const comparison = compareGraphSlices(referenceChain, candidateChain);
      const structuralMatches = comparison.nodes.filter(
        ({ match }) => match?.method === "structural",
      ).length;
      if (comparison.nodes.length !== chainNodeCount || structuralMatches !== chainNodeCount - 1) {
        throw new Error(
          `chain produced ${comparison.nodes.length} nodes and ${structuralMatches} structural matches`,
        );
      }
    },
    { iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 },
  );

  const bucketNodeCount = 4_096;
  const referenceBucket = identicalBucket(bucketNodeCount, "reference");
  const candidateBucket = identicalBucket(bucketNodeCount, "candidate");
  bench(
    `aggressive identical source/semantic bucket: ${bucketNodeCount.toLocaleString()} × 2 nodes`,
    () => {
      const comparison = compareGraphSlices(referenceBucket, candidateBucket, {
        policy: "aggressive",
        sourceLineMappings: [approximateIdentityMapping("rtl/generated.sv")],
      });
      if (comparison.heuristicMatchCount !== bucketNodeCount) {
        throw new Error(
          `bucket produced ${comparison.heuristicMatchCount} heuristic matches; expected ${bucketNodeCount}`,
        );
      }
    },
    { iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 },
  );
});
