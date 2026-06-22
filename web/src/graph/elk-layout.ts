// SPDX-License-Identifier: Apache-2.0

import type { ElkExtendedEdge, ElkNode, ElkPort, LayoutOptions } from "elkjs/lib/elk-api";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?worker&url";
import type { GraphEdge, GraphNode, GraphPort, GraphSlice } from "../model/graph";
import { logicGateKind } from "./gate-symbol";
import { effectiveLayoutProfile, type LayoutProfile } from "./layout-profile";
import type {
  FlattenRenderMode,
  LayoutEdge,
  LayoutGroup,
  LayoutNode,
  LayoutResult,
} from "./layout-types";
import { shortModuleName } from "./presentation";

const GROUP_PADDING = { top: 42, right: 22, bottom: 22, left: 22 } as const;
const PORT_SIZE = 7;
const REGISTER_CLOCK_BOTTOM_OFFSET = 22;
const MODULE_HEADER_HEIGHT = 38;
const MODULE_PORT_PITCH = 18;
const MODULE_BOTTOM_PADDING = 16;
const MODULE_LABEL_CHARACTER_WIDTH = 5.2;
const MUX_INPUT_PITCH = 24;
const MUX_VERTICAL_PADDING = 34;
const ROOT_CONTAINER_ID = "\0root";
const createElk = () =>
  typeof Worker === "function"
    ? Promise.resolve(
        new ELK({ workerFactory: () => new Worker(elkWorkerUrl, { type: "module" }) }),
      )
    : import("elkjs/lib/elk.bundled.js").then((module) => {
        const NodeElk = module.default as typeof ELK;
        return new NodeElk();
      });

let elk: ReturnType<typeof createElk> | undefined;

const getElk = () => {
  elk ??= createElk();
  return elk;
};

const nodeSize = (node: GraphNode): { width: number; height: number } => {
  switch (node.kind) {
    case "operator":
      return logicGateKind(node.glyph) ? { width: 68, height: 58 } : { width: 58, height: 58 };
    case "mux": {
      const dataInputs = node.ports.filter(
        (port) => port.direction === "input" && port.role !== "select",
      );
      return {
        width: 74,
        height: Math.max(138, MUX_VERTICAL_PADDING + dataInputs.length * MUX_INPUT_PITCH),
      };
    }
    case "register":
    case "latch":
      return { width: 104, height: 116 };
    case "module": {
      const sides = modulePortsBySide(node);
      const leftLabelWidth = longestPortLabel(sides.west);
      const rightLabelWidth = longestPortLabel(sides.east);
      const controlLabelWidth = sides.south.reduce(
        (width, port) => width + port.name.length * MODULE_LABEL_CHARACTER_WIDTH + 16,
        0,
      );
      const verticalPorts = Math.max(sides.west.length, sides.east.length);
      return {
        width: Math.max(
          node.transparent ? 156 : 142,
          shortModuleName(node.label, 20).length * 6.2 + 28,
          leftLabelWidth + rightLabelWidth + 48,
          controlLabelWidth + 20,
        ),
        height: Math.max(
          node.transparent ? 126 : 110,
          MODULE_HEADER_HEIGHT + verticalPorts * MODULE_PORT_PITCH + MODULE_BOTTOM_PADDING,
        ),
      };
    }
    case "memory": {
      const sides = modulePortsBySide(node);
      const leftLabelWidth = longestPortLabel(sides.west);
      const rightLabelWidth = longestPortLabel(sides.east);
      const controlLabelWidth = sides.south.reduce(
        (width, port) => width + port.name.length * MODULE_LABEL_CHARACTER_WIDTH + 16,
        0,
      );
      const verticalPorts = Math.max(sides.west.length, sides.east.length);
      return {
        width: Math.max(142, leftLabelWidth + rightLabelWidth + 48, controlLabelWidth + 20),
        height: Math.max(
          110,
          MODULE_HEADER_HEIGHT + verticalPorts * MODULE_PORT_PITCH + MODULE_BOTTOM_PADDING,
        ),
      };
    }
    case "input":
    case "output":
      return { width: 76, height: 34 };
    case "constant":
      return { width: Math.max(28, node.label.length * 6.8 + 12), height: 24 };
    default:
      return { width: 112, height: 76 };
  }
};

const longestPortLabel = (ports: GraphPort[]): number =>
  ports.reduce(
    (longest, port) => Math.max(longest, port.name.length * MODULE_LABEL_CHARACTER_WIDTH),
    0,
  );

