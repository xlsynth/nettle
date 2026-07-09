// SPDX-License-Identifier: Apache-2.0

import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { SourceInventoryEntry } from "../api/contracts";
import {
  findUniquePathMatch,
  type LoadedWorkspace,
  normalizeGraphSlice,
  normalizePath,
  pathsReferToSameFile,
} from "../api/normalize";
import type { WorkspaceProvider } from "../bundle/provider";
import {
  type ClassifiedSourceDiffHunk,
  type ComparisonEntity,
  type ComparisonSlice,
  changedComparisonEntitiesForSourceRange,
  changedSourceHunks,
  classifySourceDiffHunks,
  compareGraphSlicesInWorker,
  compareSourceInventories,
  type DiffStatus,
  diffSourceTextsInWorker,
  expandComparisonInstance,
  MAX_COMPARISON_OBJECTS,
  type MatchingPolicy,
  modulePayloadEqual,
  reachableHierarchyHasSchematicSourceEvidence,
  type SchematicSourceEvidence,
  type SourceDiffStatus,
  type SourceInventoryComparison,
  type SourceLineMapping,
  SourceLineMappingResolver,
  type SourceTextDiff,
  sourceBytesTooLargeDiff,
} from "../comparison";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { ConstantRadix } from "../graph/constant-format";
import { TOP_MODULE_ID } from "../graph/constants";
import type { LayoutProfile } from "../graph/layout-profile";
import type { FlattenRenderMode } from "../graph/layout-types";
import type { LabelSettings } from "../graph/SchematicCanvas";
import type {
  FileTreeEntry,
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphSlice,
  ProjectSnapshot,
} from "../model/graph";
import { entityForSourceSelection } from "../source/cross-probe";
import { AppHeader } from "./AppHeader";
import {
  lowSchematicOverlapWarning,
  modulesRequireExplicitPair,
  type OriginalComparisonSelection,
  originalSelectionForOverlay,
  overlaySelectionForOriginal,
} from "./comparison-selection";
import type {
  ComparisonSelectionDetails,
  ComparisonSelectionSnapshot,
  EntityDiffPresentation,
} from "./comparison-types";
import type { DiffSourceSide, DiffSourceVersion } from "./DiffSourcePane";
import { FileTree, type FileTreeDiffStatus } from "./FileTree";
import { HelpDialog, ProjectSearchDialog } from "./HeaderDialogs";
import { Inspector } from "./Inspector";
import { type DescendantChangeStatus, InstanceHierarchy } from "./InstanceHierarchy";

const SchematicCanvas = lazy(() =>
  import("../graph/SchematicCanvas").then((module) => ({ default: module.SchematicCanvas })),
);
const DiffSourcePane = lazy(() =>
  import("./DiffSourcePane").then((module) => ({ default: module.DiffSourcePane })),
);

type UtilityDialog = "search" | "help";
type Side = "reference" | "candidate";

const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export interface ComparisonBundleInput {
  provider: WorkspaceProvider & { fileName: string };
  workspace: LoadedWorkspace;
  inventory: SourceInventoryEntry[];
  modules: Array<{ id: string; name: string; definitionName: string }>;
}

export interface ComparisonWorkspaceViewProps {
  reference: ComparisonBundleInput;
  candidate: ComparisonBundleInput;
  initialPolicy: MatchingPolicy;
  statusDetail: string;
  setStatusDetail: (detail: string) => void;
  onOpenBundle: () => void;
  onCompareBundles: () => void;
  onPolicyChange?: (policy: MatchingPolicy) => void;
}

interface SlicePair {
  reference: GraphSlice;
  candidate: GraphSlice;
  referencePresent: boolean;
  candidatePresent: boolean;
}

interface ComparisonInstanceIdentity {
  referenceId?: string;
  candidateId?: string;
  preferredSide: Side;
}

interface ComparisonStackEntry {
  pair: SlicePair;
  comparison: ComparisonSlice;
  via?: ComparisonInstanceIdentity;
}

interface CompletedComparisonRequest {
  reference: GraphSlice;
  candidate: GraphSlice;
  policy: MatchingPolicy;
  sourceLineMappings: readonly SourceLineMapping[];
  comparison: ComparisonSlice;
}

interface FailedComparisonRequest {
  reference: GraphSlice;
  candidate: GraphSlice;
  policy: MatchingPolicy;
  sourceLineMappings: readonly SourceLineMapping[];
  message: string;
}

interface ResolvedSourceLineMappings {
  reference: GraphSlice;
  candidate: GraphSlice;
  mappings: readonly SourceLineMapping[];
}

interface LoadedSourcePair {
  reference: DiffSourceVersion;
  candidate: DiffSourceVersion;
}

interface ReachableSourceEvidence {
  key: string;
  status: "checking" | "found" | "absent" | "unknown";
}

interface HierarchyChangeIndex {
  byInstanceIdentity: ReadonlyMap<string, DescendantChangeStatus>;
  complete: boolean;
}

interface HierarchyChangeRequest {
  controller: AbortController;
  promise: Promise<HierarchyChangeIndex>;
  waiters: number;
  settled: boolean;
}

const allEntities = (comparison: ComparisonSlice) => [
  ...comparison.nodes,
  ...comparison.edges,
  ...comparison.groups,
];

const graphObjectWeight = (slice: GraphSlice) =>
  slice.nodes.length +
  slice.nodes.reduce((count, node) => count + node.ports.length, 0) +
  slice.edges.length +
  (slice.groups?.length ?? 0);

const comparisonCacheWeight = (request: CompletedComparisonRequest) =>
  graphObjectWeight(request.reference) +
  graphObjectWeight(request.candidate) +
  graphObjectWeight(request.comparison.union) +
  request.comparison.nodes.length +
  request.comparison.ports.length +
  request.comparison.edges.length +
  request.comparison.groups.length;

const MAX_COMPARISON_CACHE_WEIGHT = MAX_COMPARISON_OBJECTS * 8;

const stableHierarchyValue = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableHierarchyValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableHierarchyValue(record[key])}`)
    .join(",")}}`;
};

const hierarchyChangePairKey = (pair: SlicePair, policy: MatchingPolicy) =>
  stableHierarchyValue([
    policy,
    pair.reference.snapshotId,
    pair.reference.module.id,
    pair.reference.module.definitionName,
    pair.reference.module.parameters,
    pair.referencePresent,
    pair.candidate.snapshotId,
    pair.candidate.module.id,
    pair.candidate.module.definitionName,
    pair.candidate.module.parameters,
    pair.candidatePresent,
    pair.reference.module.name === pair.candidate.module.name,
  ]);

const hierarchyChangeInstanceKey = (
  pair: SlicePair,
  entity: ComparisonEntity<GraphNode>,
  policy: MatchingPolicy,
) =>
  stableHierarchyValue([
    hierarchyChangePairKey(pair, policy),
    entity.reference?.id,
    entity.candidate?.id,
    entity.reference?.definitionName,
    entity.candidate?.definitionName,
    entity.reference?.parameters,
    entity.candidate?.parameters,
  ]);

const hierarchyChangeChildKey = (
  pair: SlicePair,
  entity: ComparisonEntity<GraphNode>,
  policy: MatchingPolicy,
) =>
  stableHierarchyValue([
    hierarchyChangePairKey(pair, policy),
    entity.reference?.definitionName,
    entity.candidate?.definitionName,
    entity.reference?.parameters,
    entity.candidate?.parameters,
    entity.reference?.label === entity.candidate?.label,
    Boolean(entity.reference),
    Boolean(entity.candidate),
  ]);

const mergeDescendantChangeStatus = (
  left: DescendantChangeStatus,
  right: DescendantChangeStatus,
): DescendantChangeStatus => {
  if (left === "contains" || right === "contains") return "contains";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "none";
};

const hierarchyAbortError = () => new DOMException("The operation was aborted", "AbortError");

const waitForHierarchyChangeRequest = (
  request: HierarchyChangeRequest,
  signal: AbortSignal,
  abandon: () => void,
) => {
  if (signal.aborted) return Promise.reject(hierarchyAbortError());
  request.waiters += 1;
  return new Promise<HierarchyChangeIndex>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      request.waiters -= 1;
      if (request.waiters === 0 && !request.settled) abandon();
    };
    const abort = () => {
      release();
      reject(hierarchyAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    void request.promise.then(
      (index) => {
        if (signal.aborted) {
          abort();
          return;
        }
        release();
        resolve(index);
      },
      (reason: unknown) => {
        release();
        reject(reason);
      },
    );
  });
};

const comparisonEntity = (comparison: ComparisonSlice, id: string) =>
  allEntities(comparison).find((entity) => entity.id === id);

const comparisonInstanceIdentity = (
  entity: ComparisonEntity<GraphNode>,
): ComparisonInstanceIdentity => ({
  referenceId: entity.reference?.id,
  candidateId: entity.candidate?.id,
  preferredSide: entity.candidate ? "candidate" : "reference",
});

const comparisonInstanceForIdentity = (
  comparison: ComparisonSlice,
  identity: ComparisonInstanceIdentity,
) => {
  const exact = comparison.nodes.find(
    (entity) =>
      (identity.referenceId === undefined || entity.reference?.id === identity.referenceId) &&
      (identity.candidateId === undefined || entity.candidate?.id === identity.candidateId) &&
      (identity.referenceId !== undefined || identity.candidateId !== undefined),
  );
  if (exact) return exact;
  const fallbackSide = identity.preferredSide === "candidate" ? "reference" : "candidate";
  for (const side of [identity.preferredSide, fallbackSide] as const) {
    const id = side === "reference" ? identity.referenceId : identity.candidateId;
    if (!id) continue;
    const entity = comparison.nodes.find((candidate) => candidate[side]?.id === id);
    if (entity) return entity;
  }
  return undefined;
};

const comparisonEntityKind = (
  comparison: ComparisonSlice,
  id: string,
): OriginalComparisonSelection["kind"] | undefined => {
  if (comparison.nodes.some((entity) => entity.id === id)) return "node";
  if (comparison.edges.some((entity) => entity.id === id)) return "edge";
  if (comparison.groups.some((entity) => entity.id === id)) return "group";
  return undefined;
};

const contextualizeChild = (
  parent: GraphSlice,
  child: GraphSlice,
  node: GraphNode,
): GraphSlice => ({
  ...child,
  module: {
    ...child.module,
    name: node.label,
    instancePath: `${parent.module.instancePath}.${node.label}`,
    definitionName: node.definitionName ?? child.module.definitionName,
  },
});

