// SPDX-License-Identifier: Apache-2.0

import { type DiffBeforeMount, DiffEditor, type DiffOnMount, loader } from "@monaco-editor/react";
import { Braces, GitFork, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import "monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.contribution";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?worker&url";
import { useCallback, useEffect, useRef } from "react";
import type { ClassifiedSourceDiffHunk, SourceDiffStatus } from "../comparison";
import type { SourceOrigin } from "../model/graph";
import { diffStatusLabel } from "./comparison-types";
import { sourceLanguageForPath } from "./source-language";

(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new Worker(editorWorkerUrl, { type: "module" }),
};
loader.config({ monaco });

// Monaco's worker may still be completing an advanced diff after its editor
// widget has synchronously unmounted. Keep retired models alive slightly
// longer than maxComputationTime so an in-flight worker result cannot observe
// disposed models and reject outside the editor lifecycle.
const RETIRED_MODEL_DISPOSAL_DELAY_MS = 2_500;

export interface DiffSourceVersion {
  path: string;
  source: string;
  modelId?: string;
  loading?: boolean;
  error?: string;
  origin?: SourceOrigin;
}

export type DiffSourceSide = "reference" | "candidate";

export interface DiffSourcePaneProps {
  reference: DiffSourceVersion;
  candidate: DiffSourceVersion;
  status: SourceDiffStatus;
  hunks?: readonly ClassifiedSourceDiffHunk[];
  notice?: string;
  suppressDiff?: boolean;
  onShowHierarchy: () => void;
  onSelectRange: (
    side: DiffSourceSide,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ) => void;
}

const modelUri = (side: DiffSourceSide, version: DiffSourceVersion) => {
  const id = encodeURIComponent(version.modelId ?? version.path);
  return `nettle-diff://${side}/${id}`;
};

const defineTheme: DiffBeforeMount = (monaco) => {
  monaco.editor.defineTheme("nettle-diff-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "8f3f9f" },
      { token: "type", foreground: "2f5fa0" },
      { token: "number", foreground: "87591b" },
      { token: "comment", foreground: "829083", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#2c3032",
      "editorLineNumber.foreground": "#a4abad",
      "editorLineNumber.activeForeground": "#657073",
      "editor.selectionBackground": "#dce7f7",
      "editorCursor.foreground": "#3568b5",
      "editorGutter.background": "#ffffff",
      "diffEditor.insertedTextBackground": "#b7e4c780",
      "diffEditor.removedTextBackground": "#f4b8b580",
      "diffEditor.insertedLineBackground": "#e7f6eb",
      "diffEditor.removedLineBackground": "#fcebea",
      "diffEditor.diagonalFill": "#e7ebe9",
    },
  });
};

const applyOrigin = (
  instance: editor.IStandaloneCodeEditor,
  collection: editor.IEditorDecorationsCollection | null,
  origin: SourceOrigin | undefined,
  side: DiffSourceSide,
) => {
  collection?.clear();
  if (!origin) return null;
  const color = side === "reference" ? "#c23b35" : "#168443";
  const next = instance.createDecorationsCollection([
    {
      range: {
        startLineNumber: origin.startLine,
        startColumn: origin.startColumn,
        endLineNumber: origin.endLine ?? origin.startLine,
        endColumn: origin.endColumn ?? origin.startColumn + 1,
      },
      options: {
        className: `diff-source-cross-highlight ${side}`,
        inlineClassName: `diff-source-cross-highlight-inline ${side}`,
        linesDecorationsClassName: `diff-source-cross-highlight-gutter ${side}`,
        overviewRuler: { color, position: 2 },
      },
    },
  ]);
  instance.revealLineInCenterIfOutsideViewport(origin.startLine);
  return next;
};

const hunkRange = (
  instance: editor.IStandaloneCodeEditor,
  hunk: ClassifiedSourceDiffHunk,
  side: DiffSourceSide,
) => {
  const start = side === "reference" ? hunk.referenceStartLine : hunk.candidateStartLine;
  const end = side === "reference" ? hunk.referenceEndLine : hunk.candidateEndLine;
  if (start === undefined || end === undefined) return undefined;
  const model = instance.getModel();
  if (!model || start > model.getLineCount()) return undefined;
  const boundedEnd = Math.min(end, model.getLineCount());
  return {
    startLineNumber: start,
    startColumn: 1,
    endLineNumber: boundedEnd,
    endColumn: model.getLineMaxColumn(boundedEnd),
  };
};