const modulePortsBySide = (node: GraphNode) => ({
  west: node.ports.filter((port) => portSide(node, port.direction, port.role) === "WEST"),
  east: node.ports.filter((port) => portSide(node, port.direction, port.role) === "EAST"),
  south: node.ports.filter((port) => portSide(node, port.direction, port.role) === "SOUTH"),
});

interface PeerIndex {
  count: number;
  positions: Map<string, number>;
}

const indexPeers = (ports: GraphPort[]): PeerIndex => ({
  count: ports.length,
  positions: new Map(ports.map((port, index) => [port.id, index])),
});

interface NodePortIndexes {
  bySide: Map<string, PeerIndex>;
  inputs: PeerIndex;
  dataInputs: PeerIndex;
  controls: PeerIndex;
}

const nodePortIndexes = new WeakMap<GraphNode, NodePortIndexes>();

const portIndexes = (node: GraphNode) => {
  const cached = nodePortIndexes.get(node);
  if (cached) return cached;
  const sides = modulePortsBySide(node);
  const indexes = {
    bySide: new Map([
      ["WEST", indexPeers(sides.west)],
      ["EAST", indexPeers(sides.east)],
      ["SOUTH", indexPeers(sides.south)],
    ]),
    inputs: indexPeers(node.ports.filter((port) => port.direction === "input")),
    dataInputs: indexPeers(
      node.ports.filter((port) => port.direction === "input" && port.role !== "select"),
    ),
    controls: indexPeers(
      node.ports.filter((port) => port.role === "reset" || port.role === "enable"),
    ),
  };
  nodePortIndexes.set(node, indexes);
  return indexes;
};

const portSide = (node: GraphNode, direction: string, role?: string): string => {
  if (node.kind === "input") return "EAST";
  if (node.kind === "output") return "WEST";
  if (node.kind === "mux" && role === "select") return "SOUTH";
  if ((node.kind === "register" || node.kind === "latch") && role === "clock") return "WEST";
  if (role === "clock" || role === "reset" || role === "enable") return "SOUTH";
  return direction === "output" ? "EAST" : "WEST";
};

const fixedPortPosition = (
  node: GraphNode,
  port: GraphPort,
  size: { width: number; height: number },
): Pick<ElkPort, "x" | "y"> => {
  const halfPort = PORT_SIZE / 2;
  const name = port.name.trim().toUpperCase();

  if (node.kind === "module" || node.kind === "memory") {
    const side = portSide(node, port.direction, port.role);
    const peers = portIndexes(node).bySide.get(side) ?? indexPeers([]);
    const index = peers.positions.get(port.id) ?? 0;
    if (side === "SOUTH") {
      return {
        x: (size.width * (index + 1)) / (peers.count + 1) - halfPort,
        y: size.height - halfPort,
      };
    }
    return {
      x: side === "EAST" ? size.width - halfPort : -halfPort,
      y: MODULE_HEADER_HEIGHT + index * MODULE_PORT_PITCH + (MODULE_PORT_PITCH - PORT_SIZE) / 2,
    };
  }

  if (node.kind === "operator" && logicGateKind(node.glyph)) {
    if (port.direction === "output") {
      return { x: size.width - halfPort, y: size.height / 2 - halfPort };
    }
    const inputs = portIndexes(node).inputs;
    const index = inputs.positions.get(port.id) ?? 0;
    return {
      x: -halfPort,
      y: (size.height * (index + 1)) / (inputs.count + 1) - halfPort,
    };
  }

  if (node.kind === "mux") {
    if (port.role === "select") {
      return { x: size.width / 2 - halfPort, y: size.height - halfPort };
    }
    if (port.direction === "output") {
      return { x: size.width - halfPort, y: size.height / 2 - halfPort };
    }
    const dataInputs = portIndexes(node).dataInputs;
    const index = dataInputs.positions.get(port.id) ?? 0;
    return {
      x: -halfPort,
      y: (size.height * (index + 1)) / (dataInputs.count + 1) - halfPort,
    };
  }

  if (port.role === "clock") {
    return { x: -halfPort, y: size.height - REGISTER_CLOCK_BOTTOM_OFFSET - halfPort };
  }
  if (port.role === "reset" || port.role === "enable") {
    const controls = portIndexes(node).controls;
    const index = controls.positions.get(port.id) ?? 0;
    return {
      x: (size.width * (index + 1)) / (controls.count + 1) - halfPort,
      y: size.height - halfPort,
    };
  }
  if (port.direction === "output") {
    const centerY = name === "Q" ? size.height / 2 : size.height * 0.42;
    return { x: size.width - halfPort, y: centerY - halfPort };
  }

  const centerY =
    name === "D" ? size.height / 2 : name === "AD" ? size.height * 0.27 : size.height * 0.4;
  return { x: -halfPort, y: centerY - halfPort };
};

