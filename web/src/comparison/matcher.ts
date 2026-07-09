// SPDX-License-Identifier: Apache-2.0

import { findUniquePathMatch, normalizePath } from "../api/normalize";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type {
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphPort,
  GraphSlice,
  JsonValue,
  ModuleContext,
  SourceOrigin,
} from "../model/graph";
import type {
  CompareGraphOptions,
  ComparisonEntity,
  ComparisonPort,
  ComparisonSlice,
  MatchConfidence,
  MatchMetadata,
  MatchMethod,
  SourceLineMapping,
} from "./types";

export const MAX_COMPARISON_OBJECTS = RESOURCE_LIMITS.bundle.protobuf.graphObjects;
export const MAX_COMPARISON_PORTS = RESOURCE_LIMITS.bundle.protobuf.ports;
export const MAX_COMPARISON_ORIGINS = RESOURCE_LIMITS.bundle.protobuf.origins;

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const asciiLowerCase = (value: string) =>
  value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + ("a".charCodeAt(0) - "A".charCodeAt(0))),
  );

interface NodeMatch {
  reference: GraphNode;
  candidate: GraphNode;
  match: MatchMetadata;
}

interface ScoredPair {
  reference: GraphNode;
  candidate: GraphNode;
  score: number;
  evidence: string[];
}

interface IdentifiedScoredPair {
  reference: { id: string };
  candidate: { id: string };
  score: number;
}

/**
 * @internal Deterministic one-to-one assignment among pairs that are a maximum
 * score for both endpoints. Exported so equal-score batching can be tested.
 */
export const selectMutualMaximumPairs = <T extends IdentifiedScoredPair>(
  pairs: readonly T[],
  minimumScore = 0.65,
): T[] => {
  const maximumByReference = new Map<string, number>();
  const maximumByCandidate = new Map<string, number>();
  for (const pair of pairs) {
    maximumByReference.set(
      pair.reference.id,
      Math.max(maximumByReference.get(pair.reference.id) ?? -Infinity, pair.score),
    );
    maximumByCandidate.set(
      pair.candidate.id,
      Math.max(maximumByCandidate.get(pair.candidate.id) ?? -Infinity, pair.score),
    );
  }
  const eligible = pairs
    .filter(
      (pair) =>
        pair.score >= minimumScore &&
        pair.score === maximumByReference.get(pair.reference.id) &&
        pair.score === maximumByCandidate.get(pair.candidate.id),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodeUnits(left.reference.id, right.reference.id) ||
        compareCodeUnits(left.candidate.id, right.candidate.id),
    );
  const assignedReferences = new Set<string>();
  const assignedCandidates = new Set<string>();
  const result: T[] = [];
  for (const pair of eligible) {
    if (assignedReferences.has(pair.reference.id) || assignedCandidates.has(pair.candidate.id)) {
      continue;
    }
    assignedReferences.add(pair.reference.id);
    assignedCandidates.add(pair.candidate.id);
    result.push(pair);
  }
  return result;
};

const overlayId = (
  kind: "module" | "node" | "port" | "edge" | "group" | "file",
  referenceId?: string,
  candidateId?: string,
) =>
  `cmp:${kind}:${encodeURIComponent(JSON.stringify([referenceId ?? null, candidateId ?? null]))}`;

/** @internal Exported so confidence boundary semantics remain regression tested. */
export const confidenceBandForScore = (score: number): MatchConfidence["band"] =>
  score >= 0.85 ? "high" : score >= 0.75 ? "medium" : "low";

const confidence = (score: number, evidence: readonly string[]): MatchConfidence => ({
  score,
  band: confidenceBandForScore(score),
  evidence,
});

const metadata = (
  method: MatchMethod,
  score: number,
  evidence: readonly string[],
): MatchMetadata => ({ method, confidence: confidence(score, evidence) });

const methodMetadata: Record<Exclude<MatchMethod, "heuristic">, MatchMetadata> = {
  exactId: metadata("exactId", 1, ["stable ID"]),
  named: metadata("named", 0.98, ["unique name and interface"]),
  sourceMapped: metadata("sourceMapped", 0.95, ["unique mapped source location"]),
  structural: metadata("structural", 0.9, ["unique matched-neighborhood structure"]),
};

export const MAX_DERIVED_MATCH_EVIDENCE_ITEMS = 5;
export const MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS = 160;

const boundedEvidenceText = (value: string) =>
  value.length <= MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS
    ? value
    : `${value.slice(0, MAX_DERIVED_MATCH_EVIDENCE_CHARACTERS - 1)}…`;

export const withHeuristicDependencies = (
  localMatch: MatchMetadata,
  dependencies: readonly (MatchMetadata | undefined)[],
  subject: string,
) => {
  const heuristicDependencies = new Set<MatchMetadata>();
  for (const dependency of dependencies) {
    if (dependency?.method === "heuristic") heuristicDependencies.add(dependency);
  }
  if (heuristicDependencies.size === 0) return localMatch;
  let score = localMatch.confidence.score;
  let weakestDependency: MatchMetadata | undefined;
  for (const dependency of heuristicDependencies) {
    score = Math.min(score, dependency.confidence.score);
    if (!weakestDependency || dependency.confidence.score < weakestDependency.confidence.score) {
      weakestDependency = dependency;
    }
  }
  const weakestEvidence = weakestDependency?.confidence.evidence[0];
  return metadata("heuristic", score, [
    `${subject} depends on heuristic node correspondence`,
    `heuristic dependency count ${heuristicDependencies.size}`,
    `local match ${localMatch.method} (${localMatch.confidence.score.toFixed(2)})`,
    `weakest heuristic dependency ${weakestDependency?.confidence.score.toFixed(2)} (${weakestDependency?.confidence.band})`,
    ...(weakestEvidence ? [boundedEvidenceText(`weakest evidence: ${weakestEvidence}`)] : []),
  ]);
};

/** Counts visibly selectable schematic correspondences inferred heuristically. */
export const countHeuristicMatches = (
  comparison: Pick<ComparisonSlice, "nodes" | "edges" | "groups">,
) =>
  [...comparison.nodes, ...comparison.edges, ...comparison.groups].filter(
    (entity) => entity.match?.method === "heuristic",
  ).length;

const sortedById = <T extends { id: string }>(values: Iterable<T>) =>
  [...values].sort((left, right) => compareCodeUnits(left.id, right.id));

const uniqueById = <T extends { id: string }>(values: readonly T[], description: string) => {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`${description} contains duplicate ID ${value.id}`);
    result.set(value.id, value);
  }
  return result;
};

const stableJsonValue = (value: JsonValue | undefined): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`)
    .join(",")}}`;
};

const tupleKey = (...values: JsonValue[]) => stableJsonValue(values);
const tupleArrayKey = (values: readonly JsonValue[]) => stableJsonValue([...values]);

const parametersEqual = (
  left: Record<string, JsonValue> | undefined,
  right: Record<string, JsonValue> | undefined,
) => stableJsonValue(left ?? {}) === stableJsonValue(right ?? {});

/**
 * Compares only the user-visible semantic payload of a module context.
 * Snapshot-local identity and hierarchy placement are deliberately excluded.
 */
export const modulePayloadEqual = (reference: ModuleContext, candidate: ModuleContext) =>
  reference.name === candidate.name &&
  reference.definitionName === candidate.definitionName &&
  parametersEqual(reference.parameters, candidate.parameters);

const portStructuralToken = (port: GraphPort | undefined) =>
  port ? tupleKey(port.direction, port.role ?? null, port.index ?? null) : tupleKey(null);

const portSignatureCache = new WeakMap<GraphNode, string>();

const portSignature = (node: GraphNode) => {
  const cached = portSignatureCache.get(node);
  if (cached !== undefined) return cached;
  const signature = tupleArrayKey(node.ports.map(portStructuralToken).sort());
  portSignatureCache.set(node, signature);
  return signature;
};

const structuralNodeSignature = (node: GraphNode) =>
  tupleKey(node.kind, node.glyph ?? null, portSignature(node));

const nodeCompatible = (reference: GraphNode, candidate: GraphNode) =>
  reference.kind === candidate.kind;

const exactIdCompatible = (reference: GraphNode, candidate: GraphNode) => {
  if (!nodeCompatible(reference, candidate)) return false;
  // Older Yosys-derived IDs can survive a refactor while naming a different
  // operator at the same legacy source position. Treat the ID as an exact
  // anchor only within one operator glyph class; source and aggressive stages
  // can still recover a visibly qualified correspondence across glyph changes.
  if (reference.kind !== "operator") return true;
  return (reference.glyph ?? reference.label) === (candidate.glyph ?? candidate.label);
};

const nodeNamedKey = (node: GraphNode) => {
  if (node.kind === "module") {
    return tupleKey("module", node.label, node.definitionName ?? null, portSignature(node));
  }
  if (node.kind === "input" || node.kind === "output" || node.kind === "inout") {
    return tupleKey(node.kind, node.label, portSignature(node));
  }
  return undefined;
};

const pushIndex = <T>(index: Map<string, T[]>, key: string, value: T) => {
  const entries = index.get(key) ?? [];
  entries.push(value);
  index.set(key, entries);
};

