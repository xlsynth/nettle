// SPDX-License-Identifier: Apache-2.0

import type {
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphPort,
  GraphSlice,
  SourceFileRef,
} from "../model/graph";
import {
  countHeuristicMatches,
  MAX_COMPARISON_OBJECTS,
  MAX_COMPARISON_ORIGINS,
  MAX_COMPARISON_PORTS,
  withHeuristicDependencies,
} from "./matcher";
import type {
  ComparisonEntity,
  ComparisonPort,
  ComparisonSlice,
  DiffStatus,
  MatchMetadata,
} from "./types";

export interface ExpandComparisonInstanceOptions {
  maximumObjects?: number;
  maximumPorts?: number;
  maximumOrigins?: number;
}

type ComparisonSide = "reference" | "candidate";

const endpointKey = (edge: GraphEdge) =>
  JSON.stringify([
    edge.sourceNode,
    edge.sourcePort ?? null,
    edge.targetNode,
    edge.targetPort ?? null,
  ]);

const nodePortKey = (nodeId: string, portId: string) => JSON.stringify([nodeId, portId]);

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Injectively scopes an opaque graph identity beneath an expanded instance.
 * Lengths, slashes, and nested projection identities cannot create aliases.
 */
export const scopeComparisonIdentity = (instanceId: string, descendantId: string): string =>
  `cmp:projection:${encodeURIComponent(JSON.stringify([instanceId, descendantId]))}`;

const objectCount = (slice: GraphSlice) =>
  slice.nodes.length + slice.edges.length + (slice.groups?.length ?? 0);

const portCount = (slice: GraphSlice) =>
  slice.nodes.reduce((count, node) => count + node.ports.length, 0);

const originCount = (slice: GraphSlice) =>
  slice.nodes.reduce((count, node) => count + (node.origins?.length ?? 0), 0) +
  slice.edges.reduce((count, edge) => count + (edge.origins?.length ?? 0), 0) +
  (slice.groups ?? []).reduce((count, group) => count + (group.origins?.length ?? 0), 0);

const mergeFiles = (
  parent: readonly SourceFileRef[] | undefined,
  child: readonly SourceFileRef[] | undefined,
): SourceFileRef[] | undefined => {
  if (!parent && !child) return undefined;
  const result = new Map<string, SourceFileRef>();
  for (const file of [...(parent ?? []), ...(child ?? [])]) {
    result.set(JSON.stringify([file.id, file.path]), file);
  }
  return [...result.values()].sort(
    (left, right) => compareCodeUnits(left.id, right.id) || compareCodeUnits(left.path, right.path),
  );
};

const scopePort = (scope: string, port: GraphPort): GraphPort => ({
  ...port,
  id: scopeComparisonIdentity(scope, port.id),
});

const scopeNode = (scope: string, node: GraphNode): GraphNode => ({
  ...node,
  id: scopeComparisonIdentity(scope, node.id),
  ports: node.ports.map((port) => scopePort(scope, port)),
});

const scopeEdge = (scope: string, edge: GraphEdge): GraphEdge => ({
  ...edge,
  id: scopeComparisonIdentity(scope, edge.id),
  sourceNode: scopeComparisonIdentity(scope, edge.sourceNode),
  sourcePort: edge.sourcePort ? scopeComparisonIdentity(scope, edge.sourcePort) : undefined,
  targetNode: scopeComparisonIdentity(scope, edge.targetNode),
  targetPort: edge.targetPort ? scopeComparisonIdentity(scope, edge.targetPort) : undefined,
});

const scopeGroup = (scope: string, group: GraphGroup): GraphGroup => ({
  ...group,
  id: scopeComparisonIdentity(scope, group.id),
  childNodeIds: group.childNodeIds.map((id) => scopeComparisonIdentity(scope, id)),
});

interface ScopedSliceContents {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
}

const scopeSliceContents = (slice: GraphSlice, scope: string): ScopedSliceContents => ({
  nodes: slice.nodes.map((node) => scopeNode(scope, node)),
  edges: slice.edges.map((edge) => scopeEdge(scope, edge)),
  groups: (slice.groups ?? []).map((group) => scopeGroup(scope, group)),
});