const overviewPortPosition = (
  node: GraphNode,
  port: GraphPort,
  size: { width: number; height: number },
): Pick<ElkPort, "x" | "y"> => {
  if (
    node.kind === "register" ||
    node.kind === "latch" ||
    node.kind === "module" ||
    node.kind === "mux" ||
    (node.kind === "operator" && Boolean(logicGateKind(node.glyph)))
  ) {
    return fixedPortPosition(node, port, size);
  }

  const side = portSide(node, port.direction, port.role);
  const peers = portIndexes(node).bySide.get(side) ?? indexPeers([]);
  const index = peers.positions.get(port.id) ?? 0;
  const halfPort = PORT_SIZE / 2;
  if (side === "SOUTH" || side === "NORTH") {
    return {
      x: (size.width * (index + 1)) / (peers.count + 1) - halfPort,
      y: side === "SOUTH" ? size.height - halfPort : -halfPort,
    };
  }
  return {
    x: side === "EAST" ? size.width - halfPort : -halfPort,
    y: (size.height * (index + 1)) / (peers.count + 1) - halfPort,
  };
};

interface OverviewBlock {
  group?: NonNullable<GraphSlice["groups"]>[number];
  nodes: LayoutNode[];
  width: number;
  height: number;
}

const gridBlock = (
  sourceNodes: GraphNode[],
  group?: NonNullable<GraphSlice["groups"]>[number],
): OverviewBlock => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(sourceNodes.length * 1.8)));
  const rows = Math.max(1, Math.ceil(sourceNodes.length / columns));
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  const sizes = sourceNodes.map(nodeSize);
  for (const [index, size] of sizes.entries()) {
    columnWidths[index % columns] = Math.max(columnWidths[index % columns], size.width);
    rowHeights[Math.floor(index / columns)] = Math.max(
      rowHeights[Math.floor(index / columns)],
      size.height,
    );
  }
  const xOffsets: number[] = [];
  const yOffsets: number[] = [];
  for (const index of columnWidths.keys()) {
    xOffsets[index] = (xOffsets[index - 1] ?? 0) + (index === 0 ? 0 : columnWidths[index - 1] + 54);
  }
  for (const index of rowHeights.keys()) {
    yOffsets[index] = (yOffsets[index - 1] ?? 0) + (index === 0 ? 0 : rowHeights[index - 1] + 46);
  }
  const left = group ? GROUP_PADDING.left : 0;
  const top = group ? GROUP_PADDING.top : 0;
  const nodes = sourceNodes.map((node, index): LayoutNode => {
    const size = sizes[index];
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + xOffsets[column] + (columnWidths[column] - size.width) / 2;
    const y = top + yOffsets[row] + (rowHeights[row] - size.height) / 2;
    return {
      ...node,
      x,
      y,
      width: size.width,
      height: size.height,
      ports: node.ports.map((port) => {
        const position = overviewPortPosition(node, port, size);
        return {
          ...port,
          bitWidth: port.width,
          x: x + (position.x ?? 0),
          y: y + (position.y ?? 0),
          width: PORT_SIZE,
          height: PORT_SIZE,
        };
      }),
    };
  });
  const width =
    left + xOffsets[columns - 1] + columnWidths[columns - 1] + (group ? GROUP_PADDING.right : 0);
  const height =
    top + yOffsets[rows - 1] + rowHeights[rows - 1] + (group ? GROUP_PADDING.bottom : 0);
  const alignedNodes = group
    ? nodes.map((node) => {
        const x = node.kind === "input" ? 0 : node.kind === "output" ? width - node.width : node.x;
        const offset = x - node.x;
        return offset === 0
          ? node
          : {
              ...node,
              x,
              ports: node.ports.map((port) => ({ ...port, x: port.x + offset })),
            };
      })
    : nodes;
  return {
    group,
    nodes: alignedNodes,
    width,
    height,
  };
};