const matchUniqueKeys = (
  unmatchedReference: Map<string, GraphNode>,
  unmatchedCandidate: Map<string, GraphNode>,
  referenceKeys: (node: GraphNode) => readonly string[],
  candidateKeys: (node: GraphNode) => readonly string[],
  match: MatchMetadata,
): NodeMatch[] => {
  const referenceIndex = new Map<string, GraphNode[]>();
  const candidateIndex = new Map<string, GraphNode[]>();
  for (const node of unmatchedReference.values()) {
    for (const key of new Set(referenceKeys(node))) pushIndex(referenceIndex, key, node);
  }
  for (const node of unmatchedCandidate.values()) {
    for (const key of new Set(candidateKeys(node))) pushIndex(candidateIndex, key, node);
  }
  const referenceCandidates = new Map<string, Set<string>>();
  const candidateReferences = new Map<string, Set<string>>();
  for (const key of [...referenceIndex.keys()].sort()) {
    const references = referenceIndex.get(key) ?? [];
    const candidates = candidateIndex.get(key) ?? [];
    if (references.length !== 1 || candidates.length !== 1) continue;
    const reference = references[0];
    const candidate = candidates[0];
    if (!nodeCompatible(reference, candidate)) continue;
    const candidateIds = referenceCandidates.get(reference.id) ?? new Set();
    candidateIds.add(candidate.id);
    referenceCandidates.set(reference.id, candidateIds);
    const referenceIds = candidateReferences.get(candidate.id) ?? new Set();
    referenceIds.add(reference.id);
    candidateReferences.set(candidate.id, referenceIds);
  }
  const accepted: NodeMatch[] = [];
  for (const reference of sortedById(unmatchedReference.values())) {
    const candidateIds = referenceCandidates.get(reference.id);
    if (candidateIds?.size !== 1) continue;
    const candidateId = [...candidateIds][0];
    if (candidateReferences.get(candidateId)?.size !== 1) continue;
    const candidate = unmatchedCandidate.get(candidateId);
    if (!candidate) continue;
    accepted.push({ reference, candidate, match });
  }
  for (const pair of accepted) {
    unmatchedReference.delete(pair.reference.id);
    unmatchedCandidate.delete(pair.candidate.id);
  }
  return accepted;
};

const sourceMappingForReferenceOrigin = (
  origin: SourceOrigin,
  mappings: readonly SourceLineMapping[],
) => {
  const mapping = findUniquePathMatch(mappings, origin.file, (entry) => entry.referencePath);
  if (!mapping) return undefined;
  const line = mapping.referenceToCandidate.get(origin.startLine);
  return line === undefined ? undefined : { path: normalizePath(mapping.candidatePath), line };
};

const sourceMappingForCandidateOrigin = (
  origin: SourceOrigin,
  mappings: readonly SourceLineMapping[],
) => {
  const mapping = findUniquePathMatch(mappings, origin.file, (entry) => entry.candidatePath);
  return mapping && mapping.referenceToCandidate.size > 0
    ? { path: normalizePath(mapping.candidatePath), line: origin.startLine }
    : undefined;
};

const sortedLineMappingCache = new WeakMap<
  ReadonlyMap<number, number>,
  readonly (readonly [number, number])[]
>();

const nearestLineMapping = (
  mapping: ReadonlyMap<number, number>,
  referenceLine: number,
): readonly [number, number] | undefined => {
  let entries = sortedLineMappingCache.get(mapping);
  if (!entries) {
    entries = [...mapping].sort(([left], [right]) => left - right);
    sortedLineMappingCache.set(mapping, entries);
  }
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle][0] < referenceLine) low = middle + 1;
    else high = middle;
  }
  const after = entries[low];
  const before = low > 0 ? entries[low - 1] : undefined;
  if (!before) return after;
  if (!after) return before;
  return referenceLine - before[0] <= after[0] - referenceLine ? before : after;
};

const sourceKeys = (
  node: GraphNode,
  mappings: readonly SourceLineMapping[],
  side: "reference" | "candidate",
) =>
  (node.origins ?? []).flatMap((origin) => {
    const mapped =
      side === "reference"
        ? sourceMappingForReferenceOrigin(origin, mappings)
        : sourceMappingForCandidateOrigin(origin, mappings);
    return mapped ? [tupleKey(node.kind, portSignature(node), mapped.path, mapped.line)] : [];
  });

interface Neighborhood {
  edgesByNode: ReadonlyMap<string, GraphEdge[]>;
  portsByNode: ReadonlyMap<string, ReadonlyMap<string, GraphPort>>;
  neighborsByNode: ReadonlyMap<string, Set<string>>;
}

const neighborhood = (slice: GraphSlice): Neighborhood => {
  const edgesByNode = new Map<string, GraphEdge[]>();
  const neighborsByNode = new Map<string, Set<string>>();
  const portsByNode = new Map(
    slice.nodes.map(
      (node) => [node.id, new Map(node.ports.map((port) => [port.id, port]))] as const,
    ),
  );
  for (const edge of slice.edges) {
    for (const id of [edge.sourceNode, edge.targetNode]) {
      const edges = edgesByNode.get(id) ?? [];
      edges.push(edge);
      edgesByNode.set(id, edges);
    }
    const sourceNeighbors = neighborsByNode.get(edge.sourceNode) ?? new Set();
    sourceNeighbors.add(edge.targetNode);
    neighborsByNode.set(edge.sourceNode, sourceNeighbors);
    const targetNeighbors = neighborsByNode.get(edge.targetNode) ?? new Set();
    targetNeighbors.add(edge.sourceNode);
    neighborsByNode.set(edge.targetNode, targetNeighbors);
  }
  return { edgesByNode, portsByNode, neighborsByNode };
};

const matchedNeighborTokens = (
  node: GraphNode,
  graph: Neighborhood,
  translateNeighbor: (id: string) => string | undefined,
) => {
  const tokens: string[] = [];
  for (const edge of new Set(graph.edgesByNode.get(node.id) ?? [])) {
    const directions = [
      ...(edge.sourceNode === node.id ? [true] : []),
      ...(edge.targetNode === node.id ? [false] : []),
    ];
    for (const outgoing of directions) {
      const neighbor = translateNeighbor(outgoing ? edge.targetNode : edge.sourceNode);
      if (!neighbor) continue;
      const localPortId = outgoing ? edge.sourcePort : edge.targetPort;
      const neighborPortId = outgoing ? edge.targetPort : edge.sourcePort;
      const localPort = localPortId ? graph.portsByNode.get(node.id)?.get(localPortId) : undefined;
      const neighborNodeId = outgoing ? edge.targetNode : edge.sourceNode;
      const neighborPort = neighborPortId
        ? graph.portsByNode.get(neighborNodeId)?.get(neighborPortId)
        : undefined;
      tokens.push(
        tupleKey(
          outgoing ? "out" : "in",
          neighbor,
          portStructuralToken(localPort),
          portStructuralToken(neighborPort),
        ),
      );
    }
  }
  return tokens.sort();
};

const structuralMatchKey = (
  node: GraphNode,
  graph: Neighborhood,
  translateNeighbor: (id: string) => string | undefined,
) => {
  const tokens = matchedNeighborTokens(node, graph, translateNeighbor);
  return tokens.length > 0 ? tupleArrayKey([structuralNodeSignature(node), ...tokens]) : undefined;
};

interface StructuralMatchIndex {
  keyByNode: Map<string, string>;
  nodesByKey: Map<string, Map<string, GraphNode>>;
}

const newStructuralMatchIndex = (): StructuralMatchIndex => ({
  keyByNode: new Map(),
  nodesByKey: new Map(),
});

const updateStructuralMatchIndex = (
  index: StructuralMatchIndex,
  node: GraphNode,
  key: string | undefined,
  affectedKeys: Set<string>,
) => {
  const previousKey = index.keyByNode.get(node.id);
  if (previousKey === key) return;
  if (previousKey !== undefined) {
    const previousBucket = index.nodesByKey.get(previousKey);
    previousBucket?.delete(node.id);
    if (previousBucket?.size === 0) index.nodesByKey.delete(previousKey);
    index.keyByNode.delete(node.id);
    affectedKeys.add(previousKey);
  }
  if (key !== undefined) {
    const bucket = index.nodesByKey.get(key) ?? new Map<string, GraphNode>();
    bucket.set(node.id, node);
    index.nodesByKey.set(key, bucket);
    index.keyByNode.set(node.id, key);
    affectedKeys.add(key);
  }
};

const removeFromStructuralMatchIndex = (
  index: StructuralMatchIndex,
  node: GraphNode,
  affectedKeys: Set<string>,
) => updateStructuralMatchIndex(index, node, undefined, affectedKeys);

/**
 * Propagates deterministic structural anchors through the graph without
 * rescanning every unmatched node after each batch. A node's structural key
 * can change only when one of its neighbors becomes matched, while a key's
 * uniqueness can change only when a member moves or is removed. Tracking those
 * two frontiers preserves the unique-in-both-directions rule used by the
 * original fixed-point scan.
 */