const instancePort = (
  instance: GraphNode,
  portId: string | undefined,
  edge: GraphEdge,
  side: string,
): GraphPort => {
  const port = instance.ports.find(
    (candidate) => candidate.id === portId || candidate.name === portId,
  );
  if (!port) {
    throw new Error(
      `Cannot expand ${instance.label}: ${side} edge ${edge.id} references missing port ${portId ?? "<missing>"}`,
    );
  }
  return port;
};

const boundaryCandidates = (
  child: GraphSlice,
  portName: string,
  incoming: boolean,
): Array<readonly [GraphNode, GraphPort]> => {
  const candidates: Array<readonly [GraphNode, GraphPort]> = [];
  const groupedNodeIds = new Set((child.groups ?? []).flatMap((group) => group.childNodeIds));
  for (const node of child.nodes) {
    const compatible = incoming
      ? node.kind === "input" || node.kind === "inout"
      : node.kind === "output" || node.kind === "inout";
    if (!compatible) continue;
    const namedPorts = node.ports.filter((port) => port.name === portName);
    for (const port of namedPorts) candidates.push([node, port]);
    if (namedPorts.length === 0 && node.label === portName && node.ports.length === 1) {
      candidates.push([node, node.ports[0]]);
    }
  }
  // Recursively projected descendants retain their own boundary nodes inside
  // synthetic groups. Only the child's ungrouped module boundary connects to
  // the parent. Fall back for unprojected inputs whose producer grouped every
  // top-level node.
  const topLevel = candidates.filter(([node]) => !groupedNodeIds.has(node.id));
  return topLevel.length > 0 ? topLevel : candidates;
};

const childBoundary = (
  instance: GraphNode,
  child: GraphSlice,
  parentPort: GraphPort,
  incoming: boolean,
): readonly [GraphNode, GraphPort] => {
  const candidates = boundaryCandidates(child, parentPort.name, incoming);
  if (candidates.length === 0) {
    throw new Error(
      `Cannot expand ${instance.label}: ${instance.definitionName ?? "module"} has no ${incoming ? "input" : "output"} ${parentPort.name}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Cannot expand ${instance.label}: ${instance.definitionName ?? "module"} has ambiguous ${incoming ? "input" : "output"} ${parentPort.name}`,
    );
  }
  return candidates[0];
};

const replaceInstanceChild = (
  childNodeIds: readonly string[],
  instanceId: string,
  expandedNodeIds: readonly string[],
): string[] => [
  ...new Set(childNodeIds.flatMap((id) => (id === instanceId ? [...expandedNodeIds] : [id]))),
];

interface ExpandedSide {
  slice: GraphSlice;
  scoped: ScopedSliceContents;
}

