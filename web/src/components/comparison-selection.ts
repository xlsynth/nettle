// SPDX-License-Identifier: Apache-2.0

import type { ComparisonSlice } from "../comparison";
import type { ModuleContext } from "../model/graph";

export type ComparisonSide = "reference" | "candidate";

export interface OriginalComparisonSelection {
  side: ComparisonSide;
  kind: "node" | "edge" | "group";
  id: string;
}

const selectableEntities = (comparison: ComparisonSlice) => [
  ...comparison.nodes.map((entity) => ({ kind: "node" as const, entity })),
  ...comparison.edges.map((entity) => ({ kind: "edge" as const, entity })),
  ...comparison.groups.map((entity) => ({ kind: "group" as const, entity })),
];

export const modulesRequireExplicitPair = (reference: ModuleContext, candidate: ModuleContext) =>
  reference.name !== candidate.name || reference.definitionName !== candidate.definitionName;

export const lowSchematicOverlapWarning = (comparison: ComparisonSlice) => {
  const denominator = Math.max(
    comparison.reference.nodes.length,
    comparison.candidate.nodes.length,
  );
  if (denominator === 0) return undefined;
  const paired = comparison.nodes.filter((entity) => entity.reference && entity.candidate).length;
  const ratio = paired / denominator;
  return ratio < 0.2
    ? `Low schematic overlap (${Math.round(ratio * 100)}% of nodes paired)`
    : undefined;
};

/** Captures a stable, side-qualified identity before the union topology changes. */
export const originalSelectionForOverlay = (
  comparison: ComparisonSlice,
  overlayId: string,
  preferredSide: ComparisonSide = "candidate",
): OriginalComparisonSelection | undefined => {
  const selected = selectableEntities(comparison).find(({ entity }) => entity.id === overlayId);
  if (!selected) return undefined;
  const { entity, kind } = selected;
  const fallbackSide = preferredSide === "candidate" ? "reference" : "candidate";
  const preferred = entity[preferredSide];
  if (preferred) return { side: preferredSide, kind, id: preferred.id };
  const fallback = entity[fallbackSide];
  return fallback ? { side: fallbackSide, kind, id: fallback.id } : undefined;
};

/** Resolves a stable original identity into the current comparison union. */
export const overlaySelectionForOriginal = (
  comparison: ComparisonSlice,
  selection: OriginalComparisonSelection,
) =>
  selectableEntities(comparison).find(
    ({ entity, kind }) => kind === selection.kind && entity[selection.side]?.id === selection.id,
  )?.entity.id;