const applySourceOnlyHunks = (
  instance: editor.IStandaloneCodeEditor,
  collection: editor.IEditorDecorationsCollection | null,
  hunks: readonly ClassifiedSourceDiffHunk[],
  side: DiffSourceSide,
) => {
  collection?.clear();
  const decorations = hunks.flatMap((hunk) => {
    if (!hunk.sourceOnly) return [];
    const range = hunkRange(instance, hunk, side);
    if (!range) return [];
    return [
      {
        range,
        options: {
          isWholeLine: true,
          className: "source-only-hunk-line",
          linesDecorationsClassName: "source-only-hunk-gutter",
          hoverMessage: {
            value: "Source-only change: no changed schematic object intersects this hunk.",
          },
          after: { content: "  source-only", inlineClassName: "source-only-hunk-label" },
        },
      },
    ];
  });
  return decorations.length ? instance.createDecorationsCollection(decorations) : null;
};

export function DiffSourcePane({
  reference,
  candidate,
  status,
  hunks = [],
  notice,
  suppressDiff = false,
  onShowHierarchy,
  onSelectRange,
}: DiffSourcePaneProps) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const referenceDecorations = useRef<editor.IEditorDecorationsCollection | null>(null);
  const candidateDecorations = useRef<editor.IEditorDecorationsCollection | null>(null);
  const referenceSourceOnlyDecorations = useRef<editor.IEditorDecorationsCollection | null>(null);
  const candidateSourceOnlyDecorations = useRef<editor.IEditorDecorationsCollection | null>(null);
  const listeners = useRef<Array<{ dispose: () => void }>>([]);
  const modelsRef = useRef<{
    reference: editor.ITextModel | null;
    candidate: editor.ITextModel | null;
  }>({ reference: null, candidate: null });
  const retiredModelsRef = useRef(new Set<editor.ITextModel>());
  const onSelectRangeRef = useRef(onSelectRange);
  const hunksRef = useRef(hunks);
  onSelectRangeRef.current = onSelectRange;
  hunksRef.current = hunks;

  const scheduleModelDisposal = useCallback((models: Iterable<editor.ITextModel>) => {
    const retired = new Set(models);
    window.setTimeout(() => {
      const active = new Set(
        [modelsRef.current.reference, modelsRef.current.candidate].filter(
          (model): model is editor.ITextModel => model !== null,
        ),
      );
      for (const model of retired) {
        if (!active.has(model)) model.dispose();
      }
    }, RETIRED_MODEL_DISPOSAL_DELAY_MS);
  }, []);

  const updateOrigins = useCallback(() => {
    const instance = editorRef.current;
    if (!instance) return;
    referenceDecorations.current = applyOrigin(
      instance.getOriginalEditor(),
      referenceDecorations.current,
      reference.origin,
      "reference",
    );
    candidateDecorations.current = applyOrigin(
      instance.getModifiedEditor(),
      candidateDecorations.current,
      candidate.origin,
      "candidate",
    );
    referenceSourceOnlyDecorations.current = applySourceOnlyHunks(
      instance.getOriginalEditor(),
      referenceSourceOnlyDecorations.current,
      hunks,
      "reference",
    );
    candidateSourceOnlyDecorations.current = applySourceOnlyHunks(
      instance.getModifiedEditor(),
      candidateSourceOnlyDecorations.current,
      hunks,
      "candidate",
    );
  }, [candidate.origin, hunks, reference.origin]);

  const releaseEditor = useCallback(() => {
    for (const listener of listeners.current) listener.dispose();
    listeners.current = [];
    referenceDecorations.current?.clear();
    referenceDecorations.current = null;
    candidateDecorations.current?.clear();
    candidateDecorations.current = null;
    referenceSourceOnlyDecorations.current?.clear();
    referenceSourceOnlyDecorations.current = null;
    candidateSourceOnlyDecorations.current?.clear();
    candidateSourceOnlyDecorations.current = null;

    const instance = editorRef.current;
    const referenceModel = instance?.getOriginalEditor().getModel() ?? modelsRef.current.reference;
    const candidateModel = instance?.getModifiedEditor().getModel() ?? modelsRef.current.candidate;
    editorRef.current = null;
    modelsRef.current = { reference: null, candidate: null };
    const models = new Set(retiredModelsRef.current);
    if (referenceModel) models.add(referenceModel);
    if (candidateModel) models.add(candidateModel);
    retiredModelsRef.current.clear();

    // @monaco-editor/react owns the diff editor and disposes it in its child
    // cleanup. Because keepCurrent*Model is enabled, dispose the retained
    // models only after that synchronous cleanup has completed.
    scheduleModelDisposal(models);
  }, [scheduleModelDisposal]);

  const onMount = useCallback<DiffOnMount>(
    (instance) => {
      const previousModels = new Set(retiredModelsRef.current);
      if (modelsRef.current.reference) previousModels.add(modelsRef.current.reference);
      if (modelsRef.current.candidate) previousModels.add(modelsRef.current.candidate);
      retiredModelsRef.current.clear();
      editorRef.current = instance;
      for (const listener of listeners.current) listener.dispose();
      const referenceEditor = instance.getOriginalEditor();
      const candidateEditor = instance.getModifiedEditor();
      modelsRef.current = {
        reference: referenceEditor.getModel(),
        candidate: candidateEditor.getModel(),
      };
      listeners.current = (
        [
          ["reference", referenceEditor],
          ["candidate", candidateEditor],
        ] as const
      ).flatMap(([side, sideEditor]) => [
        sideEditor.onDidChangeCursorSelection(({ selection, source }) => {
          if (source !== "mouse" && source !== "keyboard") return;
          const hunk = hunksRef.current.find((candidateHunk) => {
            const start =
              side === "reference"
                ? candidateHunk.referenceStartLine
                : candidateHunk.candidateStartLine;
            const end =
              side === "reference"
                ? candidateHunk.referenceEndLine
                : candidateHunk.candidateEndLine;
            return (
              start !== undefined &&
              end !== undefined &&
              selection.startLineNumber >= start &&
              selection.startLineNumber <= end
            );
          });
          const startLine =
            (side === "reference" ? hunk?.referenceStartLine : hunk?.candidateStartLine) ??
            selection.startLineNumber;
          const endLine =
            (side === "reference" ? hunk?.referenceEndLine : hunk?.candidateEndLine) ??
            selection.endLineNumber;
          const endColumn = hunk
            ? (sideEditor.getModel()?.getLineMaxColumn(endLine) ?? selection.endColumn)
            : selection.isEmpty()
              ? selection.startColumn + 1
              : selection.endColumn;
          onSelectRangeRef.current(
            side,
            startLine,
            hunk ? 1 : selection.startColumn,
            endLine,
            endColumn,
          );
        }),
        sideEditor.onDidChangeModel(() => {
          const model = sideEditor.getModel();
          if (!model) return;
          const previous = modelsRef.current[side];
          modelsRef.current[side] = model;
          if (previous && previous !== model) retiredModelsRef.current.add(previous);
        }),
      ]);
      // A model-path change remounts DiffEditor (see the key below). By the
      // time this new editor mounts, the wrapper has disposed the old editor,
      // so its retained models can be released on the next task.
      if (previousModels.size > 0) {
        scheduleModelDisposal(previousModels);
      }
      updateOrigins();
    },
    [scheduleModelDisposal, updateOrigins],
  );

  useEffect(() => updateOrigins(), [updateOrigins]);

  useEffect(() => () => releaseEditor(), [releaseEditor]);

  const referenceLanguage = sourceLanguageForPath(reference.path);
  const candidateLanguage = sourceLanguageForPath(candidate.path);
  const loading = reference.loading || candidate.loading;
  const error = reference.error ?? candidate.error;
  const noSource = !loading && !error && !reference.path && !candidate.path;
  const removedOnly = !loading && !error && Boolean(reference.path) && !candidate.path;
  const displayPath = candidate.path || reference.path;
  const sourceOnlyHunkCount = hunks.filter((hunk) => hunk.sourceOnly).length;

  useEffect(() => {
    if (!noSource && !suppressDiff) return;
    releaseEditor();
  }, [noSource, releaseEditor, suppressDiff]);

  return (
    <section className="source-pane diff-source-pane" aria-label="Read-only source diff">
      <div className="source-tabbar">
        <div className="pane-view-tabs" role="tablist" aria-label="Left pane view">
          <button className="pane-view-tab active" type="button" role="tab" aria-selected="true">
            <Braces size={13} /> Diff
          </button>
          <button
            className="pane-view-tab"
            type="button"
            role="tab"
            aria-selected="false"
            onClick={onShowHierarchy}
          >
            <GitFork size={13} /> Hierarchy
          </button>
        </div>
        <span
          className={`source-diff-status ${status}`}
          title={status === "renamed" ? "Renamed" : diffStatusLabel(status)}
        >
          {status === "added"
            ? "A"
            : status === "removed"
              ? "D"
              : status === "modified"
                ? "M"
                : status === "renamed"
                  ? "R"
                  : "="}
        </span>
        <span className="source-file-name" title={`${reference.path} → ${candidate.path}`}>
          {displayPath.split("/").at(-1)}
        </span>
        {sourceOnlyHunkCount ? (
          <span className="source-only-hunk-count">
            {sourceOnlyHunkCount} source-only {sourceOnlyHunkCount === 1 ? "hunk" : "hunks"}
          </span>
        ) : null}
      </div>
      <div className="editor-shell">
        {!noSource && !suppressDiff ? (
          <DiffEditor
            key={`${modelUri("reference", reference)}:${modelUri("candidate", candidate)}`}
            height="100%"
            original={reference.source}
            modified={candidate.source}
            originalLanguage={referenceLanguage.id}
            modifiedLanguage={candidateLanguage.id}
            originalModelPath={modelUri("reference", reference)}
            modifiedModelPath={modelUri("candidate", candidate)}
            theme="nettle-diff-light"
            beforeMount={defineTheme}
            onMount={onMount}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            loading={<div className="editor-loading">Loading source diff…</div>}
            options={{
              readOnly: true,
              originalEditable: false,
              automaticLayout: true,
              // Monaco's inline diff view drops the original text when the
              // modified model is entirely absent. Preserve the deleted
              // reference in a one-sided side-by-side view.
              renderSideBySide: removedOnly,
              renderOverviewRuler: false,
              minimap: { enabled: false },
              fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
              fontSize: 12.5,
              lineHeight: 20,
              lineNumbersMinChars: 3,
              glyphMargin: true,
              folding: true,
              scrollBeyondLastLine: false,
              overviewRulerBorder: false,
              padding: { top: 9, bottom: 12 },
              wordWrap: "off",
              selectionHighlight: false,
              diffAlgorithm: "advanced",
              maxComputationTime: 2000,
              hideUnchangedRegions: {
                enabled: true,
                contextLineCount: 3,
                minimumLineCount: 3,
                revealLineCount: 20,
              },
            }}
          />
        ) : null}
        {noSource ? (
          <div className="source-state">
            <Braces size={19} />
            <strong>No bundled source</strong>
            <span>This comparison contains schematic data only.</span>
          </div>
        ) : suppressDiff && !loading ? (
          <div className="source-state">
            <TriangleAlert size={19} />
            <strong>Text diff too large</strong>
            <span>
              The bounded source diff was stopped; schematic comparison remains available.
            </span>
          </div>
        ) : null}
        {loading ? (
          <output className="source-state" aria-live="polite">
            <LoaderCircle className="source-state-spinner" size={18} />
            <strong>Loading source diff</strong>
            <span>{displayPath}</span>
          </output>
        ) : error ? (
          <div className="source-state error" role="alert">
            <TriangleAlert size={19} />
            <strong>Source diff unavailable</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <output className="source-diff-notice" aria-live="polite">
            <TriangleAlert size={14} /> {notice}
          </output>
        ) : null}
      </div>
      <footer className="source-status diff-source-statusbar">
        <span title={reference.path}>− {reference.path || "not present"}</span>
        <span title={candidate.path}>+ {candidate.path || "not present"}</span>
        <span className="source-readonly">
          <LockKeyhole size={11} /> Read-only
        </span>
      </footer>
    </section>
  );
}