const expandSideSlice = (
  parent: GraphSlice,
  instance: GraphNode,
  child: GraphSlice,
): ExpandedSide => {
  const parentInstance = parent.nodes.find((node) => node.id === instance.id);
  if (!parentInstance) {
    throw new Error(`Instance ${instance.id} does not exist in ${parent.module.name}`);
  }
  if (parentInstance.kind !== "module" || !parentInstance.definitionName) {
    throw new Error(`${parentInstance.label} is not an expandable module instance`);
  }
  const scoped = scopeSliceContents(child, parentInstance.id);
  const edges = parent.edges.map((edge): GraphEdge => {
    const copy = { ...edge };
    if (copy.targetNode === parentInstance.id) {
      const parentPort = instancePort(parentInstance, copy.targetPort, copy, "incoming");
      const [boundary, port] = childBoundary(parentInstance, child, parentPort, true);
      copy.targetNode = scopeComparisonIdentity(parentInstance.id, boundary.id);
      copy.targetPort = scopeComparisonIdentity(parentInstance.id, port.id);
    }
    if (copy.sourceNode === parentInstance.id) {
      const parentPort = instancePort(parentInstance, copy.sourcePort, copy, "outgoing");
      const [boundary, port] = childBoundary(parentInstance, child, parentPort, false);
      copy.sourceNode = scopeComparisonIdentity(parentInstance.id, boundary.id);
      copy.sourcePort = scopeComparisonIdentity(parentInstance.id, port.id);
    }
    return copy;
  });
  const nodes = parent.nodes.flatMap((node) =>
    node.id === parentInstance.id ? scoped.nodes : [node],
  );
  const groups = (parent.groups ?? []).map((group) => ({
    ...group,
    childNodeIds: replaceInstanceChild(
      group.childNodeIds,
      parentInstance.id,
      scoped.nodes.map((node) => node.id),
    ),
  }));
  groups.push(...scoped.groups, {
    id: parentInstance.id,
    name: parentInstance.label,
    definitionName: parentInstance.definitionName,
    parameters: parentInstance.parameters ?? {},
    origins: parentInstance.origins,
    childNodeIds: scoped.nodes.map((node) => node.id).sort(),
  });
  return {
    scoped,
    slice: {
      ...parent,
      nodes,
      edges: [...edges, ...scoped.edges],
      groups,
      files: mergeFiles(parent.files, child.files),
    },
  };
};

const assertEmptyMissingSide = (side: ComparisonSide, child: GraphSlice) => {
  if (objectCount(child) !== 0) {
    throw new Error(`One-sided ${side} instance cannot expand a non-empty ${side} child`);
  }
};

interface ScopedComparisonContents {
  nodes: ComparisonEntity<GraphNode>[];
  ports: ComparisonPort[];
  edges: ComparisonEntity<GraphEdge>[];
  groups: ComparisonEntity<GraphGroup>[];
}

const scopeComparisonContents = (
  child: ComparisonSlice,
  overlayScope: string,
  referenceScope: string | undefined,
  candidateScope: string | undefined,
): ScopedComparisonContents => {
  const nodes = child.nodes.map(
    (entity): ComparisonEntity<GraphNode> => ({
      ...entity,
      id: scopeComparisonIdentity(overlayScope, entity.id),
      reference:
        entity.reference && referenceScope
          ? scopeNode(referenceScope, entity.reference)
          : undefined,
      candidate:
        entity.candidate && candidateScope
          ? scopeNode(candidateScope, entity.candidate)
          : undefined,
    }),
  );
  const ports = child.ports.map(
    (entity): ComparisonPort => ({
      ...entity,
      id: scopeComparisonIdentity(overlayScope, entity.id),
      nodeId: scopeComparisonIdentity(overlayScope, entity.nodeId),
      referenceNodeId:
        entity.referenceNodeId && referenceScope
          ? scopeComparisonIdentity(referenceScope, entity.referenceNodeId)
          : undefined,
      candidateNodeId:
        entity.candidateNodeId && candidateScope
          ? scopeComparisonIdentity(candidateScope, entity.candidateNodeId)
          : undefined,
      reference:
        entity.reference && referenceScope
          ? scopePort(referenceScope, entity.reference)
          : undefined,
      candidate:
        entity.candidate && candidateScope
          ? scopePort(candidateScope, entity.candidate)
          : undefined,
    }),
  );
  const edges = child.edges.map(
    (entity): ComparisonEntity<GraphEdge> => ({
      ...entity,
      id: scopeComparisonIdentity(overlayScope, entity.id),
      reference:
        entity.reference && referenceScope
          ? scopeEdge(referenceScope, entity.reference)
          : undefined,
      candidate:
        entity.candidate && candidateScope
          ? scopeEdge(candidateScope, entity.candidate)
          : undefined,
    }),
  );
  const groups = child.groups.map(
    (entity): ComparisonEntity<GraphGroup> => ({
      ...entity,
      id: scopeComparisonIdentity(overlayScope, entity.id),
      reference:
        entity.reference && referenceScope
          ? scopeGroup(referenceScope, entity.reference)
          : undefined,
      candidate:
        entity.candidate && candidateScope
          ? scopeGroup(candidateScope, entity.candidate)
          : undefined,
    }),
  );
  return { nodes, ports, edges, groups };
};

