// SPDX-License-Identifier: Apache-2.0

import type { GraphEdge, GraphSlice } from "../model/graph";

const HIERARCHY_SEPARATOR = /::|[./]/;

export const shortModuleName = (value: string, maxLength = 24): string => {
  const short = value.split(HIERARCHY_SEPARATOR).filter(Boolean).at(-1) ?? value;
  if (short.length <= maxLength) return short;
  return `${short.slice(0, Math.max(1, maxLength - 1))}…`;
};

export interface DetectedControlSignal {
  key: string;
  name: string;
  role: "clock" | "reset";
}

const RESET_NAME = /rst|reset/i;
const CLOCK_NAME = /clk|clock/i;

interface NodeSignalLookup {
  label: string;
  ports: Map<string, string>;
}

const signalLookups = new WeakMap<GraphSlice, Map<string, NodeSignalLookup>>();

const signalLookup = (slice: GraphSlice) => {
  const cached = signalLookups.get(slice);
  if (cached) return cached;
  const lookup = new Map(
    slice.nodes.map((node) => [
      node.id,
      {
        label: node.label,
        ports: new Map(node.ports.map((port) => [port.id, port.name])),
      },
    ]),
  );
  signalLookups.set(slice, lookup);
  return lookup;
};

const edgeSignalNames = (slice: GraphSlice, edge: GraphEdge) => {
  const nodes = signalLookup(slice);
  const source = nodes.get(edge.sourceNode);
  const target = nodes.get(edge.targetNode);
  return [
    edge.label,
    source?.label,
    edge.sourcePort ? source?.ports.get(edge.sourcePort) : undefined,
    edge.targetPort ? target?.ports.get(edge.targetPort) : undefined,
  ].filter((name): name is string => Boolean(name));
};

export const controlSignalRole = (
  slice: GraphSlice,
  edge: GraphEdge,
): DetectedControlSignal["role"] | undefined => {
  if (edge.role === "clock" || edge.role === "reset") return edge.role;
  const names = edgeSignalNames(slice, edge);
  if (names.some((name) => RESET_NAME.test(name))) return "reset";
  if (names.some((name) => CLOCK_NAME.test(name))) return "clock";
  return undefined;
};

const controlSignalName = (slice: GraphSlice, edge: GraphEdge, role: "clock" | "reset"): string => {
  const pattern = role === "reset" ? RESET_NAME : CLOCK_NAME;
  return edgeSignalNames(slice, edge).find((name) => pattern.test(name)) ?? edge.label ?? edge.id;
};

export const controlSignalKey = (slice: GraphSlice, edge: GraphEdge): string | undefined => {
  const role = controlSignalRole(slice, edge);
  if (!role) return undefined;
  return `${role}:${edge.sourceNode}:${controlSignalName(slice, edge, role)}`;
};

export const detectedControlSignals = (slice: GraphSlice): DetectedControlSignal[] => {
  const detected = new Map<string, DetectedControlSignal>();
  for (const edge of slice.edges) {
    const role = controlSignalRole(slice, edge);
    const key = controlSignalKey(slice, edge);
    if (!key || !role) continue;
    detected.set(key, { key, name: controlSignalName(slice, edge, role), role });
  }
  return [...detected.values()].sort(
    (left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name),
  );
};
