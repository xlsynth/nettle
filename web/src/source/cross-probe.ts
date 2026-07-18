// SPDX-License-Identifier: Apache-2.0

import { pathsReferToSameFile } from "../api/normalize";
import type {
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphSlice,
  SourceElaborationRange,
  SourceOrigin,
} from "../model/graph";

export interface SourceSelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface SourceEntity {
  id: string;
  type: "node" | "edge" | "group";
  terms: string[];
  origins?: SourceOrigin[];
  nodeKind?: GraphNode["kind"];
  glyph?: string;
}

const OPERATOR_TOKENS = [
  "<<<",
  ">>>",
  "===",
  "!==",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "~^",
  "^~",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "&",
  "|",
  "~",
  "!",
  "<",
  ">",
];

const normalizedTerms = (values: Array<string | undefined>) =>
  values
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

const nodeEntity = (node: GraphNode): SourceEntity => ({
  id: node.id,
  type: "node",
  nodeKind: node.kind,
  glyph: node.glyph,
  terms: normalizedTerms([
    node.label,
    node.glyph,
    node.definitionName,
    ...node.ports.flatMap((port) => [port.id, port.name]),
  ]),
  origins: node.origins,
});

const edgeEntity = (edge: GraphEdge): SourceEntity => ({
  id: edge.id,
  type: "edge",
  terms: normalizedTerms([edge.label]),
  origins: edge.origins,
});

const groupEntity = (group: GraphGroup): SourceEntity => ({
  id: group.id,
  type: "group",
  terms: normalizedTerms([group.name, group.definitionName]),
  origins: group.origins,
});

const overlapsColumns = (origin: SourceOrigin, selection: SourceSelectionRange) => {
  const originEndLine = origin.endLine ?? origin.startLine;
  const originEndColumn = origin.endColumn ?? origin.startColumn + 1;
  const selectionStartsAfterOrigin =
    selection.startLine > originEndLine ||
    (selection.startLine === originEndLine && selection.startColumn > originEndColumn);
  const selectionEndsBeforeOrigin =
    selection.endLine < origin.startLine ||
    (selection.endLine === origin.startLine && selection.endColumn < origin.startColumn);
  return !selectionStartsAfterOrigin && !selectionEndsBeforeOrigin;
};

const overlapsLines = (origin: SourceOrigin, selection: SourceSelectionRange) =>
  selection.startLine <= (origin.endLine ?? origin.startLine) &&
  selection.endLine >= origin.startLine;

const containsSelection = (range: SourceElaborationRange, selection: SourceSelectionRange) => {
  const startsBeforeSelection =
    range.startLine < selection.startLine ||
    (range.startLine === selection.startLine && range.startColumn <= selection.startColumn);
  const endsAfterSelection =
    range.endLine > selection.endLine ||
    (range.endLine === selection.endLine && range.endColumn >= selection.endColumn);
  return startsBeforeSelection && endsAfterSelection;
};

export const sourceSelectionIsInactive = (
  selection: SourceSelectionRange,
  elaborationRanges: readonly SourceElaborationRange[],
) => elaborationRanges.some((range) => !range.active && containsSelection(range, selection));

const elaborationRangeSize = (range: SourceElaborationRange) =>
  (range.endLine - range.startLine) * 1_000 +
  (range.endLine === range.startLine ? range.endColumn - range.startColumn : 0);

const originSize = (origin: SourceOrigin) => {
  const endLine = origin.endLine ?? origin.startLine;
  const lineSpan = Math.max(0, endLine - origin.startLine);
  const columnSpan =
    lineSpan === 0
      ? Math.max(1, (origin.endColumn ?? origin.startColumn + 1) - origin.startColumn)
      : 0;
  return lineSpan * 1_000 + columnSpan;
};