interface SideOverlayIndex {
  nodeIds: Map<string, string>;
  portIds: Map<string, string>;
  nodeMatches: Map<string, MatchMetadata | undefined>;
  portMatches: Map<string, MatchMetadata | undefined>;
}

const buildSideOverlayIndex = (
  side: ComparisonSide,
  nodes: readonly ComparisonEntity<GraphNode>[],
  ports: readonly ComparisonPort[],
): SideOverlayIndex => {
  const nodeIds = new Map<string, string>();
  const portIds = new Map<string, string>();
  const nodeMatches = new Map<string, MatchMetadata | undefined>();
  const portMatches = new Map<string, MatchMetadata | undefined>();
  for (const entity of nodes) {
    const value = entity[side];
    if (value) {
      nodeIds.set(value.id, entity.id);
      nodeMatches.set(value.id, entity.match);
    }
  }
  for (const entity of ports) {
    const value = entity[side];
    const nodeId = side === "reference" ? entity.referenceNodeId : entity.candidateNodeId;
    if (value && nodeId) {
      const key = nodePortKey(nodeId, value.id);
      portIds.set(key, entity.id);
      portMatches.set(key, entity.match);
    }
  }
  return { nodeIds, portIds, nodeMatches, portMatches };
};

const edgeEndpointMatchDependencies = (edge: GraphEdge, index: SideOverlayIndex) => [
  index.nodeMatches.get(edge.sourceNode),
  edge.sourcePort
    ? index.portMatches.get(nodePortKey(edge.sourceNode, edge.sourcePort))
    : undefined,
  index.nodeMatches.get(edge.targetNode),
  edge.targetPort
    ? index.portMatches.get(nodePortKey(edge.targetNode, edge.targetPort))
    : undefined,
];

const remapSideEdge = (
  edge: GraphEdge,
  index: SideOverlayIndex,
  description: string,
): Pick<GraphEdge, "sourceNode" | "sourcePort" | "targetNode" | "targetPort"> => {
  const sourceNode = index.nodeIds.get(edge.sourceNode);
  const targetNode = index.nodeIds.get(edge.targetNode);
  if (!sourceNode || !targetNode) {
    throw new Error(`${description} references an unknown projected node`);
  }
  const sourcePort = edge.sourcePort
    ? index.portIds.get(nodePortKey(edge.sourceNode, edge.sourcePort))
    : undefined;
  const targetPort = edge.targetPort
    ? index.portIds.get(nodePortKey(edge.targetNode, edge.targetPort))
    : undefined;
  if (edge.sourcePort && !sourcePort) {
    throw new Error(`${description} references an unknown projected source port`);
  }
  if (edge.targetPort && !targetPort) {
    throw new Error(`${description} references an unknown projected target port`);
  }
  return { sourceNode, sourcePort, targetNode, targetPort };
};

interface RebuiltParentEdges {
  union: GraphEdge[];
  comparisons: ComparisonEntity<GraphEdge>[];
}