const contextualizeInstance = (parent: GraphSlice, child: GraphSlice, node: GraphNode) => {
  const group = parent.groups?.find((candidate) => candidate.childNodeIds.includes(node.id));
  return contextualizeChild(
    group
      ? {
          ...parent,
          module: {
            ...parent.module,
            instancePath: `${parent.module.instancePath}.${group.name}`,
          },
        }
      : parent,
    child,
    node,
  );
};

const emptySlice = (
  workspace: LoadedWorkspace,
  opposite: GraphSlice,
  node: GraphNode | undefined,
  side: Side,
): GraphSlice => ({
  snapshotId: workspace.project.snapshotId,
  module: {
    id: `comparison-empty:${side}:${opposite.module.id}:${node?.id ?? "module"}`,
    name: node?.label ?? opposite.module.name,
    instancePath: opposite.module.instancePath,
    definitionName: node?.definitionName ?? opposite.module.definitionName,
    parameters: {},
  },
  nodes: [],
  edges: [],
  groups: [],
  files: [],
});

const topModuleDiffStatus = (pair: SlicePair): DiffStatus => {
  if (pair.referencePresent !== pair.candidatePresent) {
    return pair.referencePresent ? "removed" : "added";
  }
  return modulePayloadEqual(pair.reference.module, pair.candidate.module)
    ? "unchanged"
    : "modified";
};

const defaultSelection = (slice: GraphSlice) =>
  slice.nodes.find((node) => node.kind === "operator")?.id ?? slice.nodes[0]?.id ?? "";

const pendingComparison = (
  reference: GraphSlice,
  candidate: GraphSlice,
  policy: MatchingPolicy,
): ComparisonSlice => ({
  reference,
  candidate,
  union: {
    snapshotId: `comparison-pending:${reference.snapshotId}:${candidate.snapshotId}`,
    module: {
      ...candidate.module,
      id: `comparison-pending:${reference.module.id}:${candidate.module.id}`,
    },
    nodes: [],
    edges: [],
    groups: [],
    files: [],
  },
  nodes: [],
  ports: [],
  edges: [],
  groups: [],
  policy,
  heuristicMatchCount: 0,
});

const requestMatches = (
  request: CompletedComparisonRequest | FailedComparisonRequest | undefined,
  reference: GraphSlice,
  candidate: GraphSlice,
  policy: MatchingPolicy,
  sourceLineMappings: readonly SourceLineMapping[],
) =>
  request?.reference === reference &&
  request.candidate === candidate &&
  request.policy === policy &&
  request.sourceLineMappings === sourceLineMappings;

const cachedComparisonRequestForPair = (
  cache: readonly CompletedComparisonRequest[],
  pair: SlicePair,
  policy?: MatchingPolicy,
  sourceLineMappings?: readonly SourceLineMapping[],
) => {
  for (let index = cache.length - 1; index >= 0; index -= 1) {
    const request = cache[index];
    if (
      request.reference === pair.reference &&
      request.candidate === pair.candidate &&
      (policy === undefined || request.policy === policy) &&
      (sourceLineMappings === undefined || request.sourceLineMappings === sourceLineMappings)
    ) {
      return request;
    }
  }
  return undefined;
};

const cachedComparisonForPair = (
  cache: readonly CompletedComparisonRequest[],
  pair: SlicePair,
  policy?: MatchingPolicy,
  sourceLineMappings?: readonly SourceLineMapping[],
) => cachedComparisonRequestForPair(cache, pair, policy, sourceLineMappings)?.comparison;

const pathForSourceComparison = (source: SourceInventoryComparison) =>
  normalizePath(source.candidate?.path ?? source.reference?.path ?? "");

const buildFileTree = (sources: readonly SourceInventoryComparison[]): FileTreeEntry[] => {
  interface Directory {
    directories: Map<string, Directory>;
    files: FileTreeEntry[];
  }
  const root: Directory = { directories: new Map(), files: [] };
  for (const source of sources) {
    const path = pathForSourceComparison(source);
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      let child = directory.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({
      name: parts.at(-1) ?? path,
      path,
      kind: "file",
      fileId: source.id,
    });
  }
  const entries = (directory: Directory, prefix: string): FileTreeEntry[] => [
    ...[...directory.directories.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, child]) => ({
        name,
        path: prefix ? `${prefix}/${name}` : name,
        kind: "directory" as const,
        children: entries(child, prefix ? `${prefix}/${name}` : name),
      })),
    ...directory.files.sort((left, right) => compareCodeUnits(left.path, right.path)),
  ];
  return entries(root, "");
};

const sourceStatus = (status: SourceInventoryComparison["status"]): SourceDiffStatus => status;

const reachableSourceEvidenceKey = (
  pair: SlicePair | undefined,
  source: SourceInventoryComparison | undefined,
) =>
  pair && source
    ? JSON.stringify([
        pair.reference.snapshotId,
        pair.reference.module.id,
        pair.candidate.snapshotId,
        pair.candidate.module.id,
        source.id,
        source.reference?.sha256 ?? null,
        source.candidate?.sha256 ?? null,
      ])
    : "";

const entityPresentation = (
  entity: ComparisonEntity<GraphNode | GraphEdge | GraphGroup>,
): EntityDiffPresentation => ({
  status: entity.status,
  matchMethod: entity.match?.method,
  confidence: entity.match?.confidence,
  referenceId: entity.reference?.id,
  candidateId: entity.candidate?.id,
});

const snapshot = (
  value: GraphNode | GraphEdge | GraphGroup | undefined,
): ComparisonSelectionSnapshot | undefined => {
  if (!value) return undefined;
  if ("kind" in value) {
    return {
      id: value.id,
      label: value.label,
      kind: value.kind,
      definitionName: value.definitionName,
      glyph: value.glyph,
      parameters: value.parameters,
      ports: value.ports.map(({ id, name, direction, index, role, width }) => ({
        id,
        name,
        direction,
        index,
        role,
        width,
      })),
      origins: value.origins,
    };
  }
  if ("childNodeIds" in value) {
    return {
      id: value.id,
      label: value.name,
      kind: "module",
      definitionName: value.definitionName,
      parameters: value.parameters,
      origins: value.origins,
    };
  }
  return {
    id: value.id,
    label: value.label,
    kind: "net",
    sourceNode: value.sourceNode,
    sourcePort: value.sourcePort,
    targetNode: value.targetNode,
    targetPort: value.targetPort,
    width: value.width,
    signalType: value.signalType,
    role: value.role,
    origins: value.origins,
  };
};

const originFor = (
  entity: ComparisonEntity<GraphNode | GraphEdge | GraphGroup> | undefined,
  side: Side,
) => entity?.[side]?.origins?.[0];

/** @internal Exported so compatibility diagnostics remain order-insensitive under test. */
export const compatibilityWarnings = (
  reference: ComparisonBundleInput,
  candidate: ComparisonBundleInput,
) => {
  const warnings: string[] = [];
  if (
    reference.workspace.slice.module.definitionName !==
    candidate.workspace.slice.module.definitionName
  ) {
    warnings.push("Top module definitions differ");
  }
  if (
    !modulePayloadEqual(reference.workspace.slice.module, {
      ...candidate.workspace.slice.module,
      name: reference.workspace.slice.module.name,
      definitionName: reference.workspace.slice.module.definitionName,
    })
  ) {
    warnings.push("Top parameters differ");
  }
  const boundarySignature = (slice: GraphSlice) =>
    slice.nodes
      .filter((node) => node.kind === "input" || node.kind === "output" || node.kind === "inout")
      .map((node) =>
        JSON.stringify([
          node.kind,
          node.label,
          node.ports
            .map(({ direction, index, name, role, width }) =>
              JSON.stringify([direction, index ?? null, name, role ?? null, width ?? null]),
            )
            .sort(compareCodeUnits),
        ]),
      )
      .sort(compareCodeUnits);
  if (
    JSON.stringify(boundarySignature(reference.workspace.slice)) !==
    JSON.stringify(boundarySignature(candidate.workspace.slice))
  ) {
    warnings.push("Module boundary signatures differ");
  }
  if (reference.workspace.project.filelist !== candidate.workspace.project.filelist) {
    warnings.push("Bundled filelists differ");
  }
  const elaborationSignature = (input: ProjectSnapshot["effectiveElaboration"]) =>
    JSON.stringify({
      parameters: input.parameters
        .map(({ name, value }) => JSON.stringify([name, value]))
        .sort(compareCodeUnits),
      defines: input.defines
        .map(({ name, value }) => JSON.stringify([name, value ?? null]))
        .sort(compareCodeUnits),
      undefines: [...input.undefines].sort(compareCodeUnits),
    });
  if (
    elaborationSignature(reference.workspace.project.effectiveElaboration) !==
    elaborationSignature(candidate.workspace.project.effectiveElaboration)
  ) {
    warnings.push("Elaboration defines or parameters differ");
  }
  const toolSignature = (project: ProjectSnapshot) =>
    project.tools
      .map(({ name, version }) => JSON.stringify([name, version]))
      .sort(compareCodeUnits);
  const referenceTools = toolSignature(reference.workspace.project);
  const candidateTools = toolSignature(candidate.workspace.project);
  if (JSON.stringify(referenceTools) !== JSON.stringify(candidateTools)) {
    warnings.push("Producer tool versions differ");
  }
  return warnings;
};