const incrementalStructuralMatches = (
  unmatchedReference: Map<string, GraphNode>,
  unmatchedCandidate: Map<string, GraphNode>,
  referenceGraph: Neighborhood,
  candidateGraph: Neighborhood,
  matchedReferenceToCandidate: Map<string, string>,
) => {
  const accepted: NodeMatch[] = [];
  const referenceIndex = newStructuralMatchIndex();
  const candidateIndex = newStructuralMatchIndex();
  const matchedCandidateIds = new Set(matchedReferenceToCandidate.values());
  let affectedKeys = new Set<string>();
  for (const node of sortedById(unmatchedReference.values())) {
    updateStructuralMatchIndex(
      referenceIndex,
      node,
      structuralMatchKey(node, referenceGraph, (id) => matchedReferenceToCandidate.get(id)),
      affectedKeys,
    );
  }
  for (const node of sortedById(unmatchedCandidate.values())) {
    updateStructuralMatchIndex(
      candidateIndex,
      node,
      structuralMatchKey(node, candidateGraph, (id) =>
        matchedCandidateIds.has(id) ? id : undefined,
      ),
      affectedKeys,
    );
  }

  while (affectedKeys.size > 0) {
    const batch: NodeMatch[] = [];
    for (const key of [...affectedKeys].sort(compareCodeUnits)) {
      const references = referenceIndex.nodesByKey.get(key);
      const candidates = candidateIndex.nodesByKey.get(key);
      if (references?.size !== 1 || candidates?.size !== 1) continue;
      const reference = references.values().next().value as GraphNode;
      const candidate = candidates.values().next().value as GraphNode;
      if (!nodeCompatible(reference, candidate)) continue;
      batch.push({ reference, candidate, match: methodMetadata.structural });
    }
    if (batch.length === 0) break;

    const nextAffectedKeys = new Set<string>();
    const referenceFrontier = new Map<string, GraphNode>();
    const candidateFrontier = new Map<string, GraphNode>();
    for (const pair of batch.sort((left, right) =>
      compareCodeUnits(left.reference.id, right.reference.id),
    )) {
      unmatchedReference.delete(pair.reference.id);
      unmatchedCandidate.delete(pair.candidate.id);
      removeFromStructuralMatchIndex(referenceIndex, pair.reference, nextAffectedKeys);
      removeFromStructuralMatchIndex(candidateIndex, pair.candidate, nextAffectedKeys);
      matchedReferenceToCandidate.set(pair.reference.id, pair.candidate.id);
      matchedCandidateIds.add(pair.candidate.id);
      accepted.push(pair);
      for (const neighborId of referenceGraph.neighborsByNode.get(pair.reference.id) ?? []) {
        const neighbor = unmatchedReference.get(neighborId);
        if (neighbor) referenceFrontier.set(neighbor.id, neighbor);
      }
      for (const neighborId of candidateGraph.neighborsByNode.get(pair.candidate.id) ?? []) {
        const neighbor = unmatchedCandidate.get(neighborId);
        if (neighbor) candidateFrontier.set(neighbor.id, neighbor);
      }
    }
    for (const node of sortedById(referenceFrontier.values())) {
      if (!unmatchedReference.has(node.id)) continue;
      updateStructuralMatchIndex(
        referenceIndex,
        node,
        structuralMatchKey(node, referenceGraph, (id) => matchedReferenceToCandidate.get(id)),
        nextAffectedKeys,
      );
    }
    for (const node of sortedById(candidateFrontier.values())) {
      if (!unmatchedCandidate.has(node.id)) continue;
      updateStructuralMatchIndex(
        candidateIndex,
        node,
        structuralMatchKey(node, candidateGraph, (id) =>
          matchedCandidateIds.has(id) ? id : undefined,
        ),
        nextAffectedKeys,
      );
    }
    affectedKeys = nextAffectedKeys;
  }
  return accepted;
};

const fanInOutTokens = (node: GraphNode, graph: Neighborhood) => {
  const tokens: string[] = [];
  for (const edge of new Set(graph.edgesByNode.get(node.id) ?? [])) {
    if (edge.sourceNode === node.id) {
      const port = edge.sourcePort
        ? graph.portsByNode.get(node.id)?.get(edge.sourcePort)
        : undefined;
      tokens.push(tupleKey("out", portStructuralToken(port)));
    }
    if (edge.targetNode === node.id) {
      const port = edge.targetPort
        ? graph.portsByNode.get(node.id)?.get(edge.targetPort)
        : undefined;
      tokens.push(tupleKey("in", portStructuralToken(port)));
    }
  }
  return tokens.sort();
};

const stringSimilarity = (left: string | undefined, right: string | undefined) => {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const normalize = (value: string) => asciiLowerCase(value).replace(/[^a-z0-9_$]+/g, "");
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) return 0;
  const bigrams = (value: string) => {
    const result = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      result.set(pair, (result.get(pair) ?? 0) + 1);
    }
    return result;
  };
  const aPairs = bigrams(a);
  const bPairs = bigrams(b);
  let intersection = 0;
  for (const [pair, count] of aPairs) intersection += Math.min(count, bPairs.get(pair) ?? 0);
  return (2 * intersection) / (a.length - 1 + b.length - 1);
};

const multisetSimilarity = (left: readonly string[], right: readonly string[]) => {
  if (left.length === 0 && right.length === 0) return 1;
  const counts = (values: readonly string[]) => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const leftCounts = counts(left);
  const rightCounts = counts(right);
  let intersection = 0;
  let union = 0;
  for (const key of new Set([...leftCounts.keys(), ...rightCounts.keys()])) {
    intersection += Math.min(leftCounts.get(key) ?? 0, rightCounts.get(key) ?? 0);
    union += Math.max(leftCounts.get(key) ?? 0, rightCounts.get(key) ?? 0);
  }
  return union === 0 ? 1 : intersection / union;
};

const semanticScore = (reference: GraphNode, candidate: GraphNode) =>
  0.25 +
  0.35 * stringSimilarity(reference.label, candidate.label) +
  0.2 * stringSimilarity(reference.glyph, candidate.glyph) +
  0.2 * stringSimilarity(reference.definitionName, candidate.definitionName);

// Direction and role describe interface compatibility; an operand index is a
// refinement rather than a hard class boundary. This lets an ordered operator
// become a commutative one without making their otherwise identical ports look
// unrelated, while still rewarding exact operand correspondence.
const portScore = (reference: GraphNode, candidate: GraphNode) =>
  0.75 *
    multisetSimilarity(
      reference.ports.map((port) => tupleKey(port.direction, port.role ?? null)),
      candidate.ports.map((port) => tupleKey(port.direction, port.role ?? null)),
    ) +
  0.25 *
    multisetSimilarity(
      reference.ports.map(portStructuralToken),
      candidate.ports.map(portStructuralToken),
    );

const sourceTargets = (
  node: GraphNode,
  mappings: readonly SourceLineMapping[],
  side: "reference" | "candidate",
) =>
  (node.origins ?? []).flatMap((origin) => {
    if (side === "candidate") {
      const mapping = findUniquePathMatch(mappings, origin.file, (entry) => entry.candidatePath);
      return mapping && (mapping.referenceToCandidate.size > 0 || mapping.pathPaired)
        ? [{ path: normalizePath(mapping.candidatePath), line: origin.startLine }]
        : [];
    }
    const mapping = findUniquePathMatch(mappings, origin.file, (entry) => entry.referencePath);
    if (!mapping) return [];
    const exactLine = mapping.referenceToCandidate.get(origin.startLine);
    if (exactLine !== undefined) {
      return [{ path: normalizePath(mapping.candidatePath), line: exactLine }];
    }
    const nearest = nearestLineMapping(mapping.referenceToCandidate, origin.startLine);
    // An empty map still carries deterministic inventory-level file pairing.
    // Preserve that as approximate evidence only for aggressive matching.
    if (!nearest && mapping.pathPaired) {
      return [{ path: normalizePath(mapping.candidatePath), line: origin.startLine }];
    }
    if (!nearest) return [];
    const line = Math.max(1, nearest[1] + origin.startLine - nearest[0]);
    return [{ path: normalizePath(mapping.candidatePath), line }];
  });

const sourceScore = (
  reference: GraphNode,
  candidate: GraphNode,
  mappings: readonly SourceLineMapping[],
) => {
  let best = 0;
  for (const left of sourceTargets(reference, mappings, "reference")) {
    for (const right of sourceTargets(candidate, mappings, "candidate")) {
      if (left.path !== right.path) continue;
      best = Math.max(best, 1 / (1 + Math.abs(left.line - right.line) / 20));
    }
  }
  return best;
};

const widthAndParameterScore = (reference: GraphNode, candidate: GraphNode) => {
  const parameterScore = parametersEqual(reference.parameters, candidate.parameters) ? 1 : 0;
  const widths = (node: GraphNode) => node.ports.map((port) => `${port.width ?? ""}`).sort();
  return (parameterScore + multisetSimilarity(widths(reference), widths(candidate))) / 2;
};