const rebuildParentEdges = (
  parent: ComparisonSlice,
  reference: GraphSlice,
  candidate: GraphSlice,
  referenceIndex: SideOverlayIndex,
  candidateIndex: SideOverlayIndex,
): RebuiltParentEdges => {
  const referenceEdges = new Map(reference.edges.map((edge) => [edge.id, edge] as const));
  const candidateEdges = new Map(candidate.edges.map((edge) => [edge.id, edge] as const));
  const union: GraphEdge[] = [];
  const comparisons: ComparisonEntity<GraphEdge>[] = [];
  for (const entity of parent.edges) {
    const referenceEdge = entity.reference ? referenceEdges.get(entity.reference.id) : undefined;
    const candidateEdge = entity.candidate ? candidateEdges.get(entity.candidate.id) : undefined;
    if (entity.reference && !referenceEdge) {
      throw new Error(
        `Reference comparison edge ${entity.reference.id} disappeared during expansion`,
      );
    }
    if (entity.candidate && !candidateEdge) {
      throw new Error(
        `Candidate comparison edge ${entity.candidate.id} disappeared during expansion`,
      );
    }
    const referenceEndpoints = referenceEdge
      ? remapSideEdge(referenceEdge, referenceIndex, `Reference edge ${referenceEdge.id}`)
      : undefined;
    const candidateEndpoints = candidateEdge
      ? remapSideEdge(candidateEdge, candidateIndex, `Candidate edge ${candidateEdge.id}`)
      : undefined;
    if (
      referenceEdge &&
      candidateEdge &&
      endpointKey({ ...referenceEdge, ...referenceEndpoints }) !==
        endpointKey({ ...candidateEdge, ...candidateEndpoints })
    ) {
      const removedId = scopeComparisonIdentity(entity.id, "reference-endpoint");
      const addedId = scopeComparisonIdentity(entity.id, "candidate-endpoint");
      union.push({ ...referenceEdge, id: removedId, ...referenceEndpoints });
      comparisons.push({ id: removedId, status: "removed", reference: referenceEdge });
      union.push({ ...candidateEdge, id: addedId, ...candidateEndpoints });
      comparisons.push({ id: addedId, status: "added", candidate: candidateEdge });
      continue;
    }
    const base = candidateEdge ?? referenceEdge;
    const endpoints = candidateEndpoints ?? referenceEndpoints;
    if (!base || !endpoints) throw new Error(`Comparison edge ${entity.id} has no side payload`);
    union.push({ ...base, id: entity.id, ...endpoints });
    comparisons.push({
      ...entity,
      reference: referenceEdge,
      candidate: candidateEdge,
      match:
        entity.match && referenceEdge && candidateEdge
          ? withHeuristicDependencies(
              entity.match,
              [
                ...edgeEndpointMatchDependencies(referenceEdge, referenceIndex),
                ...edgeEndpointMatchDependencies(candidateEdge, candidateIndex),
              ],
              "flattened edge correspondence",
            )
          : entity.match,
    });
  }
  return { union, comparisons };
};

const mappedGroupChildren = (group: GraphGroup, index: SideOverlayIndex): string[] =>
  group.childNodeIds.map((id) => {
    const mapped = index.nodeIds.get(id);
    if (!mapped) throw new Error(`Group ${group.id} references unknown projected node ${id}`);
    return mapped;
  });

const sameIds = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

const updatedMatchedStatus = (
  status: DiffStatus,
  reference: GraphGroup | undefined,
  candidate: GraphGroup | undefined,
  referenceIndex: SideOverlayIndex,
  candidateIndex: SideOverlayIndex,
): DiffStatus => {
  if (!reference) return "added";
  if (!candidate) return "removed";
  if (status !== "unchanged") return status;
  return sameIds(
    mappedGroupChildren(reference, referenceIndex),
    mappedGroupChildren(candidate, candidateIndex),
  )
    ? "unchanged"
    : "modified";
};

interface RebuiltParentGroups {
  union: GraphGroup[];
  comparisons: ComparisonEntity<GraphGroup>[];
}

