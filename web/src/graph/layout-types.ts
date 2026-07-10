// SPDX-License-Identifier: Apache-2.0

import type { GraphEdge, GraphGroup, GraphNode } from "../model/graph";

export type FlattenRenderMode = "grouped" | "flat";

export interface Point {
  x: number;
  y: number;
}

export interface LayoutPort {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: "input" | "output" | "inout";
  index?: number;
  role?: string;
  bitWidth?: number;
}

export interface LayoutNode extends Omit<GraphNode, "ports"> {
  x: number;
  y: number;
  width: number;
  height: number;
  ports: LayoutPort[];
}

export interface EdgeSection {
  startPoint: Point;
  bendPoints: Point[];
  endPoint: Point;
}

export interface LayoutEdge extends GraphEdge {
  sections: EdgeSection[];
}

export interface LayoutGroup extends GraphGroup {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisconnectedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  componentCount: number;
  /** Union entity IDs grouped by disconnected component for visibility-aware captions. */
  componentEntityIds: string[][];
}

export interface LayoutResult {
  width: number;
  height: number;
  groups: LayoutGroup[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  disconnectedRegion?: DisconnectedRegion;
  elapsedMs: number;
}