const semanticKeys = (node: GraphNode) =>
  [
    node.label ? tupleKey("label", asciiLowerCase(node.label)) : undefined,
    node.glyph ? tupleKey("glyph", node.glyph) : undefined,
    node.definitionName ? tupleKey("definition", node.definitionName) : undefined,
  ].filter((value): value is string => value !== undefined);

interface SourceLineBucket<T extends { id: string }> {
  line: number;
  candidates: readonly T[];
}

interface BoundedCandidateStratum {
  candidates: GraphNode[];
  population: number;
  sorted: boolean;
}

interface BoundedCandidateBucket {
  fallback: BoundedCandidateStratum;
  byPortSignature: Map<string, BoundedCandidateStratum>;
  byPortToken: Map<string, BoundedCandidateStratum>;
  byPortCount: Map<string, BoundedCandidateStratum>;
  bySemanticKey: Map<string, BoundedCandidateStratum>;
}

const AGGRESSIVE_SOURCE_POOL_MULTIPLIER = 2;
const AGGRESSIVE_SEMANTIC_POOL_MULTIPLIER = 4;
const AGGRESSIVE_NEIGHBOR_POOL_MULTIPLIER = 2;

const candidateIndexKeyCache = new WeakMap<GraphNode, string>();

const candidateIndexKey = (candidate: GraphNode) => {
  const cached = candidateIndexKeyCache.get(candidate);
  if (cached !== undefined) return cached;
  const key = JSON.stringify([
    structuralNodeSignature(candidate),
    semanticKeys(candidate).sort(),
    candidate.ports.map((port) => port.width ?? null).sort(),
    stableJsonValue(candidate.parameters ?? {}),
    candidate.id,
  ]);
  candidateIndexKeyCache.set(candidate, key);
  return key;
};

const newBoundedCandidateStratum = (): BoundedCandidateStratum => ({
  candidates: [],
  population: 0,
  sorted: true,
});

const addToBoundedCandidateStratum = (stratum: BoundedCandidateStratum, candidate: GraphNode) => {
  stratum.population += 1;
  stratum.candidates.push(candidate);
  stratum.sorted = false;
};

const addToBoundedCandidateMap = (
  index: Map<string, BoundedCandidateStratum>,
  key: string,
  candidate: GraphNode,
) => {
  const stratum = index.get(key) ?? newBoundedCandidateStratum();
  addToBoundedCandidateStratum(stratum, candidate);
  index.set(key, stratum);
};

const addToBoundedCandidateBucket = (bucket: BoundedCandidateBucket, candidate: GraphNode) => {
  addToBoundedCandidateStratum(bucket.fallback, candidate);
  addToBoundedCandidateMap(bucket.byPortSignature, portSignature(candidate), candidate);
  addToBoundedCandidateMap(bucket.byPortCount, String(candidate.ports.length), candidate);
  for (const token of new Set(candidate.ports.map(portStructuralToken))) {
    addToBoundedCandidateMap(bucket.byPortToken, token, candidate);
  }
  for (const key of semanticKeys(candidate)) {
    addToBoundedCandidateMap(bucket.bySemanticKey, key, candidate);
  }
};

const newBoundedCandidateBucket = (): BoundedCandidateBucket => ({
  fallback: newBoundedCandidateStratum(),
  byPortSignature: new Map(),
  byPortToken: new Map(),
  byPortCount: new Map(),
  bySemanticKey: new Map(),
});

/**
 * Yields deterministic bounded strata in decreasing query specificity. Rare
 * shared port tokens are visited before common ones, which keeps a strong
 * late-ID, non-exact-port candidate visible without scanning its entire
 * semantic or neighbor bucket. Inverted lists retain every candidate once per
 * feature (linear in indexed node/port features), but each reference reads at
 * most one deterministic K-sized page from a stratum and callers additionally
 * cap total inspection. Reference ordinals rotate pages so a large tied bucket
 * does not require K-at-a-time global rescoring. This is still an
 * approximation: it finds the exact top K among inspected pages, but a node
 * which shares only common features on a different page may remain outside the
 * current sample until removals expose it.
 */
function* candidatesFromBoundedBucket(
  bucket: BoundedCandidateBucket | undefined,
  reference: GraphNode,
  referenceOrdinal: number,
): Generator<GraphNode> {
  if (!bucket) return;
  const strata: Array<readonly [string, BoundedCandidateStratum]> = [];
  const exactPorts = bucket.byPortSignature.get(portSignature(reference));
  if (exactPorts) strata.push(["0:exact-ports", exactPorts]);
  const portTokens = [...new Set(reference.ports.map(portStructuralToken))]
    .map((key) => [key, bucket.byPortToken.get(key)] as const)
    .filter((entry): entry is readonly [string, BoundedCandidateStratum] => Boolean(entry[1]))
    .sort(
      (left, right) =>
        left[1].population - right[1].population || compareCodeUnits(left[0], right[0]),
    );
  for (const [key, stratum] of portTokens) strata.push([`1:port:${key}`, stratum]);
  const samePortCount = bucket.byPortCount.get(String(reference.ports.length));
  if (samePortCount) strata.push(["2:port-count", samePortCount]);
  const semantic = semanticKeys(reference)
    .map((key) => [key, bucket.bySemanticKey.get(key)] as const)
    .filter((entry): entry is readonly [string, BoundedCandidateStratum] => Boolean(entry[1]))
    .sort(
      (left, right) =>
        left[1].population - right[1].population || compareCodeUnits(left[0], right[0]),
    );
  for (const [key, stratum] of semantic) strata.push([`3:semantic:${key}`, stratum]);
  strata.push(["4:fallback", bucket.fallback]);

  const seenStrata = new Set<BoundedCandidateStratum>();
  const seenCandidates = new Set<string>();
  for (const [, stratum] of strata) {
    if (seenStrata.has(stratum)) continue;
    seenStrata.add(stratum);
    if (!stratum.sorted) {
      stratum.candidates.sort(
        (left, right) =>
          compareCodeUnits(candidateIndexKey(left), candidateIndexKey(right)) ||
          compareCodeUnits(left.id, right.id),
      );
      stratum.sorted = true;
    }
    const count = Math.min(
      RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode,
      stratum.candidates.length,
    );
    const start =
      stratum.candidates.length === 0
        ? 0
        : (referenceOrdinal * RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode) %
          stratum.candidates.length;
    for (let offset = 0; offset < count; offset += 1) {
      const candidate = stratum.candidates[(start + offset) % stratum.candidates.length];
      if (seenCandidates.has(candidate.id)) continue;
      seenCandidates.add(candidate.id);
      yield candidate;
    }
  }
}

/**
 * @internal Selects from a line-sorted source index without inspecting every
 * candidate. Buckets and their candidate arrays must already be sorted.
 */
export const nearestCandidatesByLine = <T extends { id: string }>(
  buckets: readonly SourceLineBucket<T>[],
  target: number,
) => {
  const maximum = RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode;
  let low = 0;
  let high = buckets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (buckets[middle].line < target) low = middle + 1;
    else high = middle;
  }
  let before = low - 1;
  let after = low;
  const result: T[] = [];
  const selected = new Set<string>();
  const append = (candidates: readonly T[]) => {
    for (const candidate of candidates) {
      if (selected.has(candidate.id)) continue;
      selected.add(candidate.id);
      result.push(candidate);
      if (result.length === maximum) break;
    }
  };
  const appendMerged = (left: readonly T[], right: readonly T[]) => {
    let leftIndex = 0;
    let rightIndex = 0;
    while (result.length < maximum && (leftIndex < left.length || rightIndex < right.length)) {
      const leftValue = left[leftIndex];
      const rightValue = right[rightIndex];
      if (!rightValue || (leftValue && compareCodeUnits(leftValue.id, rightValue.id) <= 0)) {
        append(leftValue ? [leftValue] : []);
        leftIndex += 1;
        if (rightValue?.id === leftValue?.id) rightIndex += 1;
      } else {
        append([rightValue]);
        rightIndex += 1;
      }
    }
  };
  while (result.length < maximum && (before >= 0 || after < buckets.length)) {
    const beforeBucket = before >= 0 ? buckets[before] : undefined;
    const afterBucket = after < buckets.length ? buckets[after] : undefined;
    const beforeDistance = beforeBucket ? target - beforeBucket.line : Infinity;
    const afterDistance = afterBucket ? afterBucket.line - target : Infinity;
    if (beforeDistance < afterDistance) {
      append(beforeBucket?.candidates ?? []);
      before -= 1;
    } else if (afterDistance < beforeDistance) {
      append(afterBucket?.candidates ?? []);
      after += 1;
    } else {
      appendMerged(beforeBucket?.candidates ?? [], afterBucket?.candidates ?? []);
      before -= 1;
      after += 1;
    }
  }
  return result;
};

