// SPDX-License-Identifier: Apache-2.0

import type {
  ApiGraphEdge,
  ApiGraphGroup,
  ApiGraphNode,
  ApiGraphPort,
  ApiGraphSlice,
  ApiSourceFileRef,
} from "../api/contracts";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import { mergeElaborationRanges } from "../source/elaboration-ranges";

const prefixed = (instanceId: string, childId: string) => `${instanceId}/${childId}`;

export const MAX_PROJECTION_OBJECTS = RESOURCE_LIMITS.bundle.protobuf.graphObjects;
const MAX_PROJECTION_ORIGINS = RESOURCE_LIMITS.bundle.protobuf.origins;

const projectionObjectCount = (slice: ApiGraphSlice) =>
  slice.nodes.length + slice.edges.length + (slice.groups?.length ?? 0);

const sourceMetadataCount = (
  nodes: readonly ApiGraphNode[],
  edges: readonly ApiGraphEdge[],
  groups: readonly ApiGraphGroup[],
  elaborationRangeCount: number,
) =>
  nodes.reduce((count, node) => count + (node.origins?.length ?? 0), 0) +
  edges.reduce((count, edge) => count + (edge.origins?.length ?? 0), 0) +
  groups.reduce((count, group) => count + (group.origins?.length ?? 0), 0) +
  elaborationRangeCount;

const instancePort = (
  instance: ApiGraphNode,
  portId: string | undefined,
  edge: ApiGraphEdge,
  side: string,
) => {
  const port = instance.ports.find(
    (candidate) => candidate.id === portId || candidate.name === portId,
  );
  if (!port) {
    throw new Error(
      `Cannot flatten ${instance.label}: ${side} edge ${edge.id} references missing port ${portId ?? "<missing>"}`,
    );
  }
  return port;
};

const childBoundary = (
  child: ApiGraphSlice,
  portName: string,
  incoming: boolean,
): [ApiGraphNode, ApiGraphPort] | undefined => {
  for (const node of child.nodes) {
    const compatible = incoming
      ? node.kind === "input" || node.kind === "inout"
      : node.kind === "output" || node.kind === "inout";
    if (!compatible) continue;
    const port =
      node.ports.find((candidate) => candidate.name === portName) ??
      (node.label === portName ? node.ports[0] : undefined);
    if (port) return [node, port];
  }
  return undefined;
};

const mergeFiles = (left: ApiSourceFileRef[] = [], right: ApiSourceFileRef[] = []) => {
  const files = new Map<string, ApiSourceFileRef>();
  for (const file of [...left, ...right]) files.set(`${file.id}\0${file.path}`, file);
  return [...files.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path),
  );
};

const cloneSlice = (slice: ApiGraphSlice): ApiGraphSlice => structuredClone(slice);

