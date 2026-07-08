// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { GraphGroup, GraphNode, GraphSlice, ModuleContext } from "../model/graph";
import {
  compareGraphSlices,
  MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS,
  MAX_DERIVED_MATCH_EVIDENCE_ITEMS,
} from "./matcher";
import { expandComparisonInstance, scopeComparisonIdentity } from "./projection";

const moduleContext = (id: string, name: string): ModuleContext => ({
  id,
  name,
  instancePath: name,
  definitionName: name,
  parameters: {},
});

const boundary = (
  id: string,
  label: string,
  kind: "input" | "output",
  portId: string,
  role: "data" | "clock" = "data",
): GraphNode => ({
  id,
  kind,
  label,
  ports: [
    {
      id: portId,
      name: label,
      direction: kind === "input" ? "output" : "input",
      role,
      width: 8,
    },
  ],
});

interface TopIds {
  prefix: string;
  moduleName?: string;
  childName?: string;
}

const topSlice = ({ prefix, moduleName = "top", childName = "child" }: TopIds): GraphSlice => {
  const input = boundary(`${prefix}-top-a`, "a", "input", `${prefix}-top-a-port`);
  const output = boundary(`${prefix}-top-y`, "y", "output", `${prefix}-top-y-port`);
  const instance: GraphNode = {
    id: `${prefix}-instance`,
    kind: "module",
    label: "u_child",
    definitionName: childName,
    parameters: { WIDTH: 8 },
    ports: [
      { id: `${prefix}-instance-a`, name: "a", direction: "input", role: "data", width: 8 },
      { id: `${prefix}-instance-y`, name: "y", direction: "output", role: "data", width: 8 },
    ],
  };
  const enclosing: GraphGroup = {
    id: `${prefix}-enclosing`,
    name: "enclosing",
    definitionName: moduleName,
    parameters: {},
    childNodeIds: [instance.id],
  };
  return {
    snapshotId: `${prefix}-snapshot`,
    module: moduleContext(`${prefix}-${moduleName}`, moduleName),
    nodes: [input, instance, output],
    edges: [
      {
        id: `${prefix}-incoming`,
        sourceNode: input.id,
        sourcePort: input.ports[0].id,
        targetNode: instance.id,
        targetPort: instance.ports[0].id,
        width: 8,
      },
      {
        id: `${prefix}-outgoing`,
        sourceNode: instance.id,
        sourcePort: instance.ports[1].id,
        targetNode: output.id,
        targetPort: output.ports[0].id,
        width: 8,
      },
    ],
    groups: [enclosing],
    files: [{ id: `${prefix}-top-file`, path: `${moduleName}.sv` }],
  };
};

const childSlice = (prefix: string, inputRole: "data" | "clock" = "data"): GraphSlice => {
  const input = boundary(`${prefix}-child-a`, "a", "input", `${prefix}-child-a-port`, inputRole);
  const logic: GraphNode = {
    id: `${prefix}-logic`,
    kind: "operator",
    label: "pass",
    glyph: "BUF",
    ports: [
      { id: `${prefix}-logic-a`, name: "a", direction: "input", role: "data", width: 8 },
      { id: `${prefix}-logic-y`, name: "y", direction: "output", role: "data", width: 8 },
    ],
  };
  const output = boundary(`${prefix}-child-y`, "y", "output", `${prefix}-child-y-port`);
  return {
    snapshotId: `${prefix}-snapshot`,
    module: moduleContext(`${prefix}-child-module`, "child"),
    nodes: [input, logic, output],
    edges: [
      {
        id: `${prefix}-child-internal-in`,
        sourceNode: input.id,
        sourcePort: input.ports[0].id,
        targetNode: logic.id,
        targetPort: logic.ports[0].id,
        width: 8,
      },
      {
        id: `${prefix}-child-internal-out`,
        sourceNode: logic.id,
        sourcePort: logic.ports[1].id,
        targetNode: output.id,
        targetPort: output.ports[0].id,
        width: 8,
      },
    ],
    groups: [
      {
        id: `${prefix}-inner`,
        name: "inner",
        definitionName: "child",
        parameters: {},
        childNodeIds: [logic.id],
      },
    ],
    files: [{ id: `${prefix}-child-file`, path: "child.sv" }],
  };
};

const emptyPeer = (prefix: string, name: string): GraphSlice => ({
  snapshotId: `${prefix}-snapshot`,
  module: moduleContext(`${prefix}-${name}`, name),
  nodes: [],
  edges: [],
  groups: [],
  files: [],
});