const buildSourceLineIndex = (
  candidates: Iterable<GraphNode>,
  mappings: readonly SourceLineMapping[],
) => {
  const bucketsByKey = new Map<string, Map<number, Map<string, GraphNode>>>();
  for (const candidate of sortedById(candidates)) {
    for (const origin of sourceTargets(candidate, mappings, "candidate")) {
      const key = tupleKey(candidate.kind, origin.path);
      const byLine = bucketsByKey.get(key) ?? new Map<number, Map<string, GraphNode>>();
      const values = byLine.get(origin.line) ?? new Map<string, GraphNode>();
      values.set(candidate.id, candidate);
      byLine.set(origin.line, values);
      bucketsByKey.set(key, byLine);
    }
  }
  return new Map(
    [...bucketsByKey].map(([key, byLine]) => [
      key,
      [...byLine]
        .sort(([left], [right]) => left - right)
        .map(([line, values]) => ({ line, candidates: sortedById(values.values()) })),
    ]),
  );
};

const sharedNeighborKey = (anchorId: string, kind: GraphNode["kind"]) =>
  JSON.stringify([anchorId, kind]);

const MAX_SHARED_NEIGHBOR_RELATIONSHIPS = RESOURCE_LIMITS.bundle.protobuf.edges;
const MAX_SHARED_NEIGHBOR_INDEX_ENTRIES = MAX_SHARED_NEIGHBOR_RELATIONSHIPS * 2;

interface SharedNeighborIndex {
  candidatesByAnchorAndKind: Map<string, GraphNode[]>;
  stats: {
    bucketCount: number;
    relationshipCount: number;
    entryCount: number;
    maximumEntryCount: number;
  };
}

const buildSharedNeighborIndex = (
  graph: Neighborhood,
  unmatchedCandidate: ReadonlyMap<string, GraphNode>,
  matchedCandidateIds: ReadonlySet<string>,
): SharedNeighborIndex => {
  const candidatesByAnchorAndKind = new Map<string, GraphNode[]>();
  let relationshipCount = 0;

  // Candidate-major iteration keeps every bucket in stable ID order without
  // sorting each adjacency list independently. The index stores one object
  // reference per graph relationship, rather than copying every candidate
  // port token into every neighboring anchor's feature maps.
  for (const candidate of sortedById(unmatchedCandidate.values())) {
    for (const anchorId of graph.neighborsByNode.get(candidate.id) ?? []) {
      if (!matchedCandidateIds.has(anchorId)) continue;
      relationshipCount += 1;
      if (relationshipCount > MAX_SHARED_NEIGHBOR_RELATIONSHIPS) {
        throw new Error(
          `Aggressive shared-neighbor index exceeds ${MAX_SHARED_NEIGHBOR_RELATIONSHIPS} relationships`,
        );
      }
      const key = sharedNeighborKey(anchorId, candidate.kind);
      const values = candidatesByAnchorAndKind.get(key) ?? [];
      values.push(candidate);
      candidatesByAnchorAndKind.set(key, values);
    }
  }
  const bucketCount = candidatesByAnchorAndKind.size;
  const entryCount = relationshipCount + bucketCount;
  if (entryCount > MAX_SHARED_NEIGHBOR_INDEX_ENTRIES) {
    throw new Error(
      `Aggressive shared-neighbor index has ${entryCount} entries, exceeding budget ${MAX_SHARED_NEIGHBOR_INDEX_ENTRIES}`,
    );
  }
  return {
    candidatesByAnchorAndKind,
    stats: {
      bucketCount,
      relationshipCount,
      entryCount,
      maximumEntryCount: MAX_SHARED_NEIGHBOR_INDEX_ENTRIES,
    },
  };
};

function* candidatesFromSharedNeighborIndex(
  index: SharedNeighborIndex,
  anchorId: string,
  reference: GraphNode,
  referenceOrdinal: number,
): Generator<GraphNode> {
  const candidates =
    index.candidatesByAnchorAndKind.get(sharedNeighborKey(anchorId, reference.kind)) ?? [];
  const maximum = Math.min(
    AGGRESSIVE_NEIGHBOR_POOL_MULTIPLIER * RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode,
    candidates.length,
  );
  if (maximum === 0) return;
  const start =
    (referenceOrdinal * RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode) %
    candidates.length;
  for (let offset = 0; offset < maximum; offset += 1) {
    yield candidates[(start + offset) % candidates.length];
  }
}

/** @internal Exposes the actual bounded index shape for resource regressions. */
export const aggressiveSharedNeighborIndexStats = (
  candidate: GraphSlice,
  unmatchedCandidateIds: ReadonlySet<string>,
  matchedCandidateIds: ReadonlySet<string>,
) => {
  const unmatchedCandidate = new Map(
    candidate.nodes
      .filter((node) => unmatchedCandidateIds.has(node.id))
      .map((node) => [node.id, node] as const),
  );
  return buildSharedNeighborIndex(neighborhood(candidate), unmatchedCandidate, matchedCandidateIds)
    .stats;
};

const aggressiveMatches = (
  unmatchedReference: Map<string, GraphNode>,
  unmatchedCandidate: Map<string, GraphNode>,
  referenceGraph: Neighborhood,
  candidateGraph: Neighborhood,
  matchedReferenceToCandidate: Map<string, string>,
  mappings: readonly SourceLineMapping[],
) => {
  const accepted: NodeMatch[] = [];
  /**
   * Every non-terminal round removes at least one pair, so this reaches a
   * fixed point after at most min(reference, candidate) rounds. Candidate
   * generation remains inverted-index based: each reference inspects only the
   * configured K-sized source/semantic/neighbor strata, never every candidate.
   * Rebuilding indexes makes the worst case O(M * V * K), where M is the
   * number of accepted batches, V the remaining nodes, and K the fixed fuzzy
   * cap. The comparison worker supplies cancellation and its wall-time bound;
   * this loop has no result-changing arbitrary pass cutoff.
   */
  while (unmatchedReference.size > 0 && unmatchedCandidate.size > 0) {
    const sourceIndex = buildSourceLineIndex(unmatchedCandidate.values(), mappings);
    const semanticIndex = new Map<string, BoundedCandidateBucket>();
    const matchedCandidateIds = new Set(matchedReferenceToCandidate.values());
    const sharedNeighborIndex = buildSharedNeighborIndex(
      candidateGraph,
      unmatchedCandidate,
      matchedCandidateIds,
    );
    for (const candidate of sortedById(unmatchedCandidate.values())) {
      for (const key of semanticKeys(candidate)) {
        const indexKey = tupleKey(candidate.kind, key);
        const bucket = semanticIndex.get(indexKey) ?? newBoundedCandidateBucket();
        addToBoundedCandidateBucket(bucket, candidate);
        semanticIndex.set(indexKey, bucket);
      }
    }
    const candidates: ScoredPair[] = [];
    const orderedReferences = sortedById(unmatchedReference.values());
    for (const [referenceOrdinal, reference] of orderedReferences.entries()) {
      const fuzzyLimit = RESOURCE_LIMITS.browser.comparison.fuzzyCandidatesPerNode;
      const pool = new Map<
        string,
        {
          candidate: GraphNode;
          source: number;
          semantic: number;
          ports: number;
          preScore: number;
          selectionPriority: number;
          selectionOrdinal: number;
        }
      >();
      const selectionOrdinals = [0, 0, 0];
      const inspectCandidates = (
        values: Iterable<GraphNode>,
        budget: { used: number; maximum: number },
        selectionPriority: number,
      ) => {
        for (const candidate of values) {
          if (budget.used >= budget.maximum) return false;
          budget.used += 1;
          const selectionOrdinal = selectionOrdinals[selectionPriority]++;
          const existing = pool.get(candidate.id);
          if (existing) {
            if (
              selectionPriority < existing.selectionPriority ||
              (selectionPriority === existing.selectionPriority &&
                selectionOrdinal < existing.selectionOrdinal)
            ) {
              existing.selectionPriority = selectionPriority;
              existing.selectionOrdinal = selectionOrdinal;
            }
            continue;
          }
          if (!nodeCompatible(reference, candidate)) continue;
          const source = sourceScore(reference, candidate, mappings);
          const semantic = semanticScore(reference, candidate);
          const ports = portScore(reference, candidate);
          pool.set(candidate.id, {
            candidate,
            source,
            semantic,
            ports,
            preScore: 0.5 * source + 0.3 * semantic + 0.2 * ports,
            selectionPriority,
            selectionOrdinal,
          });
        }
        return budget.used < budget.maximum;
      };
      const referenceTargets = sourceTargets(reference, mappings, "reference").sort(
        (left, right) => compareCodeUnits(left.path, right.path) || left.line - right.line,
      );
      const sourceBudget = {
        used: 0,
        maximum: AGGRESSIVE_SOURCE_POOL_MULTIPLIER * fuzzyLimit,
      };
      for (const origin of referenceTargets) {
        const sameFile = sourceIndex.get(tupleKey(reference.kind, origin.path)) ?? [];
        if (!inspectCandidates(nearestCandidatesByLine(sameFile, origin.line), sourceBudget, 2)) {
          break;
        }
      }
      const semanticBudget = {
        used: 0,
        maximum: AGGRESSIVE_SEMANTIC_POOL_MULTIPLIER * fuzzyLimit,
      };
      for (const key of new Set(semanticKeys(reference))) {
        if (
          !inspectCandidates(
            candidatesFromBoundedBucket(
              semanticIndex.get(tupleKey(reference.kind, key)),
              reference,
              referenceOrdinal,
            ),
            semanticBudget,
            0,
          )
        ) {
          break;
        }
      }
      const matchedNeighbors = referenceGraph.neighborsByNode.get(reference.id) ?? new Set();
      const neighborBudget = {
        used: 0,
        maximum: AGGRESSIVE_NEIGHBOR_POOL_MULTIPLIER * fuzzyLimit,
      };
      for (const neighbor of [...matchedNeighbors].sort(compareCodeUnits)) {
        const candidateNeighbor = matchedReferenceToCandidate.get(neighbor);
        if (!candidateNeighbor) continue;
        if (
          !inspectCandidates(
            candidatesFromSharedNeighborIndex(
              sharedNeighborIndex,
              candidateNeighbor,
              reference,
              referenceOrdinal,
            ),
            neighborBudget,
            1,
          )
        ) {
          break;
        }
      }
      const preselected = [...pool.values()]
        .sort(
          (left, right) =>
            right.preScore - left.preScore ||
            left.selectionPriority - right.selectionPriority ||
            left.selectionOrdinal - right.selectionOrdinal ||
            compareCodeUnits(left.candidate.id, right.candidate.id),
        )
        .slice(0, fuzzyLimit);
      const referenceNeighbors = matchedNeighborTokens(reference, referenceGraph, (id) =>
        matchedReferenceToCandidate.get(id),
      );
      const referenceFan = fanInOutTokens(reference, referenceGraph);
      for (const { candidate, source, semantic, ports } of preselected) {
        const candidateNeighbors = matchedNeighborTokens(candidate, candidateGraph, (id) =>
          matchedCandidateIds.has(id) ? id : undefined,
        );
        const matchedNeighborAgreement =
          referenceNeighbors.length === 0 && candidateNeighbors.length === 0
            ? 0
            : multisetSimilarity(referenceNeighbors, candidateNeighbors);
        const fanAgreement = multisetSimilarity(
          referenceFan,
          fanInOutTokens(candidate, candidateGraph),
        );
        const neighbors = (matchedNeighborAgreement + fanAgreement) / 2;
        const parametersAndWidths = widthAndParameterScore(reference, candidate);
        const score =
          0.35 * source +
          0.25 * semantic +
          0.15 * ports +
          0.2 * neighbors +
          0.05 * parametersAndWidths;
        const evidence = [
          `source ${source.toFixed(2)}`,
          `semantic ${semantic.toFixed(2)}`,
          `ports ${ports.toFixed(2)}`,
          `neighbors ${neighbors.toFixed(2)} (matched ${matchedNeighborAgreement.toFixed(2)}, fan ${fanAgreement.toFixed(2)})`,
          `parameters/widths ${parametersAndWidths.toFixed(2)}`,
        ];
        candidates.push({ reference, candidate, score, evidence });
      }
    }
    const batch = selectMutualMaximumPairs(candidates).map(
      (pair): NodeMatch => ({
        reference: pair.reference,
        candidate: pair.candidate,
        match: metadata("heuristic", pair.score, pair.evidence),
      }),
    );
    if (batch.length === 0) break;
    for (const pair of batch) {
      unmatchedReference.delete(pair.reference.id);
      unmatchedCandidate.delete(pair.candidate.id);
      matchedReferenceToCandidate.set(pair.reference.id, pair.candidate.id);
      accepted.push(pair);
    }
  }
  return accepted;
};