const runGridOverview = (slice: GraphSlice, start: number): LayoutResult => {
  const groupedNodeIds = new Set((slice.groups ?? []).flatMap((group) => group.childNodeIds));
  const topInputs = slice.nodes.filter(
    (node) => node.kind === "input" && !groupedNodeIds.has(node.id),
  );
  const topOutputs = slice.nodes.filter(
    (node) => node.kind === "output" && !groupedNodeIds.has(node.id),
  );
  const nodeById = new Map(slice.nodes.map((node) => [node.id, node]));
  const blocks = (slice.groups ?? []).flatMap((group) => {
    const children = group.childNodeIds.flatMap((id) => {
      const node = nodeById.get(id);
      return node ? [node] : [];
    });
    return children.length > 0 ? [gridBlock(children, group)] : [];
  });
  const ungrouped = slice.nodes.filter(
    (node) => !groupedNodeIds.has(node.id) && node.kind !== "input" && node.kind !== "output",
  );
  if (ungrouped.length > 0) blocks.unshift(gridBlock(ungrouped));

  const blockColumns = Math.max(1, Math.ceil(Math.sqrt(blocks.length * 1.8)));
  const blockRows = Math.max(1, Math.ceil(blocks.length / blockColumns));
  const blockColumnWidths = Array.from({ length: blockColumns }, () => 0);
  const blockRowHeights = Array.from({ length: blockRows }, () => 0);
  for (const [index, block] of blocks.entries()) {
    blockColumnWidths[index % blockColumns] = Math.max(
      blockColumnWidths[index % blockColumns],
      block.width,
    );
    blockRowHeights[Math.floor(index / blockColumns)] = Math.max(
      blockRowHeights[Math.floor(index / blockColumns)],
      block.height,
    );
  }
  const contentWidth =
    blockColumnWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, blockColumns - 1) * 96;
  const contentHeight =
    blockRowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, blockRows - 1) * 96;
  const boundaryHeight = Math.max(topInputs.length, topOutputs.length) * 44 + 64;
  const width = Math.max(420, contentWidth + 236);
  const height = Math.max(280, contentHeight + 128, boundaryHeight);
  const positionedNodes: LayoutNode[] = [];
  const groups: LayoutGroup[] = [];
  let rowY = 64;
  for (let row = 0; row < blockRows; row += 1) {
    let columnX = 118;
    for (let column = 0; column < blockColumns; column += 1) {
      const index = row * blockColumns + column;
      const block = blocks[index];
      if (!block) break;
      const x = columnX + (blockColumnWidths[column] - block.width) / 2;
      const y = rowY + (blockRowHeights[row] - block.height) / 2;
      positionedNodes.push(
        ...block.nodes.map((node) => ({
          ...node,
          x: node.x + x,
          y: node.y + y,
          ports: node.ports.map((port) => ({ ...port, x: port.x + x, y: port.y + y })),
        })),
      );
      if (block.group) {
        groups.push({ ...block.group, x, y, width: block.width, height: block.height });
      }
      columnX += blockColumnWidths[column] + 96;
    }
    rowY += blockRowHeights[row] + 96;
  }

  const placeBoundary = (nodes: GraphNode[], side: "left" | "right") =>
    nodes.map((node, index): LayoutNode => {
      const size = nodeSize(node);
      const x = side === "left" ? 8 : width - size.width - 8;
      const y = (height * (index + 1)) / (nodes.length + 1) - size.height / 2;
      return {
        ...node,
        x,
        y,
        width: size.width,
        height: size.height,
        ports: node.ports.map((port) => {
          const position = overviewPortPosition(node, port, size);
          return {
            ...port,
            bitWidth: port.width,
            x: x + (position.x ?? 0),
            y: y + (position.y ?? 0),
            width: PORT_SIZE,
            height: PORT_SIZE,
          };
        }),
      };
    });
  positionedNodes.push(...placeBoundary(topInputs, "left"), ...placeBoundary(topOutputs, "right"));

  const layoutNodeById = new Map(positionedNodes.map((node) => [node.id, node]));
  const portPoint = (nodeId: string, portId: string | undefined, direction: "input" | "output") => {
    const node = layoutNodeById.get(nodeId);
    if (node && groupedNodeIds.has(node.id)) {
      if (node.kind === "input" && direction === "input") {
        return { x: node.x, y: node.y + node.height / 2 };
      }
      if (node.kind === "output" && direction === "output") {
        return { x: node.x + node.width, y: node.y + node.height / 2 };
      }
    }
    const port =
      node?.ports.find((candidate) => candidate.id === portId) ??
      node?.ports.find((candidate) => candidate.direction === direction);
    return port ? { x: port.x + port.width / 2, y: port.y + port.height / 2 } : undefined;
  };
  const edges: LayoutEdge[] = slice.edges.map((edge) => {
    const startPoint = portPoint(edge.sourceNode, edge.sourcePort, "output");
    const endPoint = portPoint(edge.targetNode, edge.targetPort, "input");
    if (!startPoint || !endPoint) return { ...edge, sections: [] };
    const middleX = (startPoint.x + endPoint.x) / 2;
    return {
      ...edge,
      sections: [
        {
          startPoint,
          bendPoints: [
            { x: middleX, y: startPoint.y },
            { x: middleX, y: endPoint.y },
          ],
          endPoint,
        },
      ],
    };
  });
  return {
    width,
    height,
    groups,
    nodes: positionedNodes,
    edges,
    elapsedMs: performance.now() - start,
  };
};

