// SPDX-License-Identifier: Apache-2.0

import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  findSourceReference,
  firstSourceReference,
  type LoadedWorkspace,
  normalizeGraphSlice,
  normalizePath,
  pathsReferToSameFile,
} from "./api/normalize";
import { loadWorkspace } from "./api/workspace";
import { LocalBundleProvider } from "./bundle/provider";
import { AppHeader } from "./components/AppHeader";
import { FileTree } from "./components/FileTree";
import { HelpDialog, ProjectSearchDialog } from "./components/HeaderDialogs";
import { Inspector } from "./components/Inspector";
import { InstanceHierarchy } from "./components/InstanceHierarchy";
import { BundleWelcome, OpenBundleDialog } from "./components/OpenBundle";
import type { ConstantRadix } from "./graph/constant-format";
import { TOP_MODULE_ID } from "./graph/constants";
import type { LayoutProfile } from "./graph/layout-profile";
import type { FlattenRenderMode } from "./graph/layout-types";
import type { LabelSettings } from "./graph/SchematicCanvas";
import type { GraphNode, GraphSlice, SourceFileRef } from "./model/graph";
import { entityForSourceSelection } from "./source/cross-probe";

interface SourceView {
  path: string;
  source: string;
  state: "ready" | "loading" | "error";
  message?: string;
}

interface OpenedBundle {
  provider: LocalBundleProvider;
  workspace: LoadedWorkspace;
}

type UtilityDialog = "search" | "help";

const SourcePane = lazy(() =>
  import("./components/SourcePane").then((module) => ({ default: module.SourcePane })),
);
const SchematicCanvas = lazy(() =>
  import("./graph/SchematicCanvas").then((module) => ({ default: module.SchematicCanvas })),
);

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
  const containingGroup = parent.groups?.find((group) => group.childNodeIds.includes(node.id));
  return contextualizeChild(
    containingGroup
      ? {
          ...parent,
          module: {
            ...parent.module,
            instancePath: `${parent.module.instancePath}.${containingGroup.name}`,
          },
        }
      : parent,
    child,
    node,
  );
};

const defaultSelection = (slice: GraphSlice) =>
  slice.nodes.find((node) => node.kind === "operator")?.id ?? slice.nodes[0]?.id ?? "";

export default function App() {
  const [opened, setOpened] = useState<OpenedBundle>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [statusDetail, setStatusDetail] = useState("No bundle is open");
  const generation = useRef(0);
  const startupRequested = useRef(false);

  const openBundle = useCallback(async (file: File) => {
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    setStatusDetail(`Validating ${file.name} in this browser`);
    try {
      const provider = await LocalBundleProvider.open(file);
      const workspace = await loadWorkspace(provider);
      if (request !== generation.current) return;
      setOpened({ provider, workspace });
      setDialogOpen(false);
      setStatusDetail(`Local snapshot ${workspace.slice.snapshotId}`);
    } catch (reason) {
      if (request !== generation.current) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setStatusDetail(`Could not open ${file.name}: ${message}`);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);

  const openDialog = useCallback(() => {
    setError(undefined);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (startupRequested.current) return;
    startupRequested.current = true;
    const controller = new AbortController();
    void fetch("/startup.nettle", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`startup bundle request failed (${response.status})`);
        if (response.headers.get("content-type")?.includes("text/html")) return;
        const bytes = await response.blob();
        await openBundle(
          new File([bytes], "startup.nettle", {
            type: response.headers.get("content-type") ?? "application/octet-stream",
          }),
        );
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setStatusDetail(`Could not load startup bundle: ${message}`);
      });
    return () => {
      controller.abort();
      startupRequested.current = false;
    };
  }, [openBundle]);

  return (
    <div
      className="app-shell"
      role="application"
      aria-label="Nettle RTL topology viewer"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const file = event.dataTransfer.files[0];
        if (!file) return;
        event.preventDefault();
        void openBundle(file);
      }}
    >
      {opened ? (
        <WorkspaceView
          key={`${opened.provider.fileName}:${opened.workspace.slice.snapshotId}`}
          provider={opened.provider}
          initial={opened.workspace}
          statusDetail={statusDetail}
          setStatusDetail={setStatusDetail}
          onOpenBundle={openDialog}
        />
      ) : (
        <>
          <AppHeader
            projectName="Open .nettle bundle"
            statusText={loading ? "Validating bundle…" : "No bundle open"}
            dataMode={loading ? "loading" : "empty"}
            statusDetail={statusDetail}
            onOpenProject={openDialog}
            onSearch={() => undefined}
            onHelp={() => undefined}
          />
          <BundleWelcome
            loading={loading}
            error={error}
            onSelect={(file) => void openBundle(file)}
          />
        </>
      )}
      <OpenBundleDialog
        open={dialogOpen}
        loading={loading}
        error={error}
        onClose={() => {
          if (!loading) setDialogOpen(false);
        }}
        onSelect={(file) => void openBundle(file)}
      />
    </div>
  );
}

