// SPDX-License-Identifier: Apache-2.0

import type { SourceInventoryEntry } from "../api/contracts";
import { normalizePath } from "../api/normalize";
import type { SourceInventoryComparison } from "./types";

const overlayId = (referenceId: string | undefined, candidateId: string | undefined) =>
  `cmp:source:${encodeURIComponent(JSON.stringify([referenceId ?? null, candidateId ?? null]))}`;

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const byPath = (left: SourceInventoryEntry, right: SourceInventoryEntry) =>
  compareCodeUnits(normalizePath(left.path), normalizePath(right.path)) ||
  compareCodeUnits(left.id, right.id);

const indexInventory = (inventory: readonly SourceInventoryEntry[], side: string) => {
  const result = new Map<string, SourceInventoryEntry>();
  for (const source of [...inventory].sort(byPath)) {
    const path = normalizePath(source.path);
    if (!path) throw new Error(`${side} source inventory contains an empty path`);
    if (result.has(path)) {
      throw new Error(`${side} source inventory contains duplicate path ${path}`);
    }
    result.set(path, { ...source, path });
  }
  return result;
};

/**
 * Merges bundled source indexes without loading source bodies. Renames are
 * inferred only for a one-to-one digest match, avoiding guesses for duplicate
 * generated or vendored files.
 */
export const compareSourceInventories = (
  reference: readonly SourceInventoryEntry[],
  candidate: readonly SourceInventoryEntry[],
): SourceInventoryComparison[] => {
  const referenceByPath = indexInventory(reference, "Reference");
  const candidateByPath = indexInventory(candidate, "Candidate");
  const result: SourceInventoryComparison[] = [];
  const removed = new Map(referenceByPath);
  const added = new Map(candidateByPath);

  for (const [path, referenceSource] of referenceByPath) {
    const candidateSource = candidateByPath.get(path);
    if (!candidateSource) continue;
    removed.delete(path);
    added.delete(path);
    result.push({
      id: overlayId(referenceSource.id, candidateSource.id),
      status: referenceSource.sha256 === candidateSource.sha256 ? "unchanged" : "modified",
      reference: referenceSource,
      candidate: candidateSource,
    });
  }

  const removedByDigest = new Map<string, SourceInventoryEntry[]>();
  const addedByDigest = new Map<string, SourceInventoryEntry[]>();
  for (const source of removed.values()) {
    const values = removedByDigest.get(source.sha256) ?? [];
    values.push(source);
    removedByDigest.set(source.sha256, values);
  }
  for (const source of added.values()) {
    const values = addedByDigest.get(source.sha256) ?? [];
    values.push(source);
    addedByDigest.set(source.sha256, values);
  }
  for (const digest of [...removedByDigest.keys()].sort()) {
    const referenceSources = removedByDigest.get(digest) ?? [];
    const candidateSources = addedByDigest.get(digest) ?? [];
    if (referenceSources.length !== 1 || candidateSources.length !== 1) continue;
    const referenceSource = referenceSources[0];
    const candidateSource = candidateSources[0];
    removed.delete(referenceSource.path);
    added.delete(candidateSource.path);
    result.push({
      id: overlayId(referenceSource.id, candidateSource.id),
      status: "renamed",
      reference: referenceSource,
      candidate: candidateSource,
    });
  }

  for (const source of removed.values()) {
    result.push({ id: overlayId(source.id, undefined), status: "removed", reference: source });
  }
  for (const source of added.values()) {
    result.push({ id: overlayId(undefined, source.id), status: "added", candidate: source });
  }

  return result.sort((left, right) => {
    const leftPath = left.candidate?.path ?? left.reference?.path ?? "";
    const rightPath = right.candidate?.path ?? right.reference?.path ?? "";
    return compareCodeUnits(leftPath, rightPath) || compareCodeUnits(left.id, right.id);
  });
};