const matchNodes = (reference: GraphSlice, candidate: GraphSlice, options: CompareGraphOptions) => {
  const unmatchedReference = uniqueById(reference.nodes, "Reference graph nodes");
  const unmatchedCandidate = uniqueById(candidate.nodes, "Candidate graph nodes");
  const matches: NodeMatch[] = [];
  for (const node of sortedById(unmatchedReference.values())) {
    const other = unmatchedCandidate.get(node.id);
    if (!other || !exactIdCompatible(node, other)) continue;
    matches.push({ reference: node, candidate: other, match: methodMetadata.exactId });
    unmatchedReference.delete(node.id);
    unmatchedCandidate.delete(other.id);
  }
  matches.push(
    ...matchUniqueKeys(
      unmatchedReference,
      unmatchedCandidate,
      (node) => (nodeNamedKey(node) ? [nodeNamedKey(node) as string] : []),
      (node) => (nodeNamedKey(node) ? [nodeNamedKey(node) as string] : []),
      methodMetadata.named,
    ),
  );
  const mappings = options.sourceLineMappings ?? [];
  matches.push(
    ...matchUniqueKeys(
      unmatchedReference,
      unmatchedCandidate,
      (node) => sourceKeys(node, mappings, "reference"),
      (node) => sourceKeys(node, mappings, "candidate"),
      methodMetadata.sourceMapped,
    ),
  );
  const referenceGraph = neighborhood(reference);
  const candidateGraph = neighborhood(candidate);
  const matchedReferenceToCandidate = new Map(
    matches.map((pair) => [pair.reference.id, pair.candidate.id] as const),
  );
  matches.push(
    ...incrementalStructuralMatches(
      unmatchedReference,
      unmatchedCandidate,
      referenceGraph,
      candidateGraph,
      matchedReferenceToCandidate,
    ),
  );
  if ((options.policy ?? "conservative") === "aggressive") {
    matches.push(
      ...aggressiveMatches(
        unmatchedReference,
        unmatchedCandidate,
        referenceGraph,
        candidateGraph,
        matchedReferenceToCandidate,
        mappings,
      ),
    );
  }
  return { matches, unmatchedReference, unmatchedCandidate };
};

interface PortPairing {
  union: GraphPort[];
  comparisons: ComparisonPort[];
  referenceIds: Map<string, string>;
  candidateIds: Map<string, string>;
}

const portPayloadEqual = (reference: GraphPort, candidate: GraphPort) =>
  reference.name === candidate.name &&
  reference.direction === candidate.direction &&
  reference.index === candidate.index &&
  reference.role === candidate.role &&
  reference.width === candidate.width;

const pairPorts = (
  nodeId: string,
  referenceNode: GraphNode | undefined,
  candidateNode: GraphNode | undefined,
  nodeMatch?: MatchMetadata,
): PortPairing => {
  const referenceIds = new Map<string, string>();
  const candidateIds = new Map<string, string>();
  const comparisons: ComparisonPort[] = [];
  const union: GraphPort[] = [];
  const unmatchedReference = new Map((referenceNode?.ports ?? []).map((port) => [port.id, port]));
  const unmatchedCandidate = new Map((candidateNode?.ports ?? []).map((port) => [port.id, port]));
  const matches: Array<{ reference: GraphPort; candidate: GraphPort; match: MatchMetadata }> = [];
  for (const port of sortedById(unmatchedReference.values())) {
    const other = unmatchedCandidate.get(port.id);
    if (!other) continue;
    matches.push({ reference: port, candidate: other, match: methodMetadata.exactId });
    unmatchedReference.delete(port.id);
    unmatchedCandidate.delete(other.id);
  }
  const uniquePortStage = (key: (port: GraphPort) => string, match: MatchMetadata) => {
    const referenceIndex = new Map<string, GraphPort[]>();
    const candidateIndex = new Map<string, GraphPort[]>();
    for (const port of unmatchedReference.values()) pushIndex(referenceIndex, key(port), port);
    for (const port of unmatchedCandidate.values()) pushIndex(candidateIndex, key(port), port);
    for (const value of [...referenceIndex.keys()].sort()) {
      const references = referenceIndex.get(value) ?? [];
      const candidates = candidateIndex.get(value) ?? [];
      if (references.length !== 1 || candidates.length !== 1) continue;
      const reference = references[0];
      const candidate = candidates[0];
      matches.push({ reference, candidate, match });
      unmatchedReference.delete(reference.id);
      unmatchedCandidate.delete(candidate.id);
    }
  };
  uniquePortStage(
    (port) => tupleKey(port.name, port.direction, port.role ?? null, port.index ?? null),
    methodMetadata.named,
  );
  uniquePortStage(portStructuralToken, methodMetadata.structural);
  for (const pair of matches.sort((left, right) =>
    compareCodeUnits(left.reference.id, right.reference.id),
  )) {
    const id = overlayId("port", pair.reference.id, pair.candidate.id);
    const value = { ...pair.candidate, id };
    referenceIds.set(pair.reference.id, id);
    candidateIds.set(pair.candidate.id, id);
    union.push(value);
    comparisons.push({
      id,
      nodeId,
      referenceNodeId: referenceNode?.id,
      candidateNodeId: candidateNode?.id,
      status: portPayloadEqual(pair.reference, pair.candidate) ? "unchanged" : "modified",
      reference: pair.reference,
      candidate: pair.candidate,
      match: withHeuristicDependencies(pair.match, [nodeMatch], "port correspondence"),
    });
  }
  for (const port of sortedById(unmatchedReference.values())) {
    const id = overlayId("port", port.id, undefined);
    referenceIds.set(port.id, id);
    union.push({ ...port, id });
    comparisons.push({
      id,
      nodeId,
      referenceNodeId: referenceNode?.id,
      status: "removed",
      reference: port,
    });
  }
  for (const port of sortedById(unmatchedCandidate.values())) {
    const id = overlayId("port", undefined, port.id);
    candidateIds.set(port.id, id);
    union.push({ ...port, id });
    comparisons.push({
      id,
      nodeId,
      candidateNodeId: candidateNode?.id,
      status: "added",
      candidate: port,
    });
  }
  return { union, comparisons, referenceIds, candidateIds };
};