export const expandInstance = (
  projection: ApiGraphSlice,
  instance: ApiGraphNode,
  child: ApiGraphSlice,
  maximumObjects: number = MAX_PROJECTION_OBJECTS,
  maximumOrigins: number = MAX_PROJECTION_ORIGINS,
) => {
  if (!instance.definitionName) throw new Error(`Instance ${instance.label} has no definition`);
  const expandedObjectCount =
    projectionObjectCount(projection) - 1 + projectionObjectCount(child) + 1;
  if (expandedObjectCount > maximumObjects) {
    throw new Error(
      `Projected graph would have ${expandedObjectCount} objects, exceeding budget ${maximumObjects}`,
    );
  }
  const rewiredEdges = projection.edges.map((edge) => {
    const copy = { ...edge };
    if (copy.targetNode === instance.id) {
      const parentPort = instancePort(instance, copy.targetPort, copy, "incoming");
      const boundary = childBoundary(child, parentPort.name, true);
      if (!boundary) {
        throw new Error(
          `Cannot flatten ${instance.label}: ${instance.definitionName} has no input ${parentPort.name}`,
        );
      }
      copy.targetNode = prefixed(instance.id, boundary[0].id);
      copy.targetPort = prefixed(instance.id, boundary[1].id);
    }
    if (copy.sourceNode === instance.id) {
      const parentPort = instancePort(instance, copy.sourcePort, copy, "outgoing");
      const boundary = childBoundary(child, parentPort.name, false);
      if (!boundary) {
        throw new Error(
          `Cannot flatten ${instance.label}: ${instance.definitionName} has no output ${parentPort.name}`,
        );
      }
      copy.sourceNode = prefixed(instance.id, boundary[0].id);
      copy.sourcePort = prefixed(instance.id, boundary[1].id);
    }
    return copy;
  });
  const childNodes = child.nodes.map((node) => ({
    ...node,
    id: prefixed(instance.id, node.id),
    ports: node.ports.map((port) => ({ ...port, id: prefixed(instance.id, port.id) })),
  }));
  const childEdges = child.edges.map((edge) => ({
    ...edge,
    id: prefixed(instance.id, edge.id),
    sourceNode: prefixed(instance.id, edge.sourceNode),
    sourcePort: edge.sourcePort ? prefixed(instance.id, edge.sourcePort) : undefined,
    targetNode: prefixed(instance.id, edge.targetNode),
    targetPort: edge.targetPort ? prefixed(instance.id, edge.targetPort) : undefined,
  }));
  const childGroups = (child.groups ?? []).map((group) => ({
    ...group,
    id: prefixed(instance.id, group.id),
    childNodeIds: group.childNodeIds.map((id) => prefixed(instance.id, id)),
  }));
  const group: ApiGraphGroup = {
    id: instance.id,
    name: instance.label,
    definitionName: instance.definitionName,
    parameters: instance.parameters,
    origins: instance.origins,
    childNodeIds: childNodes.map((node) => node.id).sort(),
  };
  const nodes = [...projection.nodes.filter((node) => node.id !== instance.id), ...childNodes];
  const edges = [...rewiredEdges, ...childEdges];
  const groups = [...(projection.groups ?? []), ...childGroups, group];
  const elaborationRanges = mergeElaborationRanges(
    projection.elaborationRanges,
    child.elaborationRanges,
    maximumOrigins,
  );
  const metadataCount = sourceMetadataCount(nodes, edges, groups, elaborationRanges?.length ?? 0);
  if (metadataCount > maximumOrigins) {
    throw new Error(
      `Projected graph would have ${metadataCount} origins and elaboration ranges, exceeding budget ${maximumOrigins}`,
    );
  }
  projection.nodes = nodes;
  projection.edges = edges;
  projection.groups = groups;
  projection.files = mergeFiles(projection.files, child.files);
  projection.elaborationRanges = elaborationRanges;
};

const sortProjection = (slice: ApiGraphSlice) => {
  slice.nodes.sort((left, right) => left.id.localeCompare(right.id));
  slice.edges.sort((left, right) => left.id.localeCompare(right.id));
  slice.groups?.sort((left, right) => left.id.localeCompare(right.id));
};

export const flattenSlice = async (
  base: ApiGraphSlice,
  depth: number,
  loadDefinition: (name: string) => Promise<ApiGraphSlice | undefined>,
  maximumObjects: number = MAX_PROJECTION_OBJECTS,
  maximumOrigins: number = MAX_PROJECTION_ORIGINS,
): Promise<ApiGraphSlice> => {
  if (depth <= 0) return cloneSlice(base);
  const projection = cloneSlice(base);
  const instances = base.nodes.filter((node) => node.kind === "moduleInstance");
  for (const instance of instances) {
    if (!instance.definitionName) continue;
    const child = await loadDefinition(instance.definitionName);
    if (!child) continue;
    const flattenedChild = await flattenSlice(
      child,
      depth - 1,
      loadDefinition,
      maximumObjects,
      maximumOrigins,
    );
    expandInstance(projection, instance, flattenedChild, maximumObjects, maximumOrigins);
  }
  sortProjection(projection);
  return projection;
};

export const flattenSelected = async (
  base: ApiGraphSlice,
  instanceIds: string[],
  loadDefinition: (name: string) => Promise<ApiGraphSlice | undefined>,
  maximumObjects: number = MAX_PROJECTION_OBJECTS,
  maximumOrigins: number = MAX_PROJECTION_ORIGINS,
) => {
  const projection = cloneSlice(base);
  for (const id of [...new Set(instanceIds)].sort()) {
    const instance = base.nodes.find((node) => node.id === id);
    if (!instance) throw new Error(`Instance ${id} does not exist in ${base.module.name}`);
    if (instance.kind !== "moduleInstance") throw new Error(`${id} is not a module instance`);
    if (!instance.definitionName) throw new Error(`Instance ${instance.label} has no definition`);
    const child = await loadDefinition(instance.definitionName);
    if (!child) throw new Error(`Definition ${instance.definitionName} is not in this bundle`);
    expandInstance(projection, instance, child, maximumObjects, maximumOrigins);
  }
  sortProjection(projection);
  return projection;
};