const sourceTokenAt = (source: string, selection: SourceSelectionRange) => {
  const line = source.split(/\r?\n/)[selection.startLine - 1] ?? "";
  const selected =
    selection.startLine === selection.endLine
      ? line.slice(
          selection.startColumn - 1,
          Math.max(selection.startColumn, selection.endColumn - 1),
        )
      : "";
  const trimmed = selected.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) || OPERATOR_TOKENS.includes(trimmed)) {
    return trimmed.toLowerCase();
  }

  const cursor = Math.min(line.length, Math.max(0, selection.startColumn - 1));
  for (const operator of OPERATOR_TOKENS) {
    const start = Math.max(0, cursor - operator.length + 1);
    const nearby = line.slice(start, cursor + operator.length);
    if (nearby.includes(operator)) return operator.toLowerCase();
  }

  const identifierCharacter = /[A-Za-z0-9_$]/;
  let start = cursor;
  if (
    !identifierCharacter.test(line[start] ?? "") &&
    identifierCharacter.test(line[start - 1] ?? "")
  ) {
    start -= 1;
  }
  if (!identifierCharacter.test(line[start] ?? "")) return undefined;
  let end = start + 1;
  while (start > 0 && identifierCharacter.test(line[start - 1])) start -= 1;
  while (end < line.length && identifierCharacter.test(line[end])) end += 1;
  return line.slice(start, end).toLowerCase();
};

const entityTokenScore = (entity: SourceEntity, token: string | undefined) => {
  if (!token) return 0;
  if (!entity.terms.includes(token)) return 0;
  let score = 650;
  if (entity.type === "node") score += 20;
  if (entity.nodeKind === "input" || entity.nodeKind === "output" || entity.nodeKind === "inout") {
    score += 35;
  }
  if (entity.glyph?.toLowerCase() === token) score += 45;
  return score;
};

/** Selects the most specific graph entity associated with a source click or selection. */
export const entityForSourceSelection = (
  slice: GraphSlice,
  path: string,
  source: string,
  selection: SourceSelectionRange,
  elaborationRanges: readonly SourceElaborationRange[] = [],
): string | undefined => {
  const token = sourceTokenAt(source, selection);
  const entities: SourceEntity[] = [
    ...slice.nodes.map(nodeEntity),
    ...slice.edges.map(edgeEntity),
    ...(slice.groups ?? []).map(groupEntity),
  ];
  if (sourceSelectionIsInactive(selection, elaborationRanges)) {
    return undefined;
  }
  let best: { id: string; score: number; size: number; order: number } | undefined;

  entities.forEach((entity, order) => {
    for (const origin of entity.origins ?? []) {
      if (!pathsReferToSameFile(origin.file, path) || !overlapsLines(origin, selection)) continue;
      const exact = overlapsColumns(origin, selection);
      const size = originSize(origin);
      const entityPriority = entity.type === "node" ? 20 : entity.type === "group" ? 10 : 0;
      const score =
        (exact ? 1_000 : 300) +
        entityPriority +
        entityTokenScore(entity, token) -
        Math.min(180, size / 25);
      if (
        !best ||
        score > best.score ||
        (score === best.score && size < best.size) ||
        (score === best.score && size === best.size && order < best.order)
      ) {
        best = { id: entity.id, score, size, order };
      }
    }
  });

  if (best) return best.id;

  const enclosingRanges = elaborationRanges
    .filter((range) => range.active && containsSelection(range, selection))
    .sort((left, right) => elaborationRangeSize(left) - elaborationRangeSize(right));
  for (const range of enclosingRanges) {
    const rangeSelection = {
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
    };
    let nearest:
      | { id: string; lineDistance: number; columnDistance: number; order: number }
      | undefined;
    entities.forEach((entity, order) => {
      for (const origin of entity.origins ?? []) {
        if (!pathsReferToSameFile(origin.file, path) || !overlapsLines(origin, rangeSelection)) {
          continue;
        }
        const lineDistance = Math.min(
          Math.abs(origin.startLine - selection.startLine),
          Math.abs((origin.endLine ?? origin.startLine) - selection.endLine),
        );
        const columnDistance =
          lineDistance === 0 ? Math.abs(origin.startColumn - selection.startColumn) : 0;
        if (
          !nearest ||
          lineDistance < nearest.lineDistance ||
          (lineDistance === nearest.lineDistance && columnDistance < nearest.columnDistance) ||
          (lineDistance === nearest.lineDistance &&
            columnDistance === nearest.columnDistance &&
            order < nearest.order)
        ) {
          nearest = { id: entity.id, lineDistance, columnDistance, order };
        }
      }
    });
    if (nearest) return nearest.id;
  }
  return undefined;
};
