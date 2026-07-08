// SPDX-License-Identifier: Apache-2.0

import type { SourceInventoryEntry } from "../api/contracts";
import type { WorkspaceProvider } from "../bundle/provider";
import type { GraphEdge, GraphGroup, GraphNode, GraphPort, GraphSlice } from "../model/graph";

export type MatchingPolicy = "conservative" | "aggressive";

export type DiffStatus = "unchanged" | "added" | "removed" | "modified";

export type MatchMethod = "exactId" | "named" | "sourceMapped" | "structural" | "heuristic";

export type MatchConfidenceBand = "high" | "medium" | "low";

export interface MatchConfidence {
  score: number;
  band: MatchConfidenceBand;
  evidence: readonly string[];
}

export interface MatchMetadata {
  method: MatchMethod;
  confidence: MatchConfidence;
}

/**
 * A presentation-only correspondence. The canonical graph values are retained
 * verbatim so callers can inspect both sides without encoding diff state in a
 * `.nettle` bundle.
 */
export interface ComparisonEntity<T> {
  /** Collision-safe ID used by the union graph. */
  id: string;
  status: DiffStatus;
  reference?: T;
  candidate?: T;
  match?: MatchMetadata;
}

export interface ComparisonPort extends ComparisonEntity<GraphPort> {
  nodeId: string;
  referenceNodeId?: string;
  candidateNodeId?: string;
}

export interface SourceLineMapping {
  referencePath: string;
  candidatePath: string;
  /** One-based unchanged-line correspondence. */
  referenceToCandidate: ReadonlyMap<number, number>;
}

export type SourceDiffStatus = DiffStatus | "renamed";

export interface SourceInventoryComparison {
  id: string;
  status: SourceDiffStatus;
  reference?: SourceInventoryEntry;
  candidate?: SourceInventoryEntry;
}

export interface ComparisonSlice {
  reference: GraphSlice;
  candidate: GraphSlice;
  /** The only graph passed to layout; all diff metadata remains alongside it. */
  union: GraphSlice;
  nodes: ComparisonEntity<GraphNode>[];
  ports: ComparisonPort[];
  edges: ComparisonEntity<GraphEdge>[];
  groups: ComparisonEntity<GraphGroup>[];
  policy: MatchingPolicy;
  heuristicMatchCount: number;
}

/** Browser-only state for two decoded snapshots and their visible hierarchy. */
export interface ComparisonWorkspace {
  referenceProvider: WorkspaceProvider;
  candidateProvider: WorkspaceProvider;
  referenceSourceInventory: readonly SourceInventoryEntry[];
  candidateSourceInventory: readonly SourceInventoryEntry[];
  hierarchyState: readonly {
    reference: GraphSlice;
    candidate: GraphSlice;
  }[];
  selectedPolicy: MatchingPolicy;
  compatibilityDiagnostics: readonly string[];
}

export interface CompareGraphOptions {
  policy?: MatchingPolicy;
  sourceLineMappings?: readonly SourceLineMapping[];
  maximumObjects?: number;
  maximumPorts?: number;
  maximumOrigins?: number;
}
