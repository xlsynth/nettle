// SPDX-License-Identifier: Apache-2.0

import type { GraphSlice } from "../model/graph";

export function makeLayeredBenchmarkSlice(nodeCount: number): GraphSlice {
  if (!Number.isInteger(nodeCount) || nodeCount < 2) {
    throw new Error("nodeCount must be an integer of at least two");
  }

  const laneCount = Math.max(2, Math.min(100, Math.round(Math.sqrt(nodeCount * 2))));
  const layerCount = Math.ceil(nodeCount / laneCount);
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const layer = Math.floor(index / laneCount);
    const lane = index % laneCount;
    return {
      id: `n-${layer}-${lane}`,
      kind: "operator" as const,
      label: `op_${layer}_${lane}`,
      glyph: layer % 3 === 0 ? "+" : layer % 3 === 1 ? "^" : ">>",
      ports: [
        { id: "a", name: "A", direction: "input" as const, width: 32 },
        { id: "y", name: "Y", direction: "output" as const, width: 32 },
      ],
    };
  });
  const present = new Set(nodes.map((node) => node.id));
  const edges = [];

  for (let layer = 0; layer < layerCount - 1; layer += 1) {
    for (let lane = 0; lane < laneCount; lane += 1) {
      const sourceNode = `n-${layer}-${lane}`;
      const targetNode = `n-${layer + 1}-${lane}`;
      if (!present.has(sourceNode) || !present.has(targetNode)) continue;
      edges.push({
        id: `e-${layer}-${lane}-straight`,
        sourceNode,
        sourcePort: "y",
        targetNode,
        targetPort: "a",
        label: `data_${layer}_${lane}`,
        width: 32,
      });

      const diagonalTarget = `n-${layer + 1}-${(lane + 1) % laneCount}`;
      if (lane % 2 === 0 && present.has(diagonalTarget)) {
        edges.push({
          id: `e-${layer}-${lane}-diagonal`,
          sourceNode,
          sourcePort: "y",
          targetNode: diagonalTarget,
          targetPort: "a",
          width: 1,
        });
      }
    }
  }

  return {
    snapshotId: `benchmark-${nodeCount}`,
    module: {
      id: `benchmark-${nodeCount}`,
      name: `layered_${nodeCount}`,
      instancePath: `layered_${nodeCount}`,
      definitionName: `layered_${nodeCount}`,
      parameters: { NODES: nodeCount },
    },
    nodes,
    edges,
  };
}