const rebuildParentGroups = (
  parent: ComparisonSlice,
  instanceId: string,
  childUnionNodeIds: readonly string[],
  reference: GraphSlice,
  candidate: GraphSlice,
  referenceIndex: SideOverlayIndex,
  candidateIndex: SideOverlayIndex,
  expandedDependencies: readonly (MatchMetadata | undefined)[],
): RebuiltParentGroups => {
  const referenceGroups = new Map((reference.groups ?? []).map((group) => [group.id, group]));
  const candidateGroups = new Map((candidate.groups ?? []).map((group) => [group.id, group]));
  const parentUnionGroups = new Map((parent.union.groups ?? []).map((group) => [group.id, group]));
  const union: GraphGroup[] = [];
  const comparisons: ComparisonEntity<GraphGroup>[] = [];
  for (const entity of parent.groups) {
    const referenceGroup = entity.reference ? referenceGroups.get(entity.reference.id) : undefined;
    const candidateGroup = entity.candidate ? candidateGroups.get(entity.candidate.id) : undefined;
    const unionGroup = parentUnionGroups.get(entity.id);
    if (!unionGroup) throw new Error(`Comparison group ${entity.id} has no union group`);
    union.push({
      ...unionGroup,
      childNodeIds: replaceInstanceChild(unionGroup.childNodeIds, instanceId, childUnionNodeIds),
    });
    comparisons.push({
      ...entity,
      status: updatedMatchedStatus(
        entity.status,
        referenceGroup,
        candidateGroup,
        referenceIndex,
        candidateIndex,
      ),
      reference: referenceGroup,
      candidate: candidateGroup,
      match:
        entity.match && unionGroup.childNodeIds.includes(instanceId)
          ? withHeuristicDependencies(
              entity.match,
              expandedDependencies,
              "flattened parent group correspondence",
            )
          : entity.match,
    });
  }
  return { union, comparisons };
};

const syntheticGroupStatus = (
  instance: ComparisonEntity<GraphNode>,
  child: ComparisonSlice,
): DiffStatus => {
  if (!instance.reference) return "added";
  if (!instance.candidate) return "removed";
  if (instance.status !== "unchanged") return "modified";
  return [...child.nodes, ...child.ports, ...child.edges, ...child.groups].some(
    (entity) => entity.status !== "unchanged",
  )
    ? "modified"
    : "unchanged";
};

const validateSlice = (slice: GraphSlice, description: string) => {
  const nodes = new Map<string, GraphNode>();
  for (const node of slice.nodes) {
    if (nodes.has(node.id)) throw new Error(`${description} contains duplicate node ${node.id}`);
    nodes.set(node.id, node);
    const ports = new Set<string>();
    for (const port of node.ports) {
      if (ports.has(port.id)) {
        throw new Error(`${description} node ${node.id} contains duplicate port ${port.id}`);
      }
      ports.add(port.id);
    }
  }
  const edges = new Set<string>();
  for (const edge of slice.edges) {
    if (edges.has(edge.id)) throw new Error(`${description} contains duplicate edge ${edge.id}`);
    edges.add(edge.id);
    for (const [side, nodeId, portId] of [
      ["source", edge.sourceNode, edge.sourcePort],
      ["target", edge.targetNode, edge.targetPort],
    ] as const) {
      const node = nodes.get(nodeId);
      if (!node)
        throw new Error(`${description} edge ${edge.id} has unknown ${side} node ${nodeId}`);
      if (portId && !node.ports.some((port) => port.id === portId)) {
        throw new Error(`${description} edge ${edge.id} has unknown ${side} port ${portId}`);
      }
    }
  }
  const groups = new Set<string>();
  for (const group of slice.groups ?? []) {
    if (groups.has(group.id))
      throw new Error(`${description} contains duplicate group ${group.id}`);
    groups.add(group.id);
    for (const id of group.childNodeIds) {
      if (!nodes.has(id))
        throw new Error(`${description} group ${group.id} has unknown child ${id}`);
    }
  }
};

const validateComparisonRecords = (comparison: ComparisonSlice) => {
  const assertRecordIds = <T extends { id: string }>(
    values: readonly T[],
    records: readonly ComparisonEntity<unknown>[],
    description: string,
  ) => {
    const valueIds = new Set(values.map((value) => value.id));
    const recordIds = new Set(records.map((record) => record.id));
    if (valueIds.size !== values.length || recordIds.size !== records.length) {
      throw new Error(`Projected comparison contains duplicate ${description} identities`);
    }
    if (valueIds.size !== recordIds.size || [...valueIds].some((id) => !recordIds.has(id))) {
      throw new Error(`Projected comparison ${description} records do not match its union graph`);
    }
  };
  assertRecordIds(comparison.union.nodes, comparison.nodes, "node");
  assertRecordIds(comparison.union.edges, comparison.edges, "edge");
  assertRecordIds(comparison.union.groups ?? [], comparison.groups, "group");
  // Port identities are scoped to their node by the bundle contract, so the
  // same opaque port ID may legally appear on different nodes.
  const unionPortKeys = comparison.union.nodes.flatMap((node) =>
    node.ports.map((port) => nodePortKey(node.id, port.id)),
  );
  const recordPortKeys = comparison.ports.map((port) => nodePortKey(port.nodeId, port.id));
  const unionPorts = new Set(unionPortKeys);
  const recordPorts = new Set(recordPortKeys);
  if (
    unionPorts.size !== unionPortKeys.length ||
    recordPorts.size !== recordPortKeys.length ||
    unionPorts.size !== recordPorts.size ||
    [...unionPorts].some((id) => !recordPorts.has(id))
  ) {
    throw new Error("Projected comparison port records do not match its union graph");
  }
};