export function ComparisonWorkspaceView({
  reference,
  candidate,
  ...props
}: ComparisonWorkspaceViewProps) {
  const initialMismatch = modulesRequireExplicitPair(
    reference.workspace.slice.module,
    candidate.workspace.slice.module,
  );
  const [confirmedPair, setConfirmedPair] = useState<{
    reference: ComparisonBundleInput;
    candidate: ComparisonBundleInput;
  }>();
  const [referenceModule, setReferenceModule] = useState(
    reference.modules.find(
      (module) => module.definitionName === reference.workspace.slice.module.definitionName,
    )?.name ?? reference.workspace.slice.module.name,
  );
  const [candidateModule, setCandidateModule] = useState(
    candidate.modules.find(
      (module) => module.definitionName === candidate.workspace.slice.module.definitionName,
    )?.name ?? candidate.workspace.slice.module.name,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const titleId = useId();
  const pairingAbort = useRef<AbortController | undefined>(undefined);
  const pairingGeneration = useRef(0);

  const abortPairingRequest = useCallback(() => {
    pairingGeneration.current += 1;
    pairingAbort.current?.abort();
    pairingAbort.current = undefined;
  }, []);

  useEffect(() => abortPairingRequest, [abortPairingRequest]);

  if (!initialMismatch || confirmedPair) {
    return (
      <ConfirmedComparisonWorkspaceView
        {...props}
        reference={confirmedPair?.reference ?? reference}
        candidate={confirmedPair?.candidate ?? candidate}
      />
    );
  }

  const confirm = async () => {
    const generation = ++pairingGeneration.current;
    pairingAbort.current?.abort();
    const controller = new AbortController();
    pairingAbort.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const [referenceSlice, candidateSlice] = await Promise.all([
        reference.provider
          .getGraphSlice(
            {
              snapshotId: reference.workspace.slice.snapshotId,
              moduleName: referenceModule,
            },
            controller.signal,
          )
          .then(normalizeGraphSlice),
        candidate.provider
          .getGraphSlice(
            {
              snapshotId: candidate.workspace.slice.snapshotId,
              moduleName: candidateModule,
            },
            controller.signal,
          )
          .then(normalizeGraphSlice),
      ]);
      if (controller.signal.aborted || generation !== pairingGeneration.current) return;
      setConfirmedPair({
        reference: {
          ...reference,
          workspace: { ...reference.workspace, slice: referenceSlice },
        },
        candidate: {
          ...candidate,
          workspace: { ...candidate.workspace, slice: candidateSlice },
        },
      });
      props.setStatusDetail(
        `Explicit module pair: ${referenceSlice.module.definitionName} → ${candidateSlice.module.definitionName}`,
      );
    } catch (reason) {
      if (controller.signal.aborted || generation !== pairingGeneration.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === pairingGeneration.current) {
        pairingAbort.current = undefined;
        setLoading(false);
      }
    }
  };

  return (
    <>
      <AppHeader
        projectName={`${reference.provider.fileName} → ${candidate.provider.fileName}`}
        statusText="Module pairing required"
        dataMode="comparison"
        statusDetail="Select and confirm the modules to compare"
        comparison={{
          referenceName: reference.provider.fileName,
          candidateName: candidate.provider.fileName,
          policy: props.initialPolicy,
        }}
        onOpenProject={props.onOpenBundle}
        onCompareBundles={props.onCompareBundles}
        onSearch={() => undefined}
        onHelp={() => undefined}
      />
      <main className="bundle-welcome module-pair-gate">
        <section className="bundle-welcome-card" aria-labelledby={titleId}>
          <h1 id={titleId}>Choose modules to compare</h1>
          <p>
            The bundle tops differ. Confirm an explicit module pair before Nettle runs structural or
            heuristic matching.
          </p>
          <div className="module-pair-fields">
            <label>
              <span>Reference module</span>
              <select
                aria-label="Reference module"
                value={referenceModule}
                disabled={loading}
                onChange={(event) => {
                  abortPairingRequest();
                  setLoading(false);
                  setReferenceModule(event.target.value);
                }}
              >
                {reference.modules.map((module) => (
                  <option value={module.name} key={module.id}>
                    {module.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Candidate module</span>
              <select
                aria-label="Candidate module"
                value={candidateModule}
                disabled={loading}
                onChange={(event) => {
                  abortPairingRequest();
                  setLoading(false);
                  setCandidateModule(event.target.value);
                }}
              >
                {candidate.modules.map((module) => (
                  <option value={module.name} key={module.id}>
                    {module.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? (
            <div className="bundle-open-error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="primary"
            type="button"
            disabled={loading || !referenceModule || !candidateModule}
            onClick={() => void confirm()}
          >
            {loading ? "Loading selected modules…" : "Compare selected modules"}
          </button>
        </section>
      </main>
    </>
  );
}

function ConfirmedComparisonWorkspaceView({
  reference,
  candidate,
  initialPolicy,
  statusDetail,
  setStatusDetail,
  onOpenBundle,
  onCompareBundles,
  onPolicyChange,
}: ComparisonWorkspaceViewProps) {
  const hasBundledSources = reference.inventory.length > 0 || candidate.inventory.length > 0;
  const [policy, setPolicyState] = useState(initialPolicy);
  const [slicePairs, setSlicePairs] = useState<SlicePair[]>([
    {
      reference: reference.workspace.slice,
      candidate: candidate.workspace.slice,
      referencePresent: true,
      candidatePresent: true,
    },
  ]);
  const [hierarchySteps, setHierarchySteps] = useState<ComparisonInstanceIdentity[]>([]);
  const [hierarchyPolicyPending, setHierarchyPolicyPending] = useState(false);
  const [resolvedSourceLineMappings, setResolvedSourceLineMappings] =
    useState<ResolvedSourceLineMappings>();
  const [inlinePair, setInlinePair] = useState<SlicePair>();
  const [inlineComparison, setInlineComparison] = useState<ComparisonSlice>();
  const [projectionPending, setProjectionPending] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [selectedOriginal, setSelectedOriginal] = useState<OriginalComparisonSelection>();
  const [policyFocusRevision, setPolicyFocusRevision] = useState<number>();
  const [hoveredId, setHoveredId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [schematicSemanticSide, setSchematicSemanticSide] = useState<Side>();
  const [inlineHierarchy, setInlineHierarchy] = useState(false);
  const [inlineTargetIdentity, setInlineTargetIdentity] = useState<ComparisonInstanceIdentity>();
  const [flattenDepth, setFlattenDepth] = useState(0);
  const [flattenRenderMode, setFlattenRenderMode] = useState<FlattenRenderMode>("grouped");
  const [layoutProfile, setLayoutProfile] = useState<LayoutProfile>("auto");
  const [constantRadix, setConstantRadix] = useState<ConstantRadix>("binary");
  const [labelSettings, setLabelSettings] = useState<LabelSettings>({
    nets: true,
    signalTypes: false,
    bitWidths: false,
    instances: true,
    definitions: false,
  });
  const [utilityDialog, setUtilityDialog] = useState<UtilityDialog>();
  const [leftPaneView, setLeftPaneView] = useState<"source" | "hierarchy">("source");
  const [sourcePaneWidth, setSourcePaneWidth] = useState<number>();
  const [sourcePair, setSourcePair] = useState<LoadedSourcePair>({
    reference: { path: "", source: "", loading: hasBundledSources },
    candidate: { path: "", source: "", loading: hasBundledSources },
  });
  const [selectedTextDiff, setSelectedTextDiff] = useState<SourceTextDiff>();
  const [selectedTextDiffError, setSelectedTextDiffError] = useState<string>();
  const [sourceHighlightedIds, setSourceHighlightedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const resizePointer = useRef<{ id: number; startX: number; startWidth: number } | undefined>(
    undefined,
  );
  const sourceAbort = useRef<AbortController | undefined>(undefined);
  const sourceEvidenceAbort = useRef<AbortController | undefined>(undefined);
  const sourceEvidenceCache = useRef(new Map<string, SchematicSourceEvidence>());
  const matchingAbort = useRef<AbortController | undefined>(undefined);
  const matchingGeneration = useRef(0);
  const hierarchyAbort = useRef<AbortController | undefined>(undefined);
  const hierarchyGeneration = useRef(0);
  const previousHierarchyPolicy = useRef(policy);
  const slicePairsRef = useRef(slicePairs);
  const hierarchyStepsRef = useRef(hierarchySteps);
  const sourceGeneration = useRef(0);
  const sourceHighlightComparison = useRef<ComparisonSlice | undefined>(undefined);
  const comparisonByUnion = useRef(new WeakMap<GraphSlice, ComparisonStackEntry>());
  const hierarchyChangeRequests = useRef(
    new WeakMap<GraphSlice, Map<MatchingPolicy, HierarchyChangeRequest>>(),
  );
  const completedComparisonCache = useRef<CompletedComparisonRequest[]>([]);
  const [completedComparison, setCompletedComparison] = useState<CompletedComparisonRequest>();
  const [failedComparison, setFailedComparison] = useState<FailedComparisonRequest>();
  const [retryRevision, setRetryRevision] = useState(0);
  const [reachableSourceEvidence, setReachableSourceEvidence] = useState<ReachableSourceEvidence>();
  const [, setComparisonCacheRevision] = useState(0);
  const [, startTransition] = useTransition();

  slicePairsRef.current = slicePairs;
  hierarchyStepsRef.current = hierarchySteps;

  const sources = useMemo(
    () => compareSourceInventories(reference.inventory, candidate.inventory),
    [candidate.inventory, reference.inventory],
  );
  const referenceInventoryPaths = useMemo(
    () => sources.flatMap((source) => (source.reference ? [source.reference.path] : [])),
    [sources],
  );
  const candidateInventoryPaths = useMemo(
    () => sources.flatMap((source) => (source.candidate ? [source.candidate.path] : [])),
    [sources],
  );
  const sourceLineMappingResolver = useMemo(
    () =>
      new SourceLineMappingResolver({
        referenceProvider: reference.provider,
        candidateProvider: candidate.provider,
        sources,
      }),
    [candidate.provider, reference.provider, sources],
  );
  const resolveSourceLineMappingsForPair = useCallback(
    async (referenceSlice: GraphSlice, candidateSlice: GraphSlice, signal: AbortSignal) => {
      try {
        return await sourceLineMappingResolver.resolve(referenceSlice, candidateSlice, signal);
      } catch (reason) {
        if (signal.aborted) throw reason;
        setStatusDetail(
          `Source-line matching unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
        return [];
      }
    },
    [setStatusDetail, sourceLineMappingResolver],
  );
  const files = useMemo(() => buildFileTree(sources), [sources]);
  const statusByPath = useMemo(
    () =>
      Object.fromEntries(
        sources.map((source) => [
          pathForSourceComparison(source),
          source.status as FileTreeDiffStatus,
        ]),
      ),
    [sources],
  );
  const firstSource =
    sources.find((source) => source.status === "modified") ??
    sources.find((source) => source.status !== "unchanged") ??
    sources[0];
  const [selectedSourceId, setSelectedSourceId] = useState(firstSource?.id ?? "");
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? firstSource;

  const rootPair = slicePairs[0];
  const selectedSourceEvidenceKey = reachableSourceEvidenceKey(rootPair, selectedSource);
  const basePair = slicePairs.at(-1) ?? slicePairs[0];
  const displayPair = inlinePair ?? basePair;
  const sourceLineMappings =
    resolvedSourceLineMappings?.reference === displayPair.reference &&
    resolvedSourceLineMappings.candidate === displayPair.candidate
      ? resolvedSourceLineMappings.mappings
      : undefined;
  const completedCurrentComparison = sourceLineMappings
    ? requestMatches(
        completedComparison,
        displayPair.reference,
        displayPair.candidate,
        policy,
        sourceLineMappings,
      )
      ? completedComparison
      : cachedComparisonRequestForPair(
          completedComparisonCache.current,
          displayPair,
          policy,
          sourceLineMappings,
        )
    : undefined;
  const currentComparisonFailure =
    !inlineComparison && sourceLineMappings
      ? requestMatches(
          failedComparison,
          displayPair.reference,
          displayPair.candidate,
          policy,
          sourceLineMappings,
        )
        ? failedComparison
        : undefined
      : undefined;
  const comparison = useMemo(
    () =>
      inlineComparison ??
      completedCurrentComparison?.comparison ??
      pendingComparison(displayPair.reference, displayPair.candidate, policy),
    [completedCurrentComparison, displayPair, inlineComparison, policy],
  );
  const matchingPending =
    hierarchyPolicyPending ||
    projectionPending ||
    (inlineComparison !== undefined && inlineComparison.policy !== policy) ||
    (!inlineComparison &&
      (sourceLineMappings === undefined ||
        (!completedCurrentComparison && !currentComparisonFailure)));
  const schematicComparison =
    matchingPending || currentComparisonFailure
      ? ((inlineComparison?.policy === policy ? inlineComparison : undefined) ??
        cachedComparisonForPair(completedComparisonCache.current, displayPair, policy) ??
        comparison)
      : comparison;

  const rememberComparison = useCallback((completed: CompletedComparisonRequest) => {
    const cache = completedComparisonCache.current.filter(
      (cached) =>
        cached.reference !== completed.reference ||
        cached.candidate !== completed.candidate ||
        cached.policy !== completed.policy,
    );
    cache.push(completed);
    let weight = cache.reduce((total, request) => total + comparisonCacheWeight(request), 0);
    while (cache.length > 1 && weight > MAX_COMPARISON_CACHE_WEIGHT) {
      const evicted = cache.shift();
      if (evicted) weight -= comparisonCacheWeight(evicted);
    }
    completedComparisonCache.current = cache;
    setComparisonCacheRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    void retryRevision;
    if (
      hierarchyPolicyPending ||
      inlineComparison ||
      sourceLineMappings === undefined ||
      completedCurrentComparison
    ) {
      return;
    }
    const generation = ++matchingGeneration.current;
    matchingAbort.current?.abort();
    const controller = new AbortController();
    matchingAbort.current = controller;
    void compareGraphSlicesInWorker(
      displayPair.reference,
      displayPair.candidate,
      { policy, sourceLineMappings },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted || generation !== matchingGeneration.current) return;
        const completed = {
          reference: displayPair.reference,
          candidate: displayPair.candidate,
          policy,
          sourceLineMappings,
          comparison: result,
        } satisfies CompletedComparisonRequest;
        rememberComparison(completed);
        startTransition(() => {
          setFailedComparison(undefined);
          setCompletedComparison(completed);
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || generation !== matchingGeneration.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setFailedComparison({
          reference: displayPair.reference,
          candidate: displayPair.candidate,
          policy,
          sourceLineMappings,
          message,
        });
        setStatusDetail(`Could not compare schematics: ${message}`);
      });
    return () => controller.abort();
  }, [
    completedCurrentComparison,
    displayPair,
    hierarchyPolicyPending,
    inlineComparison,
    policy,
    rememberComparison,
    retryRevision,
    setStatusDetail,
    sourceLineMappings,
  ]);

  const stackEntries = slicePairs.map((pair, index): ComparisonStackEntry => {
    const current =
      index === slicePairs.length - 1 && !inlinePair
        ? comparison
        : (cachedComparisonForPair(completedComparisonCache.current, pair, policy) ??
          pendingComparison(pair.reference, pair.candidate, policy));
    return { pair, comparison: current, via: index > 0 ? hierarchySteps[index - 1] : undefined };
  });
  const currentStackEntry = stackEntries.at(-1) ?? { pair: basePair, comparison };
  for (const entry of stackEntries) comparisonByUnion.current.set(entry.comparison.union, entry);
  comparisonByUnion.current.set(comparison.union, {
    pair: displayPair,
    comparison,
    via: hierarchySteps.at(-1),
  });

  useEffect(() => {
    if (matchingPending || currentComparisonFailure) return;
    if (selectedId) return;
    const next = defaultSelection(comparison.union);
    // A matching completion can race a user's click; never overwrite a selection made after
    // this effect observed the empty state.
    setSelectedId((current) => current || next);
    setSelectedOriginal(originalSelectionForOverlay(comparison, next));
  }, [comparison, currentComparisonFailure, matchingPending, selectedId]);

  useEffect(() => {
    if (matchingPending || currentComparisonFailure) return;
    if (selectedId === TOP_MODULE_ID) return;
    if (!selectedOriginal) return;
    const next = overlaySelectionForOriginal(comparison, selectedOriginal);
    if (next) {
      if (next !== selectedId) setSelectedId(next);
      return;
    }
    setSelectedOriginal(undefined);
    setSelectedId("");
  }, [comparison, currentComparisonFailure, matchingPending, selectedId, selectedOriginal]);

  useEffect(() => {
    if (sourceHighlightComparison.current === comparison) return;
    sourceHighlightComparison.current = comparison;
    setSourceHighlightedIds(new Set());
  }, [comparison]);

  const setPolicy = useCallback(
    (next: MatchingPolicy) => {
      if (next === policy) return;
      matchingGeneration.current += 1;
      matchingAbort.current?.abort();
      matchingAbort.current = undefined;
      hierarchyGeneration.current += 1;
      hierarchyAbort.current?.abort();
      hierarchyAbort.current = undefined;
      comparisonByUnion.current = new WeakMap();
      setSourceHighlightedIds(new Set());
      if (hierarchyStepsRef.current.length > 0) setHierarchyPolicyPending(true);
      if (inlineComparison) setProjectionPending(true);
      setPolicyState(next);
      setPolicyFocusRevision((current) => (current ?? 0) + 1);
      onPolicyChange?.(next);
      setStatusDetail(`${next} matching active`);
    },
    [inlineComparison, onPolicyChange, policy, setStatusDetail],
  );

  useEffect(() => {
    if (hierarchyPolicyPending) return;
    const controller = new AbortController();
    void resolveSourceLineMappingsForPair(
      displayPair.reference,
      displayPair.candidate,
      controller.signal,
    )
      .then((mappings) => {
        if (!controller.signal.aborted) {
          setResolvedSourceLineMappings({
            reference: displayPair.reference,
            candidate: displayPair.candidate,
            mappings,
          });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [displayPair, hierarchyPolicyPending, resolveSourceLineMappingsForPair]);

  useEffect(() => {
    if (!selectedSource) {
      setSourcePair({
        reference: { path: "", source: "", loading: false },
        candidate: { path: "", source: "", loading: false },
      });
      setSelectedTextDiff(undefined);
      setSelectedTextDiffError(undefined);
      setSourceHighlightedIds(new Set());
      return;
    }
    const generation = ++sourceGeneration.current;
    sourceAbort.current?.abort();
    const controller = new AbortController();
    sourceAbort.current = controller;
    setSelectedTextDiff(undefined);
    setSelectedTextDiffError(undefined);
    setSourceHighlightedIds(new Set());
    const loadingVersion = (side: Side): DiffSourceVersion => ({
      path: selectedSource[side]?.path ?? "",
      source: "",
      modelId: selectedSource[side]
        ? `${side}:${selectedSource[side]?.id}:${selectedSource[side]?.sha256}`
        : `${side}:absent:${selectedSource.id}`,
      loading: Boolean(selectedSource[side]),
    });
    const sourceLimit = RESOURCE_LIMITS.native.builder.sourceBytes;
    const exceedsSourceLimit = (["reference", "candidate"] as const).some(
      (side) => (selectedSource[side]?.size ?? 0) > sourceLimit,
    );
    if (exceedsSourceLimit) {
      const unloadedVersion = (side: Side): DiffSourceVersion => ({
        ...loadingVersion(side),
        loading: false,
      });
      setSourcePair({
        reference: unloadedVersion("reference"),
        candidate: unloadedVersion("candidate"),
      });
      setSelectedTextDiff(
        sourceBytesTooLargeDiff(
          selectedSource.reference?.path ?? selectedSource.candidate?.path ?? "source",
          selectedSource.candidate?.path ?? selectedSource.reference?.path ?? "source",
        ),
      );
      return;
    }
    setSourcePair({
      reference: loadingVersion("reference"),
      candidate: loadingVersion("candidate"),
    });
    const load = async (side: Side): Promise<DiffSourceVersion> => {
      const source = selectedSource[side];
      if (!source) return loadingVersion(side);
      try {
        const response = await (side === "reference"
          ? reference.provider
          : candidate.provider
        ).getSource(source.id, controller.signal);
        return {
          path: normalizePath(response.path),
          source: response.content,
          modelId: `${side}:${response.fileId}:${response.version}`,
        };
      } catch (reason) {
        if (controller.signal.aborted) throw reason;
        return {
          ...loadingVersion(side),
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        };
      }
    };
    void Promise.all([load("reference"), load("candidate")])
      .then(async ([referenceSource, candidateSource]) => {
        if (generation !== sourceGeneration.current || controller.signal.aborted) return;
        setSourcePair({ reference: referenceSource, candidate: candidateSource });
        if (
          selectedSource.status === "unchanged" ||
          selectedSource.status === "renamed" ||
          referenceSource.error ||
          candidateSource.error
        ) {
          return;
        }
        const fallbackPath =
          referenceSource.path ||
          candidateSource.path ||
          selectedSource.reference?.path ||
          selectedSource.candidate?.path ||
          "source";
        const diff = await diffSourceTextsInWorker(
          referenceSource.path || fallbackPath,
          candidateSource.path || fallbackPath,
          referenceSource.source,
          candidateSource.source,
          {},
          controller.signal,
        );
        if (generation === sourceGeneration.current && !controller.signal.aborted) {
          setSelectedTextDiff(diff);
        }
      })
      .catch((reason: unknown) => {
        if (generation === sourceGeneration.current && !controller.signal.aborted) {
          setSelectedTextDiffError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [candidate.provider, reference.provider, selectedSource]);

  useEffect(
    () => () => {
      sourceAbort.current?.abort();
      sourceEvidenceAbort.current?.abort();
      matchingAbort.current?.abort();
      hierarchyAbort.current?.abort();
    },
    [],
  );

  const loadChildPair = useCallback(
    async (
      parent: SlicePair,
      entity: ComparisonEntity<GraphNode>,
      signal: AbortSignal,
    ): Promise<SlicePair> => {
      const referenceNode = entity.reference;
      const candidateNode = entity.candidate;
      if (referenceNode && (referenceNode.kind !== "module" || !referenceNode.definitionName)) {
        throw new Error(`Reference object ${referenceNode.label} is not a module instance`);
      }
      if (candidateNode && (candidateNode.kind !== "module" || !candidateNode.definitionName)) {
        throw new Error(`Candidate object ${candidateNode.label} is not a module instance`);
      }
      const [loadedReference, loadedCandidate] = await Promise.all([
        referenceNode
          ? reference.provider
              .getGraphSlice(
                {
                  snapshotId: parent.reference.snapshotId,
                  moduleName: referenceNode.definitionName,
                },
                signal,
              )
              .then((slice) =>
                contextualizeInstance(parent.reference, normalizeGraphSlice(slice), referenceNode),
              )
          : undefined,
        candidateNode
          ? candidate.provider
              .getGraphSlice(
                {
                  snapshotId: parent.candidate.snapshotId,
                  moduleName: candidateNode.definitionName,
                },
                signal,
              )
              .then((slice) =>
                contextualizeInstance(parent.candidate, normalizeGraphSlice(slice), candidateNode),
              )
          : undefined,
      ]);
      const referenceSlice =
        loadedReference ??
        emptySlice(
          reference.workspace,
          loadedCandidate ?? parent.candidate,
          candidateNode,
          "reference",
        );
      const candidateSlice =
        loadedCandidate ??
        emptySlice(
          candidate.workspace,
          loadedReference ?? parent.reference,
          referenceNode,
          "candidate",
        );
      return {
        reference: referenceSlice,
        candidate: candidateSlice,
        referencePresent: Boolean(loadedReference),
        candidatePresent: Boolean(loadedCandidate),
      };
    },
    [candidate.provider, candidate.workspace, reference.provider, reference.workspace],
  );

  const comparePair = useCallback(
    async (pair: SlicePair, signal: AbortSignal): Promise<ComparisonSlice> => {
      const mappings = await resolveSourceLineMappingsForPair(
        pair.reference,
        pair.candidate,
        signal,
      );
      const cached = cachedComparisonForPair(
        completedComparisonCache.current,
        pair,
        policy,
        mappings,
      );
      if (cached) return cached;
      const result = await compareGraphSlicesInWorker(
        pair.reference,
        pair.candidate,
        { policy, sourceLineMappings: mappings },
        signal,
      );
      rememberComparison({
        reference: pair.reference,
        candidate: pair.candidate,
        policy,
        sourceLineMappings: mappings,
        comparison: result,
      });
      return result;
    },
    [policy, rememberComparison, resolveSourceLineMappingsForPair],
  );

  const comparePairForSourceEvidence = useCallback(
    async (pair: SlicePair, signal: AbortSignal) => {
      const mappings = await resolveSourceLineMappingsForPair(
        pair.reference,
        pair.candidate,
        signal,
      );
      return compareGraphSlicesInWorker(
        pair.reference,
        pair.candidate,
        { policy: "conservative", sourceLineMappings: mappings },
        signal,
      );
    },
    [resolveSourceLineMappingsForPair],
  );

  useEffect(() => {
    if (previousHierarchyPolicy.current === policy) {
      setHierarchyPolicyPending(false);
      return;
    }
    const requestedSteps = [...hierarchyStepsRef.current];
    if (requestedSteps.length === 0) {
      previousHierarchyPolicy.current = policy;
      setHierarchyPolicyPending(false);
      return;
    }
    const root = slicePairsRef.current[0];
    if (!root) {
      previousHierarchyPolicy.current = policy;
      setHierarchyPolicyPending(false);
      return;
    }

    const generation = ++hierarchyGeneration.current;
    hierarchyAbort.current?.abort();
    const controller = new AbortController();
    hierarchyAbort.current = controller;
    setHierarchyPolicyPending(true);

    const reconcile = async () => {
      const nextPairs = [root];
      const retainedSteps: ComparisonInstanceIdentity[] = [];
      let parent = root;
      let reopenedSide: Side | undefined;
      for (const step of requestedSteps) {
        const parentComparison = await comparePair(parent, controller.signal);
        const instance = comparisonInstanceForIdentity(parentComparison, step);
        if (!instance) break;
        if (
          step.referenceId !== undefined &&
          step.candidateId !== undefined &&
          (!instance.reference || !instance.candidate)
        ) {
          reopenedSide = instance.candidate ? "candidate" : "reference";
        }
        parent = await loadChildPair(parent, instance, controller.signal);
        nextPairs.push(parent);
        retainedSteps.push(step);
      }
      if (controller.signal.aborted || generation !== hierarchyGeneration.current) return;

      const popped = retainedSteps.length < requestedSteps.length;
      previousHierarchyPolicy.current = policy;
      setSlicePairs(nextPairs);
      setHierarchySteps(retainedSteps);
      setInlinePair(undefined);
      setInlineComparison(undefined);
      if (popped && inlineHierarchy) {
        setInlineHierarchy(false);
        setInlineTargetIdentity(undefined);
      }
      if (popped) {
        setStatusDetail(
          `${policy} matching returned to ${nextPairs.at(-1)?.candidate.module.instancePath ?? root.candidate.module.instancePath}; the remaining hierarchy path is not available under this policy`,
        );
      } else if (reopenedSide) {
        setStatusDetail(
          `${policy} matching reopened the visible hierarchy on the ${reopenedSide} side because the previous correspondence is not accepted`,
        );
      } else {
        setStatusDetail(`${policy} matching recomputed the visible hierarchy`);
      }
    };

    void reconcile()
      .catch((reason: unknown) => {
        if (controller.signal.aborted || generation !== hierarchyGeneration.current) return;
        previousHierarchyPolicy.current = policy;
        setSlicePairs([root]);
        setHierarchySteps([]);
        setInlinePair(undefined);
        setInlineComparison(undefined);
        setInlineHierarchy(false);
        setInlineTargetIdentity(undefined);
        setStatusDetail(
          `${policy} matching returned to the top module because the hierarchy could not be reopened: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === hierarchyGeneration.current) {
          hierarchyAbort.current = undefined;
          setHierarchyPolicyPending(false);
        }
      });
    return () => controller.abort();
  }, [comparePair, inlineHierarchy, loadChildPair, policy, setStatusDetail]);

  useEffect(() => {
    sourceEvidenceAbort.current?.abort();
    sourceEvidenceAbort.current = undefined;
    if (!rootPair || !selectedSource || !selectedSourceEvidenceKey) {
      setReachableSourceEvidence(undefined);
      return;
    }
    if (selectedSource.status === "unchanged" || selectedSource.status === "renamed") {
      setReachableSourceEvidence({ key: selectedSourceEvidenceKey, status: "absent" });
      return;
    }
    if (selectedTextDiff?.status !== "complete") {
      setReachableSourceEvidence({ key: selectedSourceEvidenceKey, status: "checking" });
      return;
    }
    const cached = sourceEvidenceCache.current.get(selectedSourceEvidenceKey);
    if (cached !== undefined) {
      setReachableSourceEvidence({
        key: selectedSourceEvidenceKey,
        status: cached,
      });
      return;
    }

    const controller = new AbortController();
    sourceEvidenceAbort.current = controller;
    setReachableSourceEvidence({ key: selectedSourceEvidenceKey, status: "checking" });
    const referencePath =
      selectedSource.reference?.path ?? selectedSource.candidate?.path ?? "source";
    const candidatePath =
      selectedSource.candidate?.path ?? selectedSource.reference?.path ?? "source";
    void reachableHierarchyHasSchematicSourceEvidence(
      {
        root: rootPair,
        referencePath,
        candidatePath,
        referenceInventoryPaths,
        candidateInventoryPaths,
        comparePair: comparePairForSourceEvidence,
        loadChildPair,
      },
      controller.signal,
    )
      .then((status) => {
        if (controller.signal.aborted) return;
        sourceEvidenceCache.current.set(selectedSourceEvidenceKey, status);
        setReachableSourceEvidence({
          key: selectedSourceEvidenceKey,
          status,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // Failure to prove the absence of a graph effect must not create a source-only claim.
          setReachableSourceEvidence({ key: selectedSourceEvidenceKey, status: "unknown" });
        }
      });
    return () => controller.abort();
  }, [
    candidateInventoryPaths,
    comparePairForSourceEvidence,
    loadChildPair,
    referenceInventoryPaths,
    rootPair,
    selectedSource,
    selectedSourceEvidenceKey,
    selectedTextDiff,
  ]);

  useEffect(() => {
    if (hierarchyPolicyPending) return;
    const controller = new AbortController();
    const refreshAncestors = async () => {
      for (const pair of slicePairs.slice(0, -1)) {
        await comparePair(pair, controller.signal);
      }
    };
    void refreshAncestors().catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setStatusDetail(
          `Could not refresh comparison hierarchy: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    });
    return () => controller.abort();
  }, [comparePair, hierarchyPolicyPending, setStatusDetail, slicePairs]);

  const selectSourceForEntity = useCallback(
    (entity: ComparisonEntity<GraphNode | GraphEdge | GraphGroup> | undefined) => {
      for (const side of ["candidate", "reference"] as const) {
        const origin = originFor(entity, side);
        if (!origin) continue;
        const source = findUniquePathMatch(
          sources.filter((candidateSource) => candidateSource[side] !== undefined),
          origin.file,
          (candidateSource) => candidateSource[side]?.path ?? "",
        );
        if (!source) continue;
        setSelectedSourceId(source.id);
        setLeftPaneView("source");
        return;
      }
    },
    [sources],
  );

  const selectGraphEntity = useCallback(
    (id: string) => {
      setSourceHighlightedIds(new Set());
      setSelectedId(id);
      setSelectedOriginal(
        id === TOP_MODULE_ID ? undefined : originalSelectionForOverlay(schematicComparison, id),
      );
      selectSourceForEntity(comparisonEntity(schematicComparison, id));
    },
    [schematicComparison, selectSourceForEntity],
  );

  const statusDetailForPair = useCallback(
    (pair: SlicePair) =>
      `${reference.provider.fileName} → ${candidate.provider.fileName} · ${pair.candidate.module.instancePath || pair.reference.module.instancePath}`,
    [candidate.provider.fileName, reference.provider.fileName],
  );

  const openInstance = useCallback(
    (id: string) => {
      if (matchingPending) return;
      const entity = comparison.nodes.find((candidateEntity) => candidateEntity.id === id);
      if (!entity || (!entity.reference && !entity.candidate)) return;
      const hierarchyStep = comparisonInstanceIdentity(entity);
      hierarchyGeneration.current += 1;
      const generation = hierarchyGeneration.current;
      hierarchyAbort.current?.abort();
      const controller = new AbortController();
      hierarchyAbort.current = controller;
      setStatusDetail(
        `Loading ${entity.candidate?.definitionName ?? entity.reference?.definitionName ?? "module"} from both snapshots`,
      );
      void loadChildPair(displayPair, entity, controller.signal)
        .then((child) => {
          if (controller.signal.aborted || generation !== hierarchyGeneration.current) return;
          startTransition(() => {
            setSlicePairs((stack) => [...stack, child]);
            setHierarchySteps((steps) => [...steps, hierarchyStep]);
            setInlinePair(undefined);
            setInlineComparison(undefined);
            setInlineHierarchy(false);
            setInlineTargetIdentity(undefined);
            setFlattenDepth(0);
            setSelectedId("");
            setSelectedOriginal(undefined);
          });
          setStatusDetail(statusDetailForPair(child));
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setStatusDetail(
              `Could not open instance: ${reason instanceof Error ? reason.message : String(reason)}`,
            );
          }
        });
    },
    [comparison, displayPair, loadChildPair, matchingPending, setStatusDetail, statusDetailForPair],
  );

  const goUp = useCallback(() => {
    if (slicePairs.length <= 1) return;
    hierarchyGeneration.current += 1;
    hierarchyAbort.current?.abort();
    const parent = slicePairs.at(-2);
    setSlicePairs((stack) => stack.slice(0, -1));
    setHierarchySteps((steps) => steps.slice(0, -1));
    setInlinePair(undefined);
    setInlineComparison(undefined);
    setInlineHierarchy(false);
    setInlineTargetIdentity(undefined);
    setFlattenDepth(0);
    setSelectedId("");
    setSelectedOriginal(undefined);
    if (parent) setStatusDetail(statusDetailForPair(parent));
  }, [setStatusDetail, slicePairs, statusDetailForPair]);

  const goTop = useCallback(() => {
    const top = slicePairs[0];
    if (!top) return;
    hierarchyGeneration.current += 1;
    hierarchyAbort.current?.abort();
    setSlicePairs([top]);
    setHierarchySteps([]);
    setInlinePair(undefined);
    setInlineComparison(undefined);
    setInlineHierarchy(false);
    setInlineTargetIdentity(undefined);
    setFlattenDepth(0);
    setSelectedId(TOP_MODULE_ID);
    setSelectedOriginal(undefined);
    setStatusDetail(statusDetailForPair(top));
  }, [setStatusDetail, slicePairs, statusDetailForPair]);

  const hierarchyDiffStatus = useCallback(
    (parentUnion: GraphSlice, instance: GraphNode | undefined) => {
      const entry = comparisonByUnion.current.get(parentUnion);
      if (!entry) return undefined;
      if (!instance) return topModuleDiffStatus(entry.pair);
      return entry.comparison.nodes.find((entity) => entity.id === instance.id)?.status;
    },
    [],
  );

  const buildHierarchyChangeIndex = useCallback(
    async (root: ComparisonStackEntry, signal: AbortSignal): Promise<HierarchyChangeIndex> => {
      const byInstanceIdentity = new Map<string, DescendantChangeStatus>();
      const completedPairStatuses = new Map<string, DescendantChangeStatus>();
      const childStatuses = new Map<string, DescendantChangeStatus>();
      const activePairs = new Set<string>();
      const operation = new AbortController();
      let complete = true;
      let visitedPairs = 0;
      let timedOut = false;

      const abortForCaller = () => operation.abort(signal.reason);
      if (signal.aborted) abortForCaller();
      else signal.addEventListener("abort", abortForCaller, { once: true });
      const timeout = globalThis.setTimeout(() => {
        timedOut = true;
        complete = false;
        operation.abort(new DOMException("Hierarchy change traversal timed out", "TimeoutError"));
      }, RESOURCE_LIMITS.browser.comparison.sourceEvidenceTimeoutMs);

      const evaluatePair = async (
        pair: SlicePair,
        compared: ComparisonSlice,
      ): Promise<DescendantChangeStatus> => {
        if (signal.aborted) throw hierarchyAbortError();
        if (operation.signal.aborted) {
          complete = false;
          return "unknown";
        }

        const pairKey = hierarchyChangePairKey(pair, policy);
        const completed = completedPairStatuses.get(pairKey);
        if (completed !== undefined) return completed;
        if (activePairs.has(pairKey)) {
          complete = false;
          return "unknown";
        }
        if (visitedPairs >= RESOURCE_LIMITS.browser.comparison.sourceEvidenceModulePairs) {
          complete = false;
          return "unknown";
        }

        visitedPairs += 1;
        activePairs.add(pairKey);
        let status: DescendantChangeStatus =
          topModuleDiffStatus(pair) !== "unchanged" ||
          allEntities(compared).some((entity) => entity.status !== "unchanged")
            ? "contains"
            : "none";
        const children = compared.nodes
          .filter(
            (entity) =>
              entity.reference?.kind === "module" &&
              Boolean(entity.reference.definitionName) &&
              entity.candidate?.kind === "module" &&
              Boolean(entity.candidate.definitionName),
          )
          .sort((left, right) => compareCodeUnits(left.id, right.id));

        try {
          for (const child of children) {
            if (signal.aborted) throw hierarchyAbortError();
            const instanceKey = hierarchyChangeInstanceKey(pair, child, policy);
            const childKey = hierarchyChangeChildKey(pair, child, policy);
            let childStatus = childStatuses.get(childKey);
            if (childStatus === undefined) {
              if (operation.signal.aborted) {
                complete = false;
                childStatus = "unknown";
              } else {
                try {
                  const childPair = await loadChildPair(pair, child, operation.signal);
                  const childComparison = await comparePair(childPair, operation.signal);
                  childStatus = await evaluatePair(childPair, childComparison);
                } catch (reason) {
                  if (signal.aborted) throw reason;
                  complete = false;
                  childStatus = "unknown";
                }
              }
              childStatuses.set(childKey, childStatus);
            }
            byInstanceIdentity.set(instanceKey, childStatus);
            status = mergeDescendantChangeStatus(status, childStatus);
          }
        } finally {
          activePairs.delete(pairKey);
        }
        completedPairStatuses.set(pairKey, status);
        return status;
      };

      try {
        await evaluatePair(root.pair, root.comparison);
      } catch (reason) {
        if (signal.aborted) throw reason;
        complete = false;
      } finally {
        globalThis.clearTimeout(timeout);
        signal.removeEventListener("abort", abortForCaller);
      }
      if (timedOut) complete = false;
      return { byInstanceIdentity, complete };
    },
    [comparePair, loadChildPair, policy],
  );

  const hierarchyRootUnion = stackEntries[0]?.comparison.union ?? comparison.union;
  const hierarchyDescendantChanges = useCallback(
    async (parentUnion: GraphSlice, node: GraphNode, signal: AbortSignal) => {
      const parent = comparisonByUnion.current.get(parentUnion);
      if (!parent) return "unknown";
      const entity = parent.comparison.nodes.find(
        (candidateEntity) => candidateEntity.id === node.id,
      );
      if (
        entity?.reference?.kind !== "module" ||
        !entity.reference.definitionName ||
        entity.candidate?.kind !== "module" ||
        !entity.candidate.definitionName
      ) {
        return "none";
      }

      const root = comparisonByUnion.current.get(hierarchyRootUnion);
      if (!root) return "unknown";
      let requestsForRoot = hierarchyChangeRequests.current.get(hierarchyRootUnion);
      if (!requestsForRoot) {
        requestsForRoot = new Map();
        hierarchyChangeRequests.current.set(hierarchyRootUnion, requestsForRoot);
      }
      let request = requestsForRoot.get(policy);
      if (!request) {
        const controller = new AbortController();
        const promise = buildHierarchyChangeIndex(root, controller.signal);
        request = { controller, promise, waiters: 0, settled: false };
        requestsForRoot.set(policy, request);
        const createdRequest = request;
        void promise.then(
          () => {
            createdRequest.settled = true;
          },
          () => {
            createdRequest.settled = true;
            if (requestsForRoot?.get(policy) === createdRequest) {
              requestsForRoot.delete(policy);
              if (requestsForRoot.size === 0) {
                hierarchyChangeRequests.current.delete(hierarchyRootUnion);
              }
            }
          },
        );
      }

      const activeRequest = request;
      const index = await waitForHierarchyChangeRequest(activeRequest, signal, () => {
        if (requestsForRoot?.get(policy) === activeRequest) {
          requestsForRoot.delete(policy);
          if (requestsForRoot.size === 0) {
            hierarchyChangeRequests.current.delete(hierarchyRootUnion);
          }
        }
        activeRequest.controller.abort(hierarchyAbortError());
      });
      return (
        index.byInstanceIdentity.get(hierarchyChangeInstanceKey(parent.pair, entity, policy)) ??
        (index.complete ? "none" : "unknown")
      );
    },
    [buildHierarchyChangeIndex, hierarchyRootUnion, policy],
  );

  const loadHierarchyChild = useCallback(
    async (parentUnion: GraphSlice, node: GraphNode, signal: AbortSignal) => {
      const parent = comparisonByUnion.current.get(parentUnion);
      if (!parent) throw new Error("Comparison hierarchy context is stale");
      const entity = parent.comparison.nodes.find(
        (candidateEntity) => candidateEntity.id === node.id,
      );
      if (!entity) throw new Error(`Comparison instance ${node.label} is unavailable`);
      const pair = await loadChildPair(parent.pair, entity, signal);
      const childComparison = await comparePair(pair, signal);
      const entry = {
        pair,
        comparison: childComparison,
        via: comparisonInstanceIdentity(entity),
      };
      comparisonByUnion.current.set(childComparison.union, entry);
      return childComparison.union;
    },
    [comparePair, loadChildPair],
  );

  const navigateHierarchy = useCallback(
    (stack: GraphSlice[]) => {
      const entries = stack.map((slice) => comparisonByUnion.current.get(slice));
      if (entries.some((entry) => !entry)) {
        setStatusDetail("Could not navigate stale comparison hierarchy");
        return;
      }
      hierarchyGeneration.current += 1;
      hierarchyAbort.current?.abort();
      const resolvedEntries = entries as ComparisonStackEntry[];
      const steps = resolvedEntries.slice(1).map((entry) => entry.via);
      if (steps.some((step) => !step)) {
        setStatusDetail("Could not navigate hierarchy without stable instance identity");
        return;
      }
      setSlicePairs(resolvedEntries.map((entry) => entry.pair));
      setHierarchySteps(steps as ComparisonInstanceIdentity[]);
      setInlinePair(undefined);
      setInlineComparison(undefined);
      setInlineHierarchy(false);
      setInlineTargetIdentity(undefined);
      setFlattenDepth(0);
      setSelectedId(stack.length === 1 ? TOP_MODULE_ID : "");
      setSelectedOriginal(undefined);
    },
    [setStatusDetail],
  );

  useEffect(() => {
    if (hierarchyPolicyPending) return;
    if (!inlineHierarchy && flattenDepth === 0) {
      setInlinePair(undefined);
      setInlineComparison(undefined);
      setProjectionPending(false);
      return;
    }
    const controller = new AbortController();
    setProjectionPending(true);
    const recursivelyProject = async (
      pair: SlicePair,
      base: ComparisonSlice,
      depth: number,
    ): Promise<ComparisonSlice> => {
      if (depth <= 0) return base;
      const instances = base.nodes
        .filter(
          (entity) =>
            (entity.reference?.kind === "module" && entity.reference.definitionName) ||
            (entity.candidate?.kind === "module" && entity.candidate.definitionName),
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id));
      let projected = base;
      for (const original of instances) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        const instance = projected.nodes.find((entity) => entity.id === original.id);
        if (!instance) continue;
        const childPair = await loadChildPair(pair, instance, controller.signal);
        const child = await comparePair(childPair, controller.signal);
        const projectedChild = await recursivelyProject(childPair, child, depth - 1);
        projected = expandComparisonInstance(projected, instance, projectedChild);
      }
      return projected;
    };

    let selectedFlattenSide: Side | "paired" | undefined;
    void comparePair(basePair, controller.signal)
      .then(async (base) => {
        const target =
          flattenDepth === 0 && inlineTargetIdentity
            ? comparisonInstanceForIdentity(base, inlineTargetIdentity)
            : undefined;
        if (flattenDepth === 0 && !target) {
          throw new Error("Right-click a module instance before flattening it");
        }
        selectedFlattenSide = target
          ? target.reference && target.candidate
            ? "paired"
            : target.candidate
              ? "candidate"
              : "reference"
          : undefined;
        setStatusDetail(
          target
            ? `Flattening ${target.candidate?.label ?? target.reference?.label ?? "instance"} through its compared child`
            : `Recursively comparing and flattening both snapshots to depth ${flattenDepth}`,
        );
        if (!target) return recursivelyProject(basePair, base, flattenDepth);
        const childPair = await loadChildPair(basePair, target, controller.signal);
        const child = await comparePair(childPair, controller.signal);
        return expandComparisonInstance(base, target, child);
      })
      .then((projected) => {
        if (controller.signal.aborted) return;
        setInlineComparison(projected);
        setInlinePair({
          reference: projected.reference,
          candidate: projected.candidate,
          referencePresent: basePair.referencePresent,
          candidatePresent: basePair.candidatePresent,
        });
        setStatusDetail(
          flattenDepth === 0 && selectedFlattenSide && selectedFlattenSide !== "paired"
            ? `${policy} matching flattened the selected instance on the ${selectedFlattenSide} side because no paired correspondence is accepted`
            : `${reference.provider.fileName} → ${candidate.provider.fileName} · ${flattenDepth > 0 ? `flattened depth ${flattenDepth}` : "flattened selection"}`,
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setInlinePair(undefined);
        setInlineComparison(undefined);
        setInlineHierarchy(false);
        setFlattenDepth(0);
        setStatusDetail(
          `Could not flatten comparison: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectionPending(false);
      });
    return () => controller.abort();
  }, [
    basePair,
    comparePair,
    flattenDepth,
    hierarchyPolicyPending,
    inlineHierarchy,
    inlineTargetIdentity,
    loadChildPair,
    policy,
    candidate.provider.fileName,
    reference.provider.fileName,
    setStatusDetail,
  ]);

  const selectSource = useCallback(
    (path: string, fileId?: string) => {
      const source =
        (fileId ? sources.find((candidateSource) => candidateSource.id === fileId) : undefined) ??
        findUniquePathMatch(
          sources,
          path,
          (candidateSource) =>
            candidateSource.candidate?.path ?? candidateSource.reference?.path ?? "",
        );
      if (source) {
        setSourceHighlightedIds(new Set());
        setSelectedSourceId(source.id);
      }
    },
    [sources],
  );

  const selectSourceRange = useCallback(
    (
      side: DiffSourceSide,
      startLine: number,
      startColumn: number,
      endLine: number,
      endColumn: number,
    ) => {
      const version = sourcePair[side];
      if (!version.path || version.loading || version.error) return;
      const changedIds = matchingPending
        ? []
        : changedComparisonEntitiesForSourceRange(
            comparison,
            side,
            version.path,
            startLine,
            endLine,
            sources.flatMap((source) => (source[side] ? [source[side].path] : [])),
          );
      setSourceHighlightedIds(new Set(changedIds));
      const firstChanged = changedIds[0] ? comparisonEntity(comparison, changedIds[0]) : undefined;
      const firstOriginal = firstChanged?.[side];
      const firstKind = changedIds[0] ? comparisonEntityKind(comparison, changedIds[0]) : undefined;
      if (firstChanged && firstOriginal && firstKind) {
        setSelectedId(firstChanged.id);
        setSelectedOriginal({ side, kind: firstKind, id: firstOriginal.id });
        return;
      }
      const originalId = entityForSourceSelection(displayPair[side], version.path, version.source, {
        startLine,
        startColumn,
        endLine,
        endColumn,
      });
      if (!originalId) return;
      const entity = allEntities(comparison).find(
        (candidateEntity) => candidateEntity[side]?.id === originalId,
      );
      const kind = entity ? comparisonEntityKind(comparison, entity.id) : undefined;
      if (entity && kind) {
        setSelectedId(entity.id);
        setSelectedOriginal({ side, kind, id: originalId });
      }
    },
    [comparison, displayPair, matchingPending, sourcePair, sources],
  );

  const selectedEntity = comparisonEntity(schematicComparison, selectedId);
  const hoveredEntity = hoveredId ? comparisonEntity(schematicComparison, hoveredId) : undefined;
  const focusedEntity = hoveredEntity ?? selectedEntity;
  const referenceOrigin = originFor(focusedEntity, "reference");
  const candidateOrigin = originFor(focusedEntity, "candidate");
  const displayedSourcePair = useMemo<LoadedSourcePair>(
    () => ({
      reference: {
        ...sourcePair.reference,
        origin:
          referenceOrigin && pathsReferToSameFile(referenceOrigin.file, sourcePair.reference.path)
            ? referenceOrigin
            : undefined,
      },
      candidate: {
        ...sourcePair.candidate,
        origin:
          candidateOrigin && pathsReferToSameFile(candidateOrigin.file, sourcePair.candidate.path)
            ? candidateOrigin
            : undefined,
      },
    }),
    [candidateOrigin, referenceOrigin, sourcePair],
  );
  const sourceDiffHunks = useMemo<readonly ClassifiedSourceDiffHunk[]>(() => {
    if (matchingPending || selectedTextDiff?.status !== "complete") return [];
    const classified = classifySourceDiffHunks(
      comparison,
      displayedSourcePair.reference.path,
      displayedSourcePair.candidate.path,
      changedSourceHunks(selectedTextDiff),
      referenceInventoryPaths,
      candidateInventoryPaths,
    );
    const hierarchyProvesNoEffect =
      reachableSourceEvidence?.key === selectedSourceEvidenceKey &&
      reachableSourceEvidence.status === "absent";
    return hierarchyProvesNoEffect
      ? classified
      : classified.map((hunk) => ({ ...hunk, sourceOnly: false }));
  }, [
    candidateInventoryPaths,
    comparison,
    displayedSourcePair,
    matchingPending,
    reachableSourceEvidence,
    referenceInventoryPaths,
    selectedSourceEvidenceKey,
    selectedTextDiff,
  ]);
  const sourceDiffNotice = useMemo(() => {
    if (selectedTextDiffError) {
      return `Text diff unavailable (${selectedTextDiffError}); schematic comparison continues.`;
    }
    if (selectedTextDiff?.status !== "tooLarge") return undefined;
    const reason =
      selectedTextDiff.reason === "timeout"
        ? "time limit exceeded"
        : selectedTextDiff.reason === "editLength"
          ? "edit limit exceeded"
          : "source size limit exceeded";
    return `Text diff too large (${reason}); schematic comparison continues.`;
  }, [selectedTextDiff, selectedTextDiffError]);

  const selectedNodeRecord = schematicComparison.nodes.find((node) => node.id === selectedId);
  const selectedEdgeRecord = schematicComparison.edges.find((edge) => edge.id === selectedId);
  const selectedGroupRecord = schematicComparison.groups.find((group) => group.id === selectedId);
  const selectedNode = schematicSemanticSide
    ? selectedNodeRecord?.[schematicSemanticSide]
    : schematicComparison.union.nodes.find((node) => node.id === selectedId);
  const selectedEdge = schematicSemanticSide
    ? selectedEdgeRecord?.[schematicSemanticSide]
    : schematicComparison.union.edges.find((edge) => edge.id === selectedId);
  const selectedGroup = schematicSemanticSide
    ? selectedGroupRecord?.[schematicSemanticSide]
    : schematicComparison.union.groups?.find((group) => group.id === selectedId);
  const inspectorTopModule = schematicSemanticSide
    ? schematicComparison[schematicSemanticSide].module
    : schematicComparison.union.module;
  const inspectorProject =
    schematicSemanticSide === "reference"
      ? reference.workspace.project
      : candidate.workspace.project;
  const topModuleStatus = topModuleDiffStatus(displayPair);
  const inspectorNode =
    selectedNode ??
    (selectedGroup
      ? {
          id: selectedGroup.id,
          kind: "module" as const,
          label: selectedGroup.name,
          definitionName: selectedGroup.definitionName,
          parameters: selectedGroup.parameters,
          ports: [],
          origins: selectedGroup.origins,
        }
      : selectedId === TOP_MODULE_ID
        ? {
            id: inspectorTopModule.id,
            kind: "module" as const,
            label: inspectorTopModule.name,
            definitionName: inspectorTopModule.definitionName,
            parameters: inspectorTopModule.parameters,
            ports: [],
          }
        : undefined);
  const selectionComparison = useMemo<ComparisonSelectionDetails | undefined>(() => {
    if (selectedId === TOP_MODULE_ID) {
      return {
        status: topModuleStatus,
        policy: schematicComparison.policy,
        reference: displayPair.referencePresent
          ? {
              id: displayPair.reference.module.id,
              label: displayPair.reference.module.name,
              kind: "module",
              definitionName: displayPair.reference.module.definitionName,
              parameters: displayPair.reference.module.parameters,
            }
          : undefined,
        candidate: displayPair.candidatePresent
          ? {
              id: displayPair.candidate.module.id,
              label: displayPair.candidate.module.name,
              kind: "module",
              definitionName: displayPair.candidate.module.definitionName,
              parameters: displayPair.candidate.module.parameters,
            }
          : undefined,
      };
    }
    if (!selectedEntity) return undefined;
    return {
      status: selectedEntity.status,
      policy: schematicComparison.policy,
      matchMethod: selectedEntity.match?.method,
      confidence: selectedEntity.match?.confidence,
      reference: snapshot(selectedEntity.reference),
      candidate: snapshot(selectedEntity.candidate),
    };
  }, [displayPair, schematicComparison.policy, selectedEntity, selectedId, topModuleStatus]);

  const presentationEntities = useMemo(() => {
    const records: Record<string, EntityDiffPresentation | undefined> = {};
    for (const entity of allEntities(schematicComparison)) {
      records[entity.id] = {
        ...entityPresentation(entity),
        sourceHighlighted: sourceHighlightedIds.has(entity.id),
      };
    }
    records[TOP_MODULE_ID] = {
      status: topModuleStatus,
      referenceId: displayPair.referencePresent
        ? schematicComparison.reference.module.id
        : undefined,
      candidateId: displayPair.candidatePresent
        ? schematicComparison.candidate.module.id
        : undefined,
    };
    return records;
  }, [displayPair, schematicComparison, sourceHighlightedIds, topModuleStatus]);
  const comparisonCounts = useMemo(() => {
    const counts = { unchanged: 0, added: 0, removed: 0, modified: 0, heuristic: 0 };
    for (const entity of allEntities(schematicComparison)) {
      counts[entity.status] += 1;
      if (entity.match?.method === "heuristic") counts.heuristic += 1;
    }
    if (topModuleStatus !== "unchanged") counts[topModuleStatus] += 1;
    return counts;
  }, [schematicComparison, topModuleStatus]);
  const sourceChangeCount = useMemo(
    () => sources.filter((source) => source.status !== "unchanged").length,
    [sources],
  );
  const warnings = useMemo(() => {
    const next = compatibilityWarnings(reference, candidate);
    const overlapWarning =
      matchingPending || currentComparisonFailure
        ? undefined
        : lowSchematicOverlapWarning(comparison);
    if (overlapWarning) next.push(overlapWarning);
    return next;
  }, [candidate, comparison, currentComparisonFailure, matchingPending, reference]);
  const changedCount =
    comparisonCounts.added + comparisonCounts.removed + comparisonCounts.modified;

  const toggleLabel = useCallback((key: keyof LabelSettings) => {
    setLabelSettings((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const clampSourcePaneWidth = useCallback((requestedWidth: number, divider: HTMLElement) => {
    const workspace = divider.parentElement;
    const fileTree = workspace?.querySelector<HTMLElement>(".file-tree");
    if (!workspace) return requestedWidth;
    const fileTreeWidth = fileTree?.getBoundingClientRect().width ?? 0;
    const availableWidth = workspace.getBoundingClientRect().width - fileTreeWidth;
    return Math.min(Math.max(requestedWidth, 250), Math.max(250, availableWidth - 420));
  }, []);

  const resizeSourcePaneBy = useCallback(
    (divider: HTMLElement, delta: number) => {
      const currentWidth =
        sourcePaneWidth ??
        divider.parentElement?.querySelector<HTMLElement>(".source-pane")?.getBoundingClientRect()
          .width ??
        320;
      setSourcePaneWidth(clampSourcePaneWidth(currentWidth + delta, divider));
    },
    [clampSourcePaneWidth, sourcePaneWidth],
  );

  return (
    <>
      <AppHeader
        projectName={`${reference.provider.fileName} → ${candidate.provider.fileName}`}
        statusText={`${changedCount} current-slice schematic changes`}
        dataMode="comparison"
        statusDetail={statusDetail}
        comparison={{
          referenceName: reference.provider.fileName,
          candidateName: candidate.provider.fileName,
          policy,
          sourceChanges: sourceChangeCount,
          heuristicMatches: schematicComparison.heuristicMatchCount,
        }}
        onOpenProject={onOpenBundle}
        onCompareBundles={onCompareBundles}
        onSearch={() => setUtilityDialog("search")}
        onHelp={() => setUtilityDialog("help")}
      />
      <ProjectSearchDialog
        open={utilityDialog === "search"}
        files={files}
        slice={schematicComparison.union}
        onClose={() => setUtilityDialog(undefined)}
        onSelectFile={selectSource}
        onSelectEntity={selectGraphEntity}
      />
      <HelpDialog open={utilityDialog === "help"} onClose={() => setUtilityDialog(undefined)} />
      <main
        className={`workspace${inspectorOpen ? " inspector-visible" : ""}`}
        style={
          sourcePaneWidth === undefined
            ? undefined
            : ({ "--source-pane-width": `${sourcePaneWidth}px` } as CSSProperties)
        }
      >
        <FileTree
          entries={files}
          selectedPath={selectedSource ? pathForSourceComparison(selectedSource) : ""}
          statusByPath={statusByPath}
          onSelect={selectSource}
        />
        {leftPaneView === "source" ? (
          <Suspense fallback={<div className="pane-loading">Loading source diff…</div>}>
            <DiffSourcePane
              reference={displayedSourcePair.reference}
              candidate={displayedSourcePair.candidate}
              status={selectedSource ? sourceStatus(selectedSource.status) : "unchanged"}
              hunks={sourceDiffHunks}
              notice={sourceDiffNotice}
              suppressDiff={selectedTextDiff?.status === "tooLarge"}
              onShowHierarchy={() => setLeftPaneView("hierarchy")}
              onSelectRange={selectSourceRange}
            />
          </Suspense>
        ) : (
          <InstanceHierarchy
            key={`${policy}:${stackEntries[0]?.comparison.union.snapshotId ?? "root"}`}
            root={stackEntries[0]?.comparison.union ?? comparison.union}
            activeInstancePath={currentStackEntry.comparison.union.module.instancePath}
            loadChild={loadHierarchyChild}
            onNavigate={navigateHierarchy}
            onShowSource={() => setLeftPaneView("source")}
            diffStatusFor={hierarchyDiffStatus}
            descendantChangesFor={hierarchyDescendantChanges}
          />
        )}
        <hr
          className="pane-divider"
          aria-label="Resize source and schematic panes"
          aria-orientation="vertical"
          aria-valuemin={250}
          aria-valuenow={sourcePaneWidth === undefined ? undefined : Math.round(sourcePaneWidth)}
          tabIndex={0}
          onDoubleClick={() => setSourcePaneWidth(undefined)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resizeSourcePaneBy(event.currentTarget, event.key === "ArrowLeft" ? -16 : 16);
            } else if (event.key === "Home") {
              event.preventDefault();
              setSourcePaneWidth(undefined);
            }
          }}
          onPointerDown={(event) => {
            const sourcePane =
              event.currentTarget.parentElement?.querySelector<HTMLElement>(".source-pane");
            if (!sourcePane) return;
            resizePointer.current = {
              id: event.pointerId,
              startX: event.clientX,
              startWidth: sourcePane.getBoundingClientRect().width,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = resizePointer.current;
            if (!drag || drag.id !== event.pointerId) return;
            setSourcePaneWidth(
              clampSourcePaneWidth(
                drag.startWidth + event.clientX - drag.startX,
                event.currentTarget,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (resizePointer.current?.id === event.pointerId) resizePointer.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={() => {
            resizePointer.current = undefined;
          }}
        />
        <Suspense fallback={<div className="pane-loading">Loading comparison schematic…</div>}>
          <SchematicCanvas
            slice={schematicComparison.union}
            selectedId={selectedId}
            focusEntityId={selectedId}
            focusEntityRevision={policyFocusRevision}
            onSelect={selectGraphEntity}
            onHover={setHoveredId}
            onOpenInstance={openInstance}
            canGoUp={slicePairs.length > 1}
            onGoUp={goUp}
            onGoTop={goTop}
            labelSettings={labelSettings}
            onToggleLabel={toggleLabel}
            flattenDepth={flattenDepth}
            onFlattenDepthChange={(depth) => {
              if (depth === 0) {
                setInlinePair(undefined);
                setInlineComparison(undefined);
                setStatusDetail(statusDetailForPair(basePair));
              }
              setProjectionPending(depth > 0);
              setInlineHierarchy(false);
              setInlineTargetIdentity(undefined);
              setFlattenDepth(depth);
            }}
            flattenRenderMode={flattenRenderMode}
            onFlattenRenderModeChange={setFlattenRenderMode}
            layoutProfile={layoutProfile}
            onLayoutProfileChange={setLayoutProfile}
            constantRadix={constantRadix}
            onConstantRadixChange={setConstantRadix}
            onFlattenInstance={(id) => {
              const target = schematicComparison.nodes.find((entity) => entity.id === id);
              if (!target) {
                setStatusDetail("Could not retain the selected instance identity for flattening");
                return;
              }
              setInlinePair(undefined);
              setInlineComparison(undefined);
              setProjectionPending(true);
              setFlattenDepth(0);
              setInlineTargetIdentity(comparisonInstanceIdentity(target));
              setInlineHierarchy(true);
            }}
            onRestoreInstance={() => {
              setInlinePair(undefined);
              setInlineComparison(undefined);
              setProjectionPending(false);
              setInlineHierarchy(false);
              setInlineTargetIdentity(undefined);
              setFlattenDepth(0);
              setStatusDetail(statusDetailForPair(basePair));
            }}
            individuallyFlattened={inlineHierarchy}
            topLevelDefines={candidate.workspace.project.effectiveElaboration.defines}
            inspectorOpen={inspectorOpen}
            onToggleInspector={() => setInspectorOpen((value) => !value)}
            comparison={{
              referenceName: reference.provider.fileName,
              candidateName: candidate.provider.fileName,
              policy,
              onPolicyChange: setPolicy,
              entities: presentationEntities,
              counts: comparisonCounts,
              comparisonSlice: schematicComparison,
              referenceDefines: reference.workspace.project.effectiveElaboration.defines,
              candidateDefines: candidate.workspace.project.effectiveElaboration.defines,
              onSemanticSideChange: setSchematicSemanticSide,
            }}
            warnings={warnings}
            busy={matchingPending || Boolean(currentComparisonFailure)}
          />
        </Suspense>
        {matchingPending || currentComparisonFailure ? (
          <output
            className={`comparison-matching-status${currentComparisonFailure ? " error" : ""}`}
            aria-live="polite"
          >
            {currentComparisonFailure
              ? `Schematic comparison failed: ${currentComparisonFailure.message}`
              : `Computing ${policy} schematic correspondence…`}
            {currentComparisonFailure ? (
              <button
                type="button"
                onClick={() => {
                  setFailedComparison(undefined);
                  setRetryRevision((revision) => revision + 1);
                }}
              >
                Retry
              </button>
            ) : null}
          </output>
        ) : null}
        {inspectorOpen ? (
          <Inspector
            node={inspectorNode}
            edge={selectedEdge}
            project={inspectorProject}
            topModule={inspectorTopModule}
            comparison={selectionComparison}
            onClose={() => setInspectorOpen(false)}
          />
        ) : null}
      </main>
    </>
  );
}
