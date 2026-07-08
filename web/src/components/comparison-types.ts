// SPDX-License-Identifier: Apache-2.0

import type { ComparisonSlice } from "../comparison/types";
import type { SourceOrigin } from "../model/graph";

export type MatchingPolicy = "conservative" | "aggressive";

export type DiffStatus = "unchanged" | "added" | "removed" | "modified";

export type MatchMethod = "exactId" | "named" | "sourceMapped" | "structural" | "heuristic";

export type MatchConfidenceBand = "high" | "medium" | "low";

export interface MatchConfidence {
  score: number;
  band: MatchConfidenceBand;
  evidence: readonly string[];
}

/** Presentation metadata keyed by the ID of an entity in the union GraphSlice. */
export interface EntityDiffPresentation {
  status: DiffStatus;
  matchMethod?: MatchMethod;
  confidence?: MatchConfidence;
  referenceId?: string;
  candidateId?: string;
  sourceHighlighted?: boolean;
}

export interface ComparisonStatusCounts {
  unchanged: number;
  added: number;
  removed: number;
  modified: number;
  heuristic: number;
}

export interface SchematicComparisonPresentation {
  referenceName: string;
  candidateName: string;
  policy: MatchingPolicy;
  onPolicyChange: (policy: MatchingPolicy) => void;
  entities: Readonly<Record<string, EntityDiffPresentation | undefined>>;
  counts?: Partial<ComparisonStatusCounts>;
  /** Side-specific semantic payloads; the union graph remains the sole layout input. */
  comparisonSlice?: ComparisonSlice;
}

export interface HeaderComparisonPresentation {
  referenceName: string;
  candidateName: string;
  policy: MatchingPolicy;
  sourceChanges?: number;
  heuristicMatches?: number;
}

export interface ComparisonSelectionSnapshot {
  id: string;
  label?: string;
  kind?: string;
  definitionName?: string;
  glyph?: string;
  parameters?: Readonly<Record<string, unknown>>;
  ports?: readonly {
    id: string;
    name: string;
    direction: string;
    index?: number;
    role?: string;
    width?: number;
  }[];
  sourceNode?: string;
  sourcePort?: string;
  targetNode?: string;
  targetPort?: string;
  width?: number;
  signalType?: string;
  role?: string;
  origins?: readonly SourceOrigin[];
}

export interface ComparisonSelectionDetails {
  status: DiffStatus;
  policy: MatchingPolicy;
  matchMethod?: MatchMethod;
  confidence?: MatchConfidence;
  reference?: ComparisonSelectionSnapshot;
  candidate?: ComparisonSelectionSnapshot;
}

export const diffStatusLabel = (status: DiffStatus) => {
  switch (status) {
    case "added":
      return "Added in candidate";
    case "removed":
      return "Missing from candidate";
    case "modified":
      return "Modified";
    case "unchanged":
      return "Unchanged";
  }
};

/** Explains schematic status independently from the correspondence method. */
export const schematicDiffStatusDescription = (status: DiffStatus) => {
  switch (status) {
    case "added":
      return "Present only in the candidate, or not safely matched to a reference object.";
    case "removed":
      return "Present only in the reference, or not safely matched to a candidate object.";
    case "modified":
      return "Matched across snapshots, but its semantic payload differs. A connection with different endpoints is shown as removed plus added instead.";
    case "unchanged":
      return "Matched across snapshots with the same compared semantic payload.";
  }
};

export const matchMethodLabel = (method: MatchMethod) => {
  switch (method) {
    case "exactId":
      return "Exact stable ID";
    case "named":
      return "Unique name and interface";
    case "sourceMapped":
      return "Mapped source location";
    case "structural":
      return "Unique graph structure";
    case "heuristic":
      return "Heuristic correspondence";
  }
};