/**
 * Expands one matched or one-sided module correspondence using an already
 * compared child slice. The child may itself have been recursively projected.
 * No input object is mutated.
 */
export const expandComparisonInstance = (
  parent: ComparisonSlice,
  instanceInput: ComparisonEntity<GraphNode>,
  child: ComparisonSlice,
  options: ExpandComparisonInstanceOptions = {},
): ComparisonSlice => {
  if (parent.policy !== child.policy) {
    throw new Error(
      `Cannot combine ${parent.policy} parent comparison with ${child.policy} child comparison`,
    );
  }
  const instance = parent.nodes.find((entity) => entity.id === instanceInput.id);
  if (!instance) throw new Error(`Comparison instance ${instanceInput.id} is not in the parent`);
  if (!instance.reference && !instance.candidate) {
    throw new Error(`Comparison instance ${instance.id} has no side payload`);
  }
  const unionInstance = parent.union.nodes.find((node) => node.id === instance.id);
  if (!unionInstance) throw new Error(`Comparison instance ${instance.id} has no union node`);
  if (unionInstance.kind !== "module" || !unionInstance.definitionName) {
    throw new Error(`${unionInstance.label} is not an expandable module instance`);
  }
  if (!instance.reference) assertEmptyMissingSide("reference", child.reference);
  if (!instance.candidate) assertEmptyMissingSide("candidate", child.candidate);

  const referenceExpanded = instance.reference
    ? expandSideSlice(parent.reference, instance.reference, child.reference)
    : { slice: parent.reference, scoped: scopeSliceContents(child.reference, "missing-reference") };
  const candidateExpanded = instance.candidate
    ? expandSideSlice(parent.candidate, instance.candidate, child.candidate)
    : { slice: parent.candidate, scoped: scopeSliceContents(child.candidate, "missing-candidate") };
  const scopedUnion = scopeSliceContents(child.union, instance.id);
  const scopedComparison = scopeComparisonContents(
    child,
    instance.id,
    instance.reference?.id,
    instance.candidate?.id,
  );
  const parentNodes = parent.nodes.filter((entity) => entity.id !== instance.id);
  const parentPorts = parent.ports.filter((entity) => entity.nodeId !== instance.id);
  const nodes = [...parentNodes, ...scopedComparison.nodes];
  const ports = [...parentPorts, ...scopedComparison.ports];
  const referenceIndex = buildSideOverlayIndex("reference", nodes, ports);
  const candidateIndex = buildSideOverlayIndex("candidate", nodes, ports);
  const rebuiltEdges = rebuildParentEdges(
    parent,
    referenceExpanded.slice,
    candidateExpanded.slice,
    referenceIndex,
    candidateIndex,
  );
  const expandedDependencies = [
    ...child.nodes,
    ...child.ports,
    ...child.edges,
    ...child.groups,
  ].map((entity) => entity.match);
  const rebuiltGroups = rebuildParentGroups(
    parent,
    instance.id,
    scopedUnion.nodes.map((node) => node.id),
    referenceExpanded.slice,
    candidateExpanded.slice,
    referenceIndex,
    candidateIndex,
    expandedDependencies,
  );

  const referenceGroup: GraphGroup | undefined = instance.reference
    ? {
        id: instance.reference.id,
        name: instance.reference.label,
        definitionName: instance.reference.definitionName as string,
        parameters: instance.reference.parameters ?? {},
        origins: instance.reference.origins,
        childNodeIds: referenceExpanded.scoped.nodes.map((node) => node.id).sort(),
      }
    : undefined;
  const candidateGroup: GraphGroup | undefined = instance.candidate
    ? {
        id: instance.candidate.id,
        name: instance.candidate.label,
        definitionName: instance.candidate.definitionName as string,
        parameters: instance.candidate.parameters ?? {},
        origins: instance.candidate.origins,
        childNodeIds: candidateExpanded.scoped.nodes.map((node) => node.id).sort(),
      }
    : undefined;
  const syntheticGroup: ComparisonEntity<GraphGroup> = {
    id: instance.id,
    status: syntheticGroupStatus(instance, child),
    reference: referenceGroup,
    candidate: candidateGroup,
    match:
      instance.match && instance.reference && instance.candidate
        ? withHeuristicDependencies(
            instance.match,
            expandedDependencies,
            "flattened group correspondence",
          )
        : instance.match,
  };
  const unionGroupBase = instance.candidate ?? instance.reference;
  if (!unionGroupBase?.definitionName) {
    throw new Error(`Comparison instance ${instance.id} has no definition`);
  }
  const unionGroup: GraphGroup = {
    id: instance.id,
    name: unionGroupBase.label,
    definitionName: unionGroupBase.definitionName,
    parameters: unionGroupBase.parameters ?? {},
    origins: unionGroupBase.origins,
    childNodeIds: scopedUnion.nodes.map((node) => node.id).sort(),
  };

  const unionNodes = parent.union.nodes.flatMap((node) =>
    node.id === instance.id ? scopedUnion.nodes : [node],
  );
  const edges = [...rebuiltEdges.comparisons, ...scopedComparison.edges];
  const groups = [...rebuiltGroups.comparisons, ...scopedComparison.groups, syntheticGroup];
  const result: ComparisonSlice = {
    reference: referenceExpanded.slice,
    candidate: candidateExpanded.slice,
    union: {
      ...parent.union,
      nodes: unionNodes,
      edges: [...rebuiltEdges.union, ...scopedUnion.edges],
      groups: [...rebuiltGroups.union, ...scopedUnion.groups, unionGroup],
      files: mergeFiles(parent.union.files, child.union.files),
    },
    nodes,
    ports,
    edges,
    groups,
    policy: parent.policy,
    heuristicMatchCount: countHeuristicMatches({ nodes, edges, groups }),
  };
  const maximumObjects = Math.min(
    options.maximumObjects ?? MAX_COMPARISON_OBJECTS,
    MAX_COMPARISON_OBJECTS,
  );
  const maximumPorts = Math.min(options.maximumPorts ?? MAX_COMPARISON_PORTS, MAX_COMPARISON_PORTS);
  const maximumOrigins = Math.min(
    options.maximumOrigins ?? MAX_COMPARISON_ORIGINS,
    MAX_COMPARISON_ORIGINS,
  );
  const projectedObjectCount = objectCount(result.union);
  if (projectedObjectCount > maximumObjects) {
    throw new Error(
      `Comparison projection would have ${projectedObjectCount} objects, exceeding budget ${maximumObjects}`,
    );
  }
  const projectedPortCount = portCount(result.union);
  if (projectedPortCount > maximumPorts) {
    throw new Error(
      `Comparison projection would have ${projectedPortCount} ports, exceeding budget ${maximumPorts}`,
    );
  }
  const projectedOriginCount = originCount(result.union);
  if (projectedOriginCount > maximumOrigins) {
    throw new Error(
      `Comparison projection would have ${projectedOriginCount} origins, exceeding budget ${maximumOrigins}`,
    );
  }
  validateSlice(result.reference, "Projected reference graph");
  validateSlice(result.candidate, "Projected candidate graph");
  validateSlice(result.union, "Projected union graph");
  validateComparisonRecords(result);
  return result;
};