interface GroupHierarchy {
  groupsById: Map<string, NonNullable<GraphSlice["groups"]>[number]>;
  childGroupIdsByContainer: Map<string, string[]>;
  nodeIdsByContainer: Map<string, string[]>;
}

const groupHierarchy = (slice: GraphSlice): GroupHierarchy => {
  const nodeOrder = new Map(slice.nodes.map((node, index) => [node.id, index]));
  const groups = (slice.groups ?? []).filter((group) =>
    group.childNodeIds.some((id) => nodeOrder.has(id)),
  );
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const nodeIdsByGroupId = new Map(
    groups.map((group) => [
      group.id,
      new Set(group.childNodeIds.filter((id) => nodeOrder.has(id))),
    ]),
  );
  const contains = (containerId: string, childId: string) => {
    const container = nodeIdsByGroupId.get(containerId);
    const child = nodeIdsByGroupId.get(childId);
    return Boolean(container && child && [...child].every((id) => container.has(id)));
  };
  const parentByGroupId = new Map<string, string>();
  for (const group of groups) {
    const childNodeIds = nodeIdsByGroupId.get(group.id) as Set<string>;
    const parent = groups
      .filter(
        (candidate) =>
          candidate.id !== group.id &&
          contains(candidate.id, group.id) &&
          (candidate.childNodeIds.length > childNodeIds.size ||
            group.id.startsWith(`${candidate.id}/`)),
      )
      .sort((left, right) => {
        const sizeDifference =
          (nodeIdsByGroupId.get(left.id)?.size ?? 0) - (nodeIdsByGroupId.get(right.id)?.size ?? 0);
        return (
          sizeDifference || right.id.length - left.id.length || left.id.localeCompare(right.id)
        );
      })[0];
    if (parent) parentByGroupId.set(group.id, parent.id);
  }

  const ownerByNodeId = new Map<string, string>();
  for (const node of slice.nodes) {
    const owner = groups
      .filter((group) => nodeIdsByGroupId.get(group.id)?.has(node.id))
      .sort((left, right) => {
        const sizeDifference =
          (nodeIdsByGroupId.get(left.id)?.size ?? 0) - (nodeIdsByGroupId.get(right.id)?.size ?? 0);
        return (
          sizeDifference || right.id.length - left.id.length || left.id.localeCompare(right.id)
        );
      })[0];
    if (owner) ownerByNodeId.set(node.id, owner.id);
  }

  const childGroupIdsByContainer = new Map<string, string[]>();
  for (const group of groups) {
    const parentId = parentByGroupId.get(group.id) ?? ROOT_CONTAINER_ID;
    childGroupIdsByContainer.set(parentId, [
      ...(childGroupIdsByContainer.get(parentId) ?? []),
      group.id,
    ]);
  }
  const nodeIdsByContainer = new Map<string, string[]>();
  for (const node of slice.nodes) {
    const containerId = ownerByNodeId.get(node.id) ?? ROOT_CONTAINER_ID;
    nodeIdsByContainer.set(containerId, [...(nodeIdsByContainer.get(containerId) ?? []), node.id]);
  }
  const firstNodeIndex = (groupId: string) => {
    let first = Number.POSITIVE_INFINITY;
    for (const id of nodeIdsByGroupId.get(groupId) ?? []) {
      first = Math.min(first, nodeOrder.get(id) ?? 0);
    }
    return first;
  };
  for (const childIds of childGroupIdsByContainer.values()) {
    childIds.sort(
      (left, right) => firstNodeIndex(left) - firstNodeIndex(right) || left.localeCompare(right),
    );
  }

  return {
    groupsById,
    childGroupIdsByContainer,
    nodeIdsByContainer,
  };
};