const moduleEntity = (slice: ReturnType<typeof compareGraphSlices>) => {
  const entity = slice.nodes.find(
    (candidate) => candidate.reference?.kind === "module" || candidate.candidate?.kind === "module",
  );
  if (!entity) throw new Error("Fixture has no module comparison entity");
  return entity;
};

const assertValidEndpoints = (slice: GraphSlice) => {
  const nodes = new Map(slice.nodes.map((node) => [node.id, node]));
  for (const edge of slice.edges) {
    const source = nodes.get(edge.sourceNode);
    const target = nodes.get(edge.targetNode);
    expect(source, `${edge.id} source node`).toBeDefined();
    expect(target, `${edge.id} target node`).toBeDefined();
    if (edge.sourcePort) {
      expect(
        source?.ports.some((port) => port.id === edge.sourcePort),
        `${edge.id} source port`,
      ).toBe(true);
    }
    if (edge.targetPort) {
      expect(
        target?.ports.some((port) => port.id === edge.targetPort),
        `${edge.id} target port`,
      ).toBe(true);
    }
  }
};

describe("comparison-aware hierarchy projection", () => {
  it("expands a matched instance across union and side identities without mutating inputs", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const child = compareGraphSlices(childSlice("r"), childSlice("c"));
    const instance = moduleEntity(parent);
    const parentBefore = structuredClone(parent);
    const childBefore = structuredClone(child);

    const expanded = expandComparisonInstance(parent, instance, child);
    expect(parent).toEqual(parentBefore);
    expect(child).toEqual(childBefore);
    expect(expanded.union.nodes.some((node) => node.id === instance.id)).toBe(false);
    expect(expanded.reference.nodes.some((node) => node.id === "r-instance")).toBe(false);
    expect(expanded.candidate.nodes.some((node) => node.id === "c-instance")).toBe(false);

    const childInput = child.nodes.find((entity) => entity.reference?.id === "r-child-a");
    const childInputPort = child.ports.find((entity) => entity.reference?.id === "r-child-a-port");
    expect(childInput).toBeDefined();
    expect(childInputPort).toBeDefined();
    const overlayInputId = scopeComparisonIdentity(instance.id, childInput?.id as string);
    const overlayInputPortId = scopeComparisonIdentity(instance.id, childInputPort?.id as string);
    const referenceInputId = scopeComparisonIdentity("r-instance", "r-child-a");
    const candidateInputId = scopeComparisonIdentity("c-instance", "c-child-a");
    expect(expanded.nodes).toContainEqual(
      expect.objectContaining({
        id: overlayInputId,
        reference: expect.objectContaining({ id: referenceInputId }),
        candidate: expect.objectContaining({ id: candidateInputId }),
      }),
    );

    const incoming = parent.edges.find((entity) => entity.reference?.id === "r-incoming");
    const expandedIncoming = expanded.edges.find((entity) => entity.id === incoming?.id);
    const unionIncoming = expanded.union.edges.find((edge) => edge.id === incoming?.id);
    expect(unionIncoming).toEqual(
      expect.objectContaining({ targetNode: overlayInputId, targetPort: overlayInputPortId }),
    );
    expect(expandedIncoming?.reference).toEqual(
      expect.objectContaining({
        targetNode: referenceInputId,
        targetPort: scopeComparisonIdentity("r-instance", "r-child-a-port"),
      }),
    );
    expect(expandedIncoming?.candidate).toEqual(
      expect.objectContaining({
        targetNode: candidateInputId,
        targetPort: scopeComparisonIdentity("c-instance", "c-child-a-port"),
      }),
    );

    const childEdge = child.edges.find((entity) => entity.reference?.id === "r-child-internal-in");
    const expandedChildEdge = expanded.edges.find(
      (entity) => entity.id === scopeComparisonIdentity(instance.id, childEdge?.id as string),
    );
    expect(expandedChildEdge?.reference).toEqual(
      expect.objectContaining({
        id: scopeComparisonIdentity("r-instance", "r-child-internal-in"),
        sourceNode: referenceInputId,
      }),
    );
    expect(expandedChildEdge?.candidate).toEqual(
      expect.objectContaining({
        id: scopeComparisonIdentity("c-instance", "c-child-internal-in"),
        sourceNode: candidateInputId,
      }),
    );

    const innerGroup = child.groups.find((entity) => entity.reference?.id === "r-inner");
    expect(expanded.groups).toContainEqual(
      expect.objectContaining({
        id: scopeComparisonIdentity(instance.id, innerGroup?.id as string),
        reference: expect.objectContaining({
          id: scopeComparisonIdentity("r-instance", "r-inner"),
        }),
        candidate: expect.objectContaining({
          id: scopeComparisonIdentity("c-instance", "c-inner"),
        }),
      }),
    );
    const synthetic = expanded.groups.find((group) => group.id === instance.id);
    expect(synthetic).toEqual(
      expect.objectContaining({
        status: "unchanged",
        reference: expect.objectContaining({ id: "r-instance" }),
        candidate: expect.objectContaining({ id: "c-instance" }),
      }),
    );
    const enclosing = expanded.groups.find((group) => group.reference?.id === "r-enclosing");
    expect(enclosing?.reference?.childNodeIds).toEqual(
      child.reference.nodes.map((node) => scopeComparisonIdentity("r-instance", node.id)),
    );
    expect(enclosing?.candidate?.childNodeIds).toEqual(
      child.candidate.nodes.map((node) => scopeComparisonIdentity("c-instance", node.id)),
    );
    expect(
      expanded.union.groups?.find((group) => group.id === enclosing?.id)?.childNodeIds,
    ).toEqual(child.union.nodes.map((node) => scopeComparisonIdentity(instance.id, node.id)));
    expect(expanded.heuristicMatchCount).toBe(
      [...expanded.nodes, ...expanded.edges, ...expanded.groups].filter(
        (entity) => entity.match?.method === "heuristic",
      ).length,
    );
    assertValidEndpoints(expanded.reference);
    assertValidEndpoints(expanded.candidate);
    assertValidEndpoints(expanded.union);
  });

  it("expands a reference-only instance against an empty peer", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), emptyPeer("c", "top"));
    const child = compareGraphSlices(childSlice("r"), emptyPeer("c", "child"));
    const instance = moduleEntity(parent);
    expect(instance.status).toBe("removed");

    const expanded = expandComparisonInstance(parent, instance, child);
    expect(expanded.candidate).toEqual(parent.candidate);
    const scopedChildNodes = expanded.nodes.filter((entity) =>
      entity.reference?.id.startsWith("cmp:projection:"),
    );
    expect(scopedChildNodes).toHaveLength(child.reference.nodes.length);
    expect(
      scopedChildNodes.every((entity) => entity.status === "removed" && !entity.candidate),
    ).toBe(true);
    expect(expanded.groups.find((group) => group.id === instance.id)).toEqual(
      expect.objectContaining({ status: "removed", candidate: undefined }),
    );
    const incoming = expanded.edges.find((entity) => entity.reference?.id === "r-incoming");
    expect(incoming).toEqual(expect.objectContaining({ status: "removed", candidate: undefined }));
    expect(incoming?.reference?.targetNode).toBe(
      scopeComparisonIdentity("r-instance", "r-child-a"),
    );
    assertValidEndpoints(expanded.reference);
    assertValidEndpoints(expanded.union);
  });

  it("expands a candidate-only instance against an empty peer", () => {
    const parent = compareGraphSlices(emptyPeer("r", "top"), topSlice({ prefix: "c" }));
    const child = compareGraphSlices(emptyPeer("r", "child"), childSlice("c"));
    const instance = moduleEntity(parent);
    expect(instance.status).toBe("added");

    const expanded = expandComparisonInstance(parent, instance, child);
    expect(expanded.reference).toEqual(parent.reference);
    expect(expanded.groups.find((group) => group.id === instance.id)).toEqual(
      expect.objectContaining({ status: "added", reference: undefined }),
    );
    const outgoing = expanded.edges.find((entity) => entity.candidate?.id === "c-outgoing");
    expect(outgoing).toEqual(expect.objectContaining({ status: "added", reference: undefined }));
    expect(outgoing?.candidate?.sourceNode).toBe(
      scopeComparisonIdentity("c-instance", "c-child-y"),
    );
    assertValidEndpoints(expanded.candidate);
    assertValidEndpoints(expanded.union);
  });

  it("splits an external matched edge if child boundary correspondence diverges", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const child = compareGraphSlices(childSlice("r", "data"), childSlice("c", "clock"));
    const instance = moduleEntity(parent);
    const incoming = parent.edges.find((entity) => entity.reference?.id === "r-incoming");
    expect(incoming?.candidate).toBeDefined();

    const expanded = expandComparisonInstance(parent, instance, child);
    const projected = expanded.edges.filter(
      (entity) => entity.reference?.id === "r-incoming" || entity.candidate?.id === "c-incoming",
    );
    expect(projected.map((entity) => entity.status)).toEqual(["removed", "added"]);
    expect(projected[0].candidate).toBeUndefined();
    expect(projected[1].reference).toBeUndefined();
    expect(projected[0].id).not.toBe(projected[1].id);
    expect(expanded.union.edges.find((edge) => edge.id === projected[0].id)?.targetNode).not.toBe(
      expanded.union.edges.find((edge) => edge.id === projected[1].id)?.targetNode,
    );
    assertValidEndpoints(expanded.union);
  });

  it("supports caller-driven recursive projection and scopes every hierarchy level", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const childParent = compareGraphSlices(
      topSlice({ prefix: "rr", moduleName: "child", childName: "leaf" }),
      topSlice({ prefix: "cc", moduleName: "child", childName: "leaf" }),
    );
    const leaf = compareGraphSlices(childSlice("rr"), childSlice("cc"));
    const childInstance = moduleEntity(childParent);
    const projectedChild = expandComparisonInstance(childParent, childInstance, leaf);
    const parentInstance = moduleEntity(parent);

    const projectedParent = expandComparisonInstance(parent, parentInstance, projectedChild);
    const leafInput = leaf.nodes.find((entity) => entity.reference?.id === "rr-child-a");
    const nestedOverlayId = scopeComparisonIdentity(
      parentInstance.id,
      scopeComparisonIdentity(childInstance.id, leafInput?.id as string),
    );
    const nestedReferenceId = scopeComparisonIdentity(
      "r-instance",
      scopeComparisonIdentity("rr-instance", "rr-child-a"),
    );
    expect(projectedParent.nodes).toContainEqual(
      expect.objectContaining({
        id: nestedOverlayId,
        reference: expect.objectContaining({ id: nestedReferenceId }),
      }),
    );
    assertValidEndpoints(projectedParent.reference);
    assertValidEndpoints(projectedParent.candidate);
    assertValidEndpoints(projectedParent.union);
  });

  it("enforces the final union limit and keeps slash-containing tuples distinct", () => {
    expect(scopeComparisonIdentity("a/b", "c")).not.toBe(scopeComparisonIdentity("a", "b/c"));
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const child = compareGraphSlices(childSlice("r"), childSlice("c"));
    const instance = moduleEntity(parent);
    const expanded = expandComparisonInstance(parent, instance, child);
    const count =
      expanded.union.nodes.length +
      expanded.union.edges.length +
      (expanded.union.groups?.length ?? 0);
    const ports = expanded.union.nodes.reduce((total, node) => total + node.ports.length, 0);
    expect(() =>
      expandComparisonInstance(parent, instance, child, { maximumObjects: count - 1 }),
    ).toThrow(`Comparison projection would have ${count} objects, exceeding budget ${count - 1}`);
    expect(expandComparisonInstance(parent, instance, child, { maximumObjects: count })).toEqual(
      expanded,
    );
    expect(() =>
      expandComparisonInstance(parent, instance, child, { maximumPorts: ports - 1 }),
    ).toThrow(`Comparison projection would have ${ports} ports, exceeding budget ${ports - 1}`);
  });

  it("enforces the retained-origin limit after hierarchy projection", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const referenceChild = childSlice("r");
    const candidateChild = childSlice("c");
    candidateChild.nodes[1].origins = [
      { file: "child.sv", startLine: 1, startColumn: 1 },
      { file: "child.sv", startLine: 2, startColumn: 1 },
    ];
    const child = compareGraphSlices(referenceChild, candidateChild);
    const instance = moduleEntity(parent);

    expect(() => expandComparisonInstance(parent, instance, child, { maximumOrigins: 1 })).toThrow(
      "Comparison projection would have 2 origins, exceeding budget 1",
    );
  });

  it("retains a heuristic instance match in the synthesized group count", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const instance = moduleEntity(parent);
    instance.match = {
      method: "heuristic",
      confidence: { score: 0.8, band: "medium", evidence: ["test fixture"] },
    };
    parent.heuristicMatchCount = 1;
    const child = compareGraphSlices(childSlice("r"), childSlice("c"));

    const expanded = expandComparisonInstance(parent, instance, child);
    expect(expanded.nodes.some((entity) => entity.id === instance.id)).toBe(false);
    expect(expanded.groups.find((entity) => entity.id === instance.id)?.match?.method).toBe(
      "heuristic",
    );
    expect(expanded.heuristicMatchCount).toBe(1);
  });

  it("propagates heuristic child correspondence to synthetic and enclosing groups", () => {
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const instance = moduleEntity(parent);
    const child = compareGraphSlices(childSlice("r"), childSlice("c"));
    const childLogic = child.nodes.find((entity) => entity.reference?.id === "r-logic");
    if (!childLogic) throw new Error("Fixture has no child logic comparison");
    childLogic.match = {
      method: "heuristic",
      confidence: { score: 0.72, band: "low", evidence: ["child heuristic fixture"] },
    };
    child.heuristicMatchCount = 1;

    const expanded = expandComparisonInstance(parent, instance, child);
    const synthetic = expanded.groups.find((entity) => entity.id === instance.id);
    const enclosing = expanded.groups.find((entity) => entity.reference?.id === "r-enclosing");

    expect(synthetic?.status).toBe("unchanged");
    expect(synthetic?.match?.method).toBe("heuristic");
    expect(synthetic?.match?.confidence.score).toBe(0.72);
    expect(synthetic?.match?.confidence.evidence).toContain(
      "flattened group correspondence depends on heuristic node correspondence",
    );
    expect(enclosing?.status).toBe("unchanged");
    expect(enclosing?.match?.method).toBe("heuristic");
    expect(enclosing?.match?.confidence.score).toBe(0.72);
    expect(expanded.heuristicMatchCount).toBeGreaterThanOrEqual(3);
  });

  it("keeps derived heuristic evidence bounded through eight projection levels", () => {
    let projected = compareGraphSlices(childSlice("leaf-reference"), childSlice("leaf-candidate"));
    const leafLogic = projected.nodes.find(
      (entity) => entity.reference?.id === "leaf-reference-logic",
    );
    if (!leafLogic) throw new Error("Fixture has no leaf logic comparison");
    leafLogic.match = {
      method: "heuristic",
      confidence: {
        score: 0.72,
        band: "low",
        evidence: ["leaf heuristic evidence".repeat(32)],
      },
    };
    projected.heuristicMatchCount = 1;
    const deepestEvidenceLengths: number[] = [];

    for (let depth = 0; depth < 8; depth += 1) {
      const moduleName = `level-${depth}`;
      const referenceParent = topSlice({
        prefix: `depth-${depth}-reference`,
        moduleName,
        childName: projected.reference.module.definitionName,
      });
      const candidateParent = topSlice({
        prefix: `depth-${depth}-candidate`,
        moduleName,
        childName: projected.candidate.module.definitionName,
      });
      const parent = compareGraphSlices(referenceParent, candidateParent);
      const instance = moduleEntity(parent);
      projected = expandComparisonInstance(parent, instance, projected);
      const synthetic = projected.groups.find((entity) => entity.id === instance.id);
      const evidence = synthetic?.match?.confidence.evidence;
      expect(synthetic?.match?.method).toBe("heuristic");
      expect(evidence).toBeDefined();
      deepestEvidenceLengths.push(evidence?.length ?? 0);
      expect(evidence?.length).toBeLessThanOrEqual(MAX_DERIVED_MATCH_EVIDENCE_ITEMS);
      expect(evidence?.every((item) => item.length <= MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS)).toBe(
        true,
      );
      expect(evidence?.some((item) => item.startsWith("heuristic dependency count "))).toBe(true);
    }

    expect(deepestEvidenceLengths).toEqual(Array(8).fill(MAX_DERIVED_MATCH_EVIDENCE_ITEMS));
  });

  it("accepts port identities reused by different child nodes", () => {
    const repeatedPorts = (prefix: string) => {
      const slice = childSlice(prefix);
      const input = slice.nodes.find((node) => node.kind === "input") as GraphNode;
      const output = slice.nodes.find((node) => node.kind === "output") as GraphNode;
      const oldInputPort = input.ports[0].id;
      const oldOutputPort = output.ports[0].id;
      input.ports[0].id = "shared-boundary-port";
      output.ports[0].id = "shared-boundary-port";
      for (const edge of slice.edges) {
        if (edge.sourcePort === oldInputPort) edge.sourcePort = "shared-boundary-port";
        if (edge.targetPort === oldOutputPort) edge.targetPort = "shared-boundary-port";
      }
      return slice;
    };
    const parent = compareGraphSlices(topSlice({ prefix: "r" }), topSlice({ prefix: "c" }));
    const child = compareGraphSlices(repeatedPorts("r"), repeatedPorts("c"));
    const instance = moduleEntity(parent);

    const expanded = expandComparisonInstance(parent, instance, child);
    const sharedPorts = expanded.ports.filter(
      (port) =>
        port.reference?.id === scopeComparisonIdentity("r-instance", "shared-boundary-port"),
    );
    expect(sharedPorts).toHaveLength(2);
    expect(new Set(sharedPorts.map((port) => port.nodeId)).size).toBe(2);
    assertValidEndpoints(expanded.union);
  });
});