interface WorkspaceViewProps {
  provider: LocalBundleProvider;
  initial: LoadedWorkspace;
  statusDetail: string;
  setStatusDetail: (detail: string) => void;
  onOpenBundle: () => void;
}

function WorkspaceView({
  provider,
  initial,
  statusDetail,
  setStatusDetail,
  onOpenBundle,
}: WorkspaceViewProps) {
  const [sourceView, setSourceView] = useState<SourceView>(() => ({
    path: normalizePath(initial.source?.path ?? "Source unavailable"),
    source: initial.source?.content ?? "",
    state: initial.source ? "ready" : "error",
    message: initial.sourceError ?? "This bundle has no source available for its initial module.",
  }));
  const [sliceStack, setSliceStack] = useState<GraphSlice[]>([initial.slice]);
  const [inlineSlice, setInlineSlice] = useState<GraphSlice>();
  const [selectedId, setSelectedId] = useState(() => defaultSelection(initial.slice));
  const [hoveredId, setHoveredId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inlineHierarchy, setInlineHierarchy] = useState(false);
  const [inlineTargetId, setInlineTargetId] = useState<string>();
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
  const resizePointer = useRef<{ id: number; startX: number; startWidth: number } | undefined>(
    undefined,
  );
  const sourceRequestGeneration = useRef(0);
  const sourceAbort = useRef<AbortController | undefined>(undefined);
  const currentSourceFileId = useRef(initial.source?.fileId);
  const hierarchyRequestGeneration = useRef(0);
  const hierarchyAbort = useRef<AbortController | undefined>(undefined);
  const [, startTransition] = useTransition();
  const slice = sliceStack.at(-1) ?? initial.slice;
  const activeSliceRef = useRef(slice);
  activeSliceRef.current = slice;

  const invalidateHierarchyRequests = useCallback(() => {
    hierarchyRequestGeneration.current += 1;
    hierarchyAbort.current?.abort();
    hierarchyAbort.current = undefined;
  }, []);

  useEffect(
    () => () => {
      sourceAbort.current?.abort();
      hierarchyAbort.current?.abort();
    },
    [],
  );

  const displaySlice = useMemo(
    () => ((inlineHierarchy || flattenDepth > 0) && inlineSlice ? inlineSlice : slice),
    [flattenDepth, inlineHierarchy, inlineSlice, slice],
  );

  useEffect(() => {
    setInlineSlice(undefined);
    if (!inlineHierarchy && flattenDepth === 0) return;
    const target =
      flattenDepth === 0
        ? slice.nodes.find((node) => node.id === inlineTargetId && node.kind === "module")
        : undefined;
    if (flattenDepth === 0 && !target) {
      setInlineHierarchy(false);
      setStatusDetail("Right-click a module instance before flattening it");
      return;
    }
    const controller = new AbortController();
    setStatusDetail(
      target
        ? `Flattening ${target.label} locally`
        : `Flattening every instance to depth ${flattenDepth} locally`,
    );
    void provider
      .getGraphSlice(
        {
          snapshotId: slice.snapshotId,
          moduleId: slice.module.id,
          transparentInstanceIds: target ? [target.id] : undefined,
          flattenDepth: flattenDepth || undefined,
        },
        controller.signal,
      )
      .then((response) => {
        if (controller.signal.aborted) return;
        const projected = normalizeGraphSlice(response);
        const contextualized = {
          ...projected,
          module: {
            ...projected.module,
            name: slice.module.name,
            instancePath: slice.module.instancePath,
          },
        };
        setInlineSlice(contextualized);
        setSelectedId((current) =>
          contextualized.nodes.some((node) => node.id === current) ||
          contextualized.edges.some((edge) => edge.id === current) ||
          contextualized.groups?.some((group) => group.id === current)
            ? current
            : "",
        );
        setStatusDetail(
          `Local snapshot ${contextualized.snapshotId} · ${contextualized.groups?.length ?? 0} flattened`,
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setInlineHierarchy(false);
        setFlattenDepth(0);
        setStatusDetail(
          `Could not flatten hierarchy: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
    return () => controller.abort();
  }, [flattenDepth, inlineHierarchy, inlineTargetId, provider, setStatusDetail, slice]);

  const selectedGroup = displaySlice.groups?.find((group) => group.id === selectedId);
  const selectedNode =
    (selectedId === TOP_MODULE_ID
      ? {
          id: slice.module.id,
          kind: "module" as const,
          label: slice.module.name,
          definitionName: slice.module.definitionName,
          parameters: slice.module.parameters,
          ports: [],
        }
      : displaySlice.nodes.find((node) => node.id === selectedId)) ??
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
      : undefined);
  const selectedEdge = displaySlice.edges.find((edge) => edge.id === selectedId);
  const hoveredNode = displaySlice.nodes.find((node) => node.id === hoveredId);
  const hoveredEdge = displaySlice.edges.find((edge) => edge.id === hoveredId);
  const hoveredGroup = displaySlice.groups?.find((group) => group.id === hoveredId);
  const selectedOrigin = selectedNode?.origins?.[0] ?? selectedEdge?.origins?.[0];
  const hoveredOrigin =
    hoveredNode?.origins?.[0] ?? hoveredEdge?.origins?.[0] ?? hoveredGroup?.origins?.[0];
  const focusedOrigin = hoveredOrigin ?? selectedOrigin;
  const visibleOrigin =
    focusedOrigin && pathsReferToSameFile(focusedOrigin.file, sourceView.path)
      ? focusedOrigin
      : undefined;

  const loadSourceReference = useCallback(
    async (reference: SourceFileRef) => {
      const generation = ++sourceRequestGeneration.current;
      sourceAbort.current?.abort();
      sourceAbort.current = undefined;
      currentSourceFileId.current = reference.id;
      const controller = new AbortController();
      sourceAbort.current = controller;
      setSourceView({
        path: normalizePath(reference.path),
        source: "",
        state: "loading",
      });
      try {
        const response = await provider.getSource(reference.id, controller.signal);
        if (generation !== sourceRequestGeneration.current) return;
        const loaded: SourceView = {
          path: normalizePath(response.path),
          source: response.content,
          state: "ready",
        };
        currentSourceFileId.current = response.fileId;
        setSourceView(loaded);
      } catch (reason) {
        if (controller.signal.aborted || generation !== sourceRequestGeneration.current) return;
        currentSourceFileId.current = undefined;
        setSourceView({
          path: normalizePath(reference.path),
          source: "",
          state: "error",
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    },
    [provider],
  );

  const selectSourcePath = useCallback(
    (path: string, fileId?: string) => {
      const normalized = normalizePath(path);
      const reference = fileId
        ? { id: fileId, path: normalized }
        : findSourceReference(normalized, displaySlice, initial.project.files);
      if (!reference) return;
      if (
        currentSourceFileId.current === reference.id &&
        pathsReferToSameFile(sourceView.path, normalized)
      ) {
        return;
      }
      void loadSourceReference(reference);
    },
    [displaySlice, initial.project.files, loadSourceReference, sourceView.path],
  );

  const selectGraphEntity = useCallback(
    (id: string) => {
      setSelectedId(id);
      const node = displaySlice.nodes.find((candidate) => candidate.id === id);
      const edge = displaySlice.edges.find((candidate) => candidate.id === id);
      const group = displaySlice.groups?.find((candidate) => candidate.id === id);
      const origin = node?.origins?.[0] ?? edge?.origins?.[0] ?? group?.origins?.[0];
      if (origin) selectSourcePath(origin.file);
    },
    [displaySlice, selectSourcePath],
  );

  const openInstance = useCallback(
    (id: string) => {
      invalidateHierarchyRequests();
      const requestGeneration = hierarchyRequestGeneration.current;
      const node = displaySlice.nodes.find((candidate) => candidate.id === id);
      if (!node || node.kind !== "module" || !node.definitionName) return;
      setStatusDetail(`Loading ${node.definitionName} from the local bundle`);
      const controller = new AbortController();
      hierarchyAbort.current = controller;
      void provider
        .getGraphSlice(
          { snapshotId: slice.snapshotId, moduleName: node.definitionName },
          controller.signal,
        )
        .then((response) => {
          if (
            controller.signal.aborted ||
            requestGeneration !== hierarchyRequestGeneration.current ||
            activeSliceRef.current !== slice
          ) {
            return;
          }
          const child = contextualizeInstance(slice, normalizeGraphSlice(response), node);
          startTransition(() => {
            setSliceStack((stack) =>
              requestGeneration === hierarchyRequestGeneration.current && stack.at(-1) === slice
                ? [...stack, child]
                : stack,
            );
            setSelectedId("");
          });
          const sourceReference = firstSourceReference(child, initial.project.files);
          if (sourceReference) void loadSourceReference(sourceReference);
          setStatusDetail(`Local snapshot ${child.snapshotId}`);
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setStatusDetail(
            `Could not open ${node.definitionName}: ${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          );
        });
    },
    [
      displaySlice,
      initial.project.files,
      invalidateHierarchyRequests,
      loadSourceReference,
      provider,
      setStatusDetail,
      slice,
    ],
  );

  const goUp = useCallback(() => {
    if (sliceStack.length <= 1) return;
    invalidateHierarchyRequests();
    const parent = sliceStack.at(-2);
    setSliceStack((stack) => stack.slice(0, -1));
    setSelectedId("");
    if (parent) {
      const sourceReference = firstSourceReference(parent, initial.project.files);
      if (sourceReference) void loadSourceReference(sourceReference);
    }
  }, [initial.project.files, invalidateHierarchyRequests, loadSourceReference, sliceStack]);

  const goTop = useCallback(() => {
    const top = sliceStack[0];
    if (!top) return;
    invalidateHierarchyRequests();
    setSliceStack([top]);
    setSelectedId(TOP_MODULE_ID);
    const sourceReference = firstSourceReference(top, initial.project.files);
    if (sourceReference) void loadSourceReference(sourceReference);
  }, [initial.project.files, invalidateHierarchyRequests, loadSourceReference, sliceStack]);

  const loadHierarchyChild = useCallback(
    async (parent: GraphSlice, node: GraphNode, signal: AbortSignal) => {
      if (!node.definitionName) throw new Error(`Instance ${node.label} has no definition`);
      const response = await provider.getGraphSlice(
        { snapshotId: parent.snapshotId, moduleName: node.definitionName },
        signal,
      );
      return contextualizeInstance(parent, normalizeGraphSlice(response), node);
    },
    [provider],
  );

  const navigateHierarchy = useCallback(
    (stack: GraphSlice[]) => {
      const target = stack.at(-1);
      if (!target) return;
      invalidateHierarchyRequests();
      setSliceStack(stack);
      setSelectedId(stack.length === 1 ? TOP_MODULE_ID : "");
      const sourceReference = firstSourceReference(target, initial.project.files);
      if (sourceReference) void loadSourceReference(sourceReference);
      setStatusDetail(`Local snapshot ${target.snapshotId}`);
    },
    [initial.project.files, invalidateHierarchyRequests, loadSourceReference, setStatusDetail],
  );

  const selectSourceRange = useCallback(
    (startLine: number, startColumn: number, endLine: number, endColumn: number) => {
      const entityId = entityForSourceSelection(displaySlice, sourceView.path, sourceView.source, {
        startLine,
        startColumn,
        endLine,
        endColumn,
      });
      if (!entityId) return;
      const node = displaySlice.nodes.find((candidate) => candidate.id === entityId);
      if (node?.kind === "module") openInstance(entityId);
      else setSelectedId(entityId);
    },
    [displaySlice, openInstance, sourceView.path, sourceView.source],
  );

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
        projectName={provider.fileName}
        statusText={initial.project.bundleStatus}
        dataMode="bundle"
        statusDetail={statusDetail}
        onOpenProject={onOpenBundle}
        onSearch={() => setUtilityDialog("search")}
        onHelp={() => setUtilityDialog("help")}
      />
      <ProjectSearchDialog
        open={utilityDialog === "search"}
        files={initial.project.files}
        slice={displaySlice}
        onClose={() => setUtilityDialog(undefined)}
        onSelectFile={selectSourcePath}
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
          entries={initial.project.files}
          selectedPath={sourceView.path}
          onSelect={selectSourcePath}
        />
        {leftPaneView === "source" ? (
          <Suspense fallback={<div className="pane-loading">Loading source viewer…</div>}>
            <SourcePane
              path={sourceView.path}
              source={sourceView.source}
              loading={sourceView.state === "loading"}
              error={sourceView.state === "error" ? sourceView.message : undefined}
              onShowHierarchy={() => setLeftPaneView("hierarchy")}
              origin={visibleOrigin}
              onSelectRange={selectSourceRange}
            />
          </Suspense>
        ) : (
          <InstanceHierarchy
            root={sliceStack[0] ?? initial.slice}
            activeInstancePath={slice.module.instancePath}
            loadChild={loadHierarchyChild}
            onNavigate={navigateHierarchy}
            onShowSource={() => setLeftPaneView("source")}
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
        <Suspense fallback={<div className="pane-loading">Loading schematic…</div>}>
          <SchematicCanvas
            slice={displaySlice}
            selectedId={selectedId}
            onSelect={selectGraphEntity}
            onHover={setHoveredId}
            onOpenInstance={openInstance}
            canGoUp={sliceStack.length > 1}
            onGoUp={goUp}
            onGoTop={goTop}
            labelSettings={labelSettings}
            onToggleLabel={toggleLabel}
            flattenDepth={flattenDepth}
            onFlattenDepthChange={(depth) => {
              setInlineSlice(undefined);
              setInlineHierarchy(false);
              setInlineTargetId(undefined);
              setFlattenDepth(depth);
            }}
            flattenRenderMode={flattenRenderMode}
            onFlattenRenderModeChange={setFlattenRenderMode}
            layoutProfile={layoutProfile}
            onLayoutProfileChange={setLayoutProfile}
            constantRadix={constantRadix}
            onConstantRadixChange={setConstantRadix}
            onFlattenInstance={(id) => {
              setFlattenDepth(0);
              setInlineTargetId(id);
              setInlineHierarchy(true);
            }}
            onRestoreInstance={() => {
              setInlineSlice(undefined);
              setInlineHierarchy(false);
              setInlineTargetId(undefined);
              setFlattenDepth(0);
            }}
            individuallyFlattened={inlineHierarchy}
            topLevelDefines={initial.project.effectiveElaboration.defines}
            inspectorOpen={inspectorOpen}
            onToggleInspector={() => setInspectorOpen((value) => !value)}
          />
        </Suspense>
        {inspectorOpen ? (
          <Inspector
            node={selectedNode}
            edge={selectedEdge}
            project={initial.project}
            topModule={slice.module}
            onClose={() => setInspectorOpen(false)}
          />
        ) : null}
      </main>
    </>
  );
}