const flatLayoutSlice = (slice: GraphSlice): GraphSlice => {
  const projectedNodeIds = new Set((slice.groups ?? []).flatMap((group) => group.childNodeIds));
  const boundaries = slice.nodes.filter(
    (node) =>
      projectedNodeIds.has(node.id) &&
      (node.kind === "input" || node.kind === "output" || node.kind === "inout"),
  );
  let edges = slice.edges.map((edge) => ({ ...edge }));
  for (const boundary of boundaries) {
    const incoming = edges.filter((edge) => edge.targetNode === boundary.id);
    const outgoing = edges.filter((edge) => edge.sourceNode === boundary.id);
    const remaining = edges.filter(
      (edge) => edge.sourceNode !== boundary.id && edge.targetNode !== boundary.id,
    );
    const usedIds = new Set(remaining.map((edge) => edge.id));
    const spliced: GraphEdge[] = [];
    let pairIndex = 0;
    for (const source of incoming) {
      for (const target of outgoing) {
        if (source.sourceNode === boundary.id || target.targetNode === boundary.id) continue;
        const semantic = boundary.kind === "output" ? target : source;
        let id = semantic.id;
        while (usedIds.has(id)) {
          id = `${semantic.id}~flat-${pairIndex}`;
          pairIndex += 1;
        }
        usedIds.add(id);
        spliced.push({
          ...semantic,
          id,
          sourceNode: source.sourceNode,
          sourcePort: source.sourcePort,
          targetNode: target.targetNode,
          targetPort: target.targetPort,
        });
      }
    }
    edges = [...remaining, ...spliced];
  }
  const boundaryIds = new Set(boundaries.map((node) => node.id));
  return {
    ...slice,
    nodes: slice.nodes.filter((node) => !boundaryIds.has(node.id)),
    edges,
    groups: undefined,
  };
};

const layoutSlice = (slice: GraphSlice, flattenRenderMode: FlattenRenderMode) =>
  flattenRenderMode === "flat" ? flatLayoutSlice(slice) : slice;

const layeredLayoutOptions = (
  effectiveProfile: Exclude<LayoutProfile, "auto">,
  padding: string,
): LayoutOptions => {
  const overview = effectiveProfile !== "detailed";
  return {
    "elk.algorithm": "layered",
    "elk.randomSeed": "1",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    // Keep source/model order as a preference, not a hard crossing constraint.
    // Forcing it more than doubles layout time on the 2k-node regression graph.
    "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
    "elk.layered.nodePlacement.favorStraightEdges": overview ? "false" : "true",
    "elk.layered.unnecessaryBendpoints": "false",
    ...(overview
      ? {
          // The interactive sweep and simple placement strategies trade a little crossing
          // quality for a much cheaper overview of multi-thousand-node flattened graphs.
          "elk.layered.thoroughness": "1",
          "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
          "elk.layered.nodePlacement.strategy": "SIMPLE",
        }
      : {}),
    ...(effectiveProfile === "balanced"
      ? {
          // Split long layered drawings into adjacent flow chunks near a screen-shaped ratio.
          "elk.aspectRatio": "1.8",
          "elk.layered.wrapping.strategy": "MULTI_EDGE",
          "elk.layered.wrapping.multiEdge.improveCuts": "false",
          "elk.layered.wrapping.multiEdge.improveWrappedEdges": "false",
        }
      : {}),
    "elk.spacing.nodeNode": "46",
    "elk.layered.spacing.nodeNodeBetweenLayers": "82",
    "elk.layered.spacing.edgeNodeBetweenLayers": "24",
    "elk.spacing.edgeEdge": "18",
    "elk.padding": padding,
    "elk.separateConnectedComponents": "false",
  };
};

const groupLayoutOptions = (
  effectiveProfile: Exclude<LayoutProfile, "auto">,
  left: number,
  right: number,
): LayoutOptions => {
  const overview = effectiveProfile !== "detailed";
  return {
    "elk.algorithm": "layered",
    "elk.randomSeed": "1",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    ...(overview
      ? {
          // Hierarchical layered layout requires every level to use the same crossing processor.
          "elk.layered.thoroughness": "1",
          "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
          "elk.layered.nodePlacement.strategy": "SIMPLE",
        }
      : {}),
    "elk.spacing.nodeNode": "46",
    "elk.layered.spacing.nodeNodeBetweenLayers": "82",
    "elk.layered.spacing.edgeNodeBetweenLayers": "24",
    "elk.spacing.edgeEdge": "18",
    "elk.padding": `[top=${GROUP_PADDING.top},left=${left},bottom=${GROUP_PADDING.bottom},right=${right}]`,
    "elk.separateConnectedComponents": "false",
  };
};