const nodePayloadEqual = (reference: GraphNode, candidate: GraphNode) =>
  reference.kind === candidate.kind &&
  reference.label === candidate.label &&
  reference.glyph === candidate.glyph &&
  reference.definitionName === candidate.definitionName &&
  parametersEqual(reference.parameters, candidate.parameters);

interface UnionNodes {
  union: GraphNode[];
  comparisons: ComparisonEntity<GraphNode>[];
  ports: ComparisonPort[];
  referenceNodeIds: Map<string, string>;
  candidateNodeIds: Map<string, string>;
  referencePortIds: Map<string, string>;
  candidatePortIds: Map<string, string>;
  referenceNodeMatches: Map<string, MatchMetadata>;
  candidateNodeMatches: Map<string, MatchMetadata>;
}

const nodePortKey = (nodeId: string, portId: string) => JSON.stringify([nodeId, portId]);

const buildUnionNodes = (
  matches: readonly NodeMatch[],
  unmatchedReference: ReadonlyMap<string, GraphNode>,
  unmatchedCandidate: ReadonlyMap<string, GraphNode>,
): UnionNodes => {
  const union: GraphNode[] = [];
  const comparisons: ComparisonEntity<GraphNode>[] = [];
  const ports: ComparisonPort[] = [];
  const referenceNodeIds = new Map<string, string>();
  const candidateNodeIds = new Map<string, string>();
  const referencePortIds = new Map<string, string>();
  const candidatePortIds = new Map<string, string>();
  const referenceNodeMatches = new Map<string, MatchMetadata>();
  const candidateNodeMatches = new Map<string, MatchMetadata>();
  const matchByReference = new Map(matches.map((pair) => [pair.reference.id, pair] as const));
  const referenceOrder = sortedById([
    ...matches.map((pair) => pair.reference),
    ...unmatchedReference.values(),
  ]);
  for (const reference of referenceOrder) {
    const pair = matchByReference.get(reference.id);
    const candidate = pair?.candidate;
    const id = overlayId("node", reference.id, candidate?.id);
    referenceNodeIds.set(reference.id, id);
    if (pair) {
      referenceNodeMatches.set(reference.id, pair.match);
      candidateNodeMatches.set(pair.candidate.id, pair.match);
    }
    if (candidate) candidateNodeIds.set(candidate.id, id);
    const portPairing = pairPorts(id, reference, candidate, pair?.match);
    for (const [portId, overlay] of portPairing.referenceIds) {
      referencePortIds.set(nodePortKey(reference.id, portId), overlay);
    }
    if (candidate) {
      for (const [portId, overlay] of portPairing.candidateIds) {
        candidatePortIds.set(nodePortKey(candidate.id, portId), overlay);
      }
    }
    ports.push(...portPairing.comparisons);
    const base = candidate ?? reference;
    union.push({ ...base, id, ports: portPairing.union });
    const status = candidate
      ? nodePayloadEqual(reference, candidate) &&
        portPairing.comparisons.every((port) => port.status === "unchanged")
        ? "unchanged"
        : "modified"
      : "removed";
    comparisons.push({
      id,
      status,
      reference,
      candidate,
      match: pair?.match,
    });
  }
  for (const candidate of sortedById(unmatchedCandidate.values())) {
    const id = overlayId("node", undefined, candidate.id);
    candidateNodeIds.set(candidate.id, id);
    const portPairing = pairPorts(id, undefined, candidate);
    for (const [portId, overlay] of portPairing.candidateIds) {
      candidatePortIds.set(nodePortKey(candidate.id, portId), overlay);
    }
    ports.push(...portPairing.comparisons);
    union.push({ ...candidate, id, ports: portPairing.union });
    comparisons.push({ id, status: "added", candidate });
  }
  return {
    union,
    comparisons,
    ports,
    referenceNodeIds,
    candidateNodeIds,
    referencePortIds,
    candidatePortIds,
    referenceNodeMatches,
    candidateNodeMatches,
  };
};

const remapEdge = (
  edge: GraphEdge,
  nodeIds: ReadonlyMap<string, string>,
  portIds: ReadonlyMap<string, string>,
) => {
  const sourceNode = nodeIds.get(edge.sourceNode);
  const targetNode = nodeIds.get(edge.targetNode);
  if (!sourceNode || !targetNode) throw new Error(`Edge ${edge.id} references an unknown node`);
  const sourcePort = edge.sourcePort
    ? portIds.get(nodePortKey(edge.sourceNode, edge.sourcePort))
    : undefined;
  const targetPort = edge.targetPort
    ? portIds.get(nodePortKey(edge.targetNode, edge.targetPort))
    : undefined;
  if (edge.sourcePort && !sourcePort) throw new Error(`Edge ${edge.id} references an unknown port`);
  if (edge.targetPort && !targetPort) throw new Error(`Edge ${edge.id} references an unknown port`);
  return { sourceNode, sourcePort, targetNode, targetPort };
};

const edgeEndpointKey = (edge: ReturnType<typeof remapEdge>) =>
  JSON.stringify([
    edge.sourceNode,
    edge.sourcePort ?? null,
    edge.targetNode,
    edge.targetPort ?? null,
  ]);

const edgePayloadEqual = (reference: GraphEdge, candidate: GraphEdge) =>
  reference.label === candidate.label &&
  reference.width === candidate.width &&
  reference.signalType === candidate.signalType &&
  reference.role === candidate.role;

const edgeNodeMatchDependencies = (
  reference: GraphEdge,
  candidate: GraphEdge,
  nodes: UnionNodes,
) => [
  nodes.referenceNodeMatches.get(reference.sourceNode),
  nodes.referenceNodeMatches.get(reference.targetNode),
  nodes.candidateNodeMatches.get(candidate.sourceNode),
  nodes.candidateNodeMatches.get(candidate.targetNode),
];

const buildUnionEdges = (reference: GraphSlice, candidate: GraphSlice, nodes: UnionNodes) => {
  const referenceRemapped = new Map(
    reference.edges.map((edge) => [
      edge.id,
      remapEdge(edge, nodes.referenceNodeIds, nodes.referencePortIds),
    ]),
  );
  const candidateRemapped = new Map(
    candidate.edges.map((edge) => [
      edge.id,
      remapEdge(edge, nodes.candidateNodeIds, nodes.candidatePortIds),
    ]),
  );
  const unmatchedReference = uniqueById(reference.edges, "Reference graph edges");
  const unmatchedCandidate = uniqueById(candidate.edges, "Candidate graph edges");
  const matches: Array<{
    reference: GraphEdge;
    candidate: GraphEdge;
    match: MatchMetadata;
  }> = [];
  for (const edge of sortedById(unmatchedReference.values())) {
    const other = unmatchedCandidate.get(edge.id);
    if (
      !other ||
      edgeEndpointKey(referenceRemapped.get(edge.id) as ReturnType<typeof remapEdge>) !==
        edgeEndpointKey(candidateRemapped.get(other.id) as ReturnType<typeof remapEdge>)
    ) {
      continue;
    }
    matches.push({ reference: edge, candidate: other, match: methodMetadata.exactId });
    unmatchedReference.delete(edge.id);
    unmatchedCandidate.delete(other.id);
  }
  const referenceIndex = new Map<string, GraphEdge[]>();
  const candidateIndex = new Map<string, GraphEdge[]>();
  for (const edge of unmatchedReference.values()) {
    pushIndex(
      referenceIndex,
      edgeEndpointKey(referenceRemapped.get(edge.id) as ReturnType<typeof remapEdge>),
      edge,
    );
  }
  for (const edge of unmatchedCandidate.values()) {
    pushIndex(
      candidateIndex,
      edgeEndpointKey(candidateRemapped.get(edge.id) as ReturnType<typeof remapEdge>),
      edge,
    );
  }
  for (const key of [...referenceIndex.keys()].sort()) {
    const references = referenceIndex.get(key) ?? [];
    const candidates = candidateIndex.get(key) ?? [];
    if (references.length !== 1 || candidates.length !== 1) continue;
    const referenceEdge = references[0];
    const candidateEdge = candidates[0];
    matches.push({
      reference: referenceEdge,
      candidate: candidateEdge,
      match: methodMetadata.structural,
    });
    unmatchedReference.delete(referenceEdge.id);
    unmatchedCandidate.delete(candidateEdge.id);
  }
  const union: GraphEdge[] = [];
  const comparisons: ComparisonEntity<GraphEdge>[] = [];
  const matchesByReference = new Map(matches.map((pair) => [pair.reference.id, pair] as const));
  for (const referenceEdge of sortedById([
    ...matches.map((pair) => pair.reference),
    ...unmatchedReference.values(),
  ])) {
    const pair = matchesByReference.get(referenceEdge.id);
    const candidateEdge = pair?.candidate;
    const id = overlayId("edge", referenceEdge.id, candidateEdge?.id);
    const endpoints = candidateEdge
      ? (candidateRemapped.get(candidateEdge.id) as ReturnType<typeof remapEdge>)
      : (referenceRemapped.get(referenceEdge.id) as ReturnType<typeof remapEdge>);
    const base = candidateEdge ?? referenceEdge;
    union.push({ ...base, id, ...endpoints });
    comparisons.push({
      id,
      status: candidateEdge
        ? edgePayloadEqual(referenceEdge, candidateEdge)
          ? "unchanged"
          : "modified"
        : "removed",
      reference: referenceEdge,
      candidate: candidateEdge,
      match:
        pair && candidateEdge
          ? withHeuristicDependencies(
              pair.match,
              edgeNodeMatchDependencies(referenceEdge, candidateEdge, nodes),
              "edge correspondence",
            )
          : pair?.match,
    });
  }
  for (const candidateEdge of sortedById(unmatchedCandidate.values())) {
    const id = overlayId("edge", undefined, candidateEdge.id);
    union.push({
      ...candidateEdge,
      id,
      ...(candidateRemapped.get(candidateEdge.id) as ReturnType<typeof remapEdge>),
    });
    comparisons.push({ id, status: "added", candidate: candidateEdge });
  }
  return { union, comparisons };
};