export const toElkGraph = (
  slice: GraphSlice,
  profile: LayoutProfile = "auto",
  flattenRenderMode: FlattenRenderMode = "grouped",
): ElkNode => {
  const prepared = layoutSlice(slice, flattenRenderMode);
  const effectiveProfile = effectiveLayoutProfile(prepared, profile);
  const hierarchy = groupHierarchy(prepared);
  const projectedNodeIds = new Set((prepared.groups ?? []).flatMap((group) => group.childNodeIds));
  const sourceNodes = new Map(prepared.nodes.map((node) => [node.id, node]));
  const sourceOrder = new Map(prepared.nodes.map((node, index) => [node.id, index]));
  const elkNode = (node: GraphNode): ElkNode => {
    const size = nodeSize(node);
    const fixedPorts =
      node.kind === "register" ||
      node.kind === "latch" ||
      node.kind === "module" ||
      node.kind === "memory" ||
      node.kind === "mux" ||
      (node.kind === "operator" && Boolean(logicGateKind(node.glyph)));
    const projected = projectedNodeIds.has(node.id);
    return {
      id: node.id,
      width: size.width,
      height: size.height,
      layoutOptions: {
        "elk.portConstraints": fixedPorts ? "FIXED_POS" : "FIXED_SIDE",
        ...(node.kind === "input"
          ? { "elk.layered.layering.layerConstraint": projected ? "FIRST" : "FIRST_SEPARATE" }
          : node.kind === "output"
            ? { "elk.layered.layering.layerConstraint": projected ? "LAST" : "LAST_SEPARATE" }
            : {}),
      },
      ports: node.ports.flatMap((port): ElkPort[] => {
        const semanticPort: ElkPort = {
          id: `${node.id}:${port.id}`,
          width: 7,
          height: 7,
          ...(fixedPorts ? fixedPortPosition(node, port, size) : {}),
          layoutOptions: {
            "elk.port.side": portSide(node, port.direction, port.role),
          },
        };
        const isProjectedBoundary =
          projectedNodeIds.has(node.id) && (node.kind === "input" || node.kind === "output");
        if (!isProjectedBoundary) return [semanticPort];
        return [
          semanticPort,
          {
            id: `${node.id}:${port.id}:external`,
            width: 0,
            height: 0,
            layoutOptions: {
              "elk.port.side": node.kind === "input" ? "WEST" : "EAST",
            },
          },
        ];
      }),
    };
  };
  const containerChildren = (containerId: string): ElkNode[] => {
    const nodes = (hierarchy.nodeIdsByContainer.get(containerId) ?? []).flatMap((id) => {
      const node = sourceNodes.get(id);
      return node ? [elkNode(node)] : [];
    });
    const groups = (hierarchy.childGroupIdsByContainer.get(containerId) ?? []).flatMap((id) => {
      const group = hierarchy.groupsById.get(id);
      const childNodes = (hierarchy.nodeIdsByContainer.get(id) ?? []).flatMap((nodeId) => {
        const node = sourceNodes.get(nodeId);
        return node ? [node] : [];
      });
      const left = childNodes.some((node) => node.kind === "input" || node.kind === "inout")
        ? 0
        : GROUP_PADDING.left;
      const right = childNodes.some((node) => node.kind === "output" || node.kind === "inout")
        ? 0
        : GROUP_PADDING.right;
      return group
        ? [
            {
              id: group.id,
              layoutOptions: groupLayoutOptions(effectiveProfile, left, right),
              children: containerChildren(group.id),
            },
          ]
        : [];
    });
    const firstDescendant = (child: ElkNode) => {
      if (sourceOrder.has(child.id)) return sourceOrder.get(child.id) as number;
      const group = hierarchy.groupsById.get(child.id);
      return Math.min(...(group?.childNodeIds ?? []).map((id) => sourceOrder.get(id) ?? 0));
    };
    return [...nodes, ...groups].sort(
      (left, right) =>
        firstDescendant(left) - firstDescendant(right) || left.id.localeCompare(right.id),
    );
  };

  return {
    id: "root",
    layoutOptions: layeredLayoutOptions(effectiveProfile, "[top=96,left=8,bottom=64,right=8]"),
    children: containerChildren(ROOT_CONTAINER_ID),
    edges: prepared.edges.map((edge): ElkExtendedEdge => {
      const source = sourceNodes.get(edge.sourceNode);
      const target = sourceNodes.get(edge.targetNode);
      const sourceExternal = projectedNodeIds.has(edge.sourceNode) && source?.kind === "output";
      const targetExternal = projectedNodeIds.has(edge.targetNode) && target?.kind === "input";
      return {
        id: edge.id,
        sources: [
          `${edge.sourceNode}:${edge.sourcePort ?? "out"}${sourceExternal ? ":external" : ""}`,
        ],
        targets: [
          `${edge.targetNode}:${edge.targetPort ?? "in"}${targetExternal ? ":external" : ""}`,
        ],
      };
    }),
  };
};

export const runElkLayout = async (
  slice: GraphSlice,
  profile: LayoutProfile = "auto",
  flattenRenderMode: FlattenRenderMode = "grouped",
): Promise<LayoutResult> => {
  const start = performance.now();
  const prepared = layoutSlice(slice, flattenRenderMode);
  if (effectiveLayoutProfile(prepared, profile) === "fast") {
    return runGridOverview(prepared, start);
  }
  const result = await (await getElk()).layout(toElkGraph(prepared, profile));
  const sourceNodes = new Map(prepared.nodes.map((node) => [node.id, node]));
  const sourceEdges = new Map(prepared.edges.map((edge) => [edge.id, edge]));

  const sourceGroups = new Map((prepared.groups ?? []).map((group) => [group.id, group]));
  const nodes: LayoutNode[] = [];
  const groupsById = new Map<string, LayoutGroup>();
  const containerOffsets = new Map([[ROOT_CONTAINER_ID, { x: 0, y: 0 }]]);
  const collectChildren = (children: ElkNode[], parentX: number, parentY: number) => {
    for (const child of children) {
      const x = parentX + (child.x ?? 0);
      const y = parentY + (child.y ?? 0);
      const source = sourceNodes.get(child.id);
      if (source) {
        const ports = new Map(source.ports.map((port) => [`${source.id}:${port.id}`, port]));
        nodes.push({
          ...source,
          x,
          y,
          width: child.width ?? 0,
          height: child.height ?? 0,
          ports: (child.ports ?? []).flatMap((port) => {
            const isExternal = port.id.endsWith(":external");
            const semanticId = isExternal ? port.id.slice(0, -":external".length) : port.id;
            const semantic = ports.get(semanticId);
            if (!semantic) throw new Error(`ELK returned unknown port ${port.id}`);
            return isExternal
              ? []
              : [
                  {
                    id: semantic.id,
                    name: semantic.name,
                    direction: semantic.direction,
                    index: semantic.index,
                    role: semantic.role,
                    bitWidth: semantic.width,
                    x: x + (port.x ?? 0),
                    y: y + (port.y ?? 0),
                    width: port.width ?? 0,
                    height: port.height ?? 0,
                  },
                ];
          }),
        });
        continue;
      }
      const group = sourceGroups.get(child.id);
      if (!group) throw new Error(`ELK returned unknown node ${child.id}`);
      groupsById.set(group.id, {
        ...group,
        x,
        y,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      containerOffsets.set(group.id, { x, y });
      collectChildren(child.children ?? [], x, y);
    }
  };
  collectChildren(result.children ?? [], 0, 0);

  const edges: LayoutEdge[] = (result.edges ?? []).map((edge) => {
    const source = sourceEdges.get(edge.id);
    if (!source) throw new Error(`ELK returned unknown edge ${edge.id}`);
    const offset = containerOffsets.get(edge.container ?? ROOT_CONTAINER_ID) ?? { x: 0, y: 0 };
    const point = ({ x, y }: { x: number; y: number }) => ({ x: x + offset.x, y: y + offset.y });
    return {
      ...source,
      sections: (edge.sections ?? []).map((section) => ({
        startPoint: point(section.startPoint),
        bendPoints: (section.bendPoints ?? []).map(point),
        endPoint: point(section.endPoint),
      })),
    };
  });

  const hierarchy = groupHierarchy(prepared);
  const layoutNodes = new Map(nodes.map((node) => [node.id, node]));
  const groups = (prepared.groups ?? []).flatMap((group) => {
    const layoutGroup = groupsById.get(group.id);
    if (!layoutGroup) return [];
    const directChildren = (hierarchy.nodeIdsByContainer.get(group.id) ?? []).flatMap((id) => {
      const child = layoutNodes.get(id);
      return child ? [child] : [];
    });
    const inputs = directChildren.filter(
      (child) => child.kind === "input" || child.kind === "inout",
    );
    const outputs = directChildren.filter(
      (child) => child.kind === "output" || child.kind === "inout",
    );
    const x = inputs.length > 0 ? Math.min(...inputs.map((child) => child.x)) : layoutGroup.x;
    const right =
      outputs.length > 0
        ? Math.max(...outputs.map((child) => child.x + child.width))
        : layoutGroup.x + layoutGroup.width;
    return [{ ...layoutGroup, x, width: Math.max(1, right - x) }];
  });

  return {
    width: result.width ?? 0,
    height: result.height ?? 0,
    groups,
    nodes,
    edges,
    elapsedMs: performance.now() - start,
  };
};