const groupPayloadEqual = (
  reference: GraphGroup,
  candidate: GraphGroup,
  referenceChildren: readonly string[],
  candidateChildren: readonly string[],
) =>
  reference.name === candidate.name &&
  reference.definitionName === candidate.definitionName &&
  parametersEqual(reference.parameters, candidate.parameters) &&
  tupleArrayKey([...referenceChildren].sort()) === tupleArrayKey([...candidateChildren].sort());

const groupNodeMatchDependencies = (
  reference: GraphGroup,
  candidate: GraphGroup,
  nodes: UnionNodes,
) => [
  ...reference.childNodeIds.map((id) => nodes.referenceNodeMatches.get(id)),
  ...candidate.childNodeIds.map((id) => nodes.candidateNodeMatches.get(id)),
];

const buildUnionGroups = (reference: GraphSlice, candidate: GraphSlice, nodes: UnionNodes) => {
  const unmatchedReference = uniqueById(reference.groups ?? [], "Reference graph groups");
  const unmatchedCandidate = uniqueById(candidate.groups ?? [], "Candidate graph groups");
  const matches: Array<{
    reference: GraphGroup;
    candidate: GraphGroup;
    match: MatchMetadata;
  }> = [];
  for (const group of sortedById(unmatchedReference.values())) {
    const other = unmatchedCandidate.get(group.id);
    if (!other) continue;
    matches.push({ reference: group, candidate: other, match: methodMetadata.exactId });
    unmatchedReference.delete(group.id);
    unmatchedCandidate.delete(other.id);
  }
  const referenceNamed = new Map<string, GraphGroup[]>();
  const candidateNamed = new Map<string, GraphGroup[]>();
  for (const group of unmatchedReference.values()) {
    pushIndex(referenceNamed, tupleKey(group.name, group.definitionName), group);
  }
  for (const group of unmatchedCandidate.values()) {
    pushIndex(candidateNamed, tupleKey(group.name, group.definitionName), group);
  }
  for (const key of [...referenceNamed.keys()].sort()) {
    const references = referenceNamed.get(key) ?? [];
    const candidates = candidateNamed.get(key) ?? [];
    if (references.length !== 1 || candidates.length !== 1) continue;
    const referenceGroup = references[0];
    const candidateGroup = candidates[0];
    matches.push({
      reference: referenceGroup,
      candidate: candidateGroup,
      match: methodMetadata.named,
    });
    unmatchedReference.delete(referenceGroup.id);
    unmatchedCandidate.delete(candidateGroup.id);
  }
  const remapChildren = (group: GraphGroup, ids: ReadonlyMap<string, string>) =>
    group.childNodeIds.map((id) => {
      const mapped = ids.get(id);
      if (!mapped) throw new Error(`Group ${group.id} references an unknown node ${id}`);
      return mapped;
    });
  const union: GraphGroup[] = [];
  const comparisons: ComparisonEntity<GraphGroup>[] = [];
  const matchByReference = new Map(matches.map((pair) => [pair.reference.id, pair] as const));
  for (const referenceGroup of sortedById([
    ...matches.map((pair) => pair.reference),
    ...unmatchedReference.values(),
  ])) {
    const pair = matchByReference.get(referenceGroup.id);
    const candidateGroup = pair?.candidate;
    const referenceChildren = remapChildren(referenceGroup, nodes.referenceNodeIds);
    const candidateChildren = candidateGroup
      ? remapChildren(candidateGroup, nodes.candidateNodeIds)
      : [];
    const id = overlayId("group", referenceGroup.id, candidateGroup?.id);
    const base = candidateGroup ?? referenceGroup;
    const match =
      pair && candidateGroup
        ? withHeuristicDependencies(
            pair.match,
            groupNodeMatchDependencies(referenceGroup, candidateGroup, nodes),
            "group correspondence",
          )
        : pair?.match;
    union.push({
      ...base,
      id,
      childNodeIds: [...new Set([...referenceChildren, ...candidateChildren])],
    });
    comparisons.push({
      id,
      status: candidateGroup
        ? groupPayloadEqual(referenceGroup, candidateGroup, referenceChildren, candidateChildren)
          ? "unchanged"
          : "modified"
        : "removed",
      reference: referenceGroup,
      candidate: candidateGroup,
      match,
    });
  }
  for (const candidateGroup of sortedById(unmatchedCandidate.values())) {
    const id = overlayId("group", undefined, candidateGroup.id);
    union.push({
      ...candidateGroup,
      id,
      childNodeIds: remapChildren(candidateGroup, nodes.candidateNodeIds),
    });
    comparisons.push({ id, status: "added", candidate: candidateGroup });
  }
  return { union, comparisons };
};

const unionFiles = (reference: GraphSlice, candidate: GraphSlice) => [
  ...(reference.files ?? []).map((file) => ({
    ...file,
    id: overlayId("file", file.id, undefined),
  })),
  ...(candidate.files ?? []).map((file) => ({
    ...file,
    id: overlayId("file", undefined, file.id),
  })),
];

/**
 * Conservatively or heuristically pairs two normalized graph slices and emits
 * one union graph for a single layout pass. It never mutates either input.
 */
export const compareGraphSlices = (
  reference: GraphSlice,
  candidate: GraphSlice,
  options: CompareGraphOptions = {},
): ComparisonSlice => {
  const policy = options.policy ?? "conservative";
  const nodeMatches = matchNodes(reference, candidate, { ...options, policy });
  const nodes = buildUnionNodes(
    nodeMatches.matches,
    nodeMatches.unmatchedReference,
    nodeMatches.unmatchedCandidate,
  );
  const edges = buildUnionEdges(reference, candidate, nodes);
  const groups = buildUnionGroups(reference, candidate, nodes);
  const objectCount = nodes.union.length + edges.union.length + groups.union.length;
  const portCount = nodes.union.reduce((count, node) => count + node.ports.length, 0);
  const originCount =
    nodes.union.reduce((count, node) => count + (node.origins?.length ?? 0), 0) +
    edges.union.reduce((count, edge) => count + (edge.origins?.length ?? 0), 0) +
    groups.union.reduce((count, group) => count + (group.origins?.length ?? 0), 0);
  const maximumObjects = Math.min(
    options.maximumObjects ?? MAX_COMPARISON_OBJECTS,
    MAX_COMPARISON_OBJECTS,
  );
  const maximumPorts = Math.min(options.maximumPorts ?? MAX_COMPARISON_PORTS, MAX_COMPARISON_PORTS);
  const maximumOrigins = Math.min(
    options.maximumOrigins ?? MAX_COMPARISON_ORIGINS,
    MAX_COMPARISON_ORIGINS,
  );
  if (objectCount > maximumObjects) {
    throw new Error(
      `Comparison union graph has ${objectCount} objects, exceeding budget ${maximumObjects}`,
    );
  }
  if (portCount > maximumPorts) {
    throw new Error(
      `Comparison union graph has ${portCount} ports, exceeding budget ${maximumPorts}`,
    );
  }
  if (originCount > maximumOrigins) {
    throw new Error(
      `Comparison union graph has ${originCount} origins, exceeding budget ${maximumOrigins}`,
    );
  }
  return {
    reference,
    candidate,
    union: {
      snapshotId: overlayId("module", reference.snapshotId, candidate.snapshotId),
      module: {
        ...candidate.module,
        id: overlayId("module", reference.module.id, candidate.module.id),
      },
      nodes: nodes.union,
      edges: edges.union,
      groups: groups.union,
      files: unionFiles(reference, candidate),
    },
    nodes: nodes.comparisons,
    ports: nodes.ports,
    edges: edges.comparisons,
    groups: groups.comparisons,
    policy,
    heuristicMatchCount: countHeuristicMatches({
      nodes: nodes.comparisons,
      edges: edges.comparisons,
      groups: groups.comparisons,
    }),
  };
};
