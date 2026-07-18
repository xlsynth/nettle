// SPDX-License-Identifier: Apache-2.0

import Editor, { type BeforeMount, loader, type OnMount } from "@monaco-editor/react";
import { Braces, GitFork, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import "monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.contribution";
import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?worker&url";
import { useCallback, useEffect, useRef } from "react";
import type { SourceElaborationRange, SourceOrigin } from "../model/graph";
import { sourceLanguageForPath } from "./source-language";

export { sourceLanguageForPath } from "./source-language";

(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new Worker(editorWorkerUrl, { type: "module" }),
};
loader.config({ monaco });

interface SourcePaneProps {
  path: string;
  source: string;
  loading?: boolean;
  error?: string;
  onShowHierarchy: () => void;
  origin?: SourceOrigin;
  elaborationRanges?: readonly SourceElaborationRange[];
  onSelectRange: (
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ) => void;
}

export function SourcePane({
  path,
  source,
  loading = false,
  error,
  onShowHierarchy,
  origin,
  elaborationRanges = [],
  onSelectRange,
}: SourcePaneProps) {
  const language = sourceLanguageForPath(path);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const elaborationDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const selectionListenerRef = useRef<{ dispose: () => void } | null>(null);
  const onSelectRangeRef = useRef(onSelectRange);
  const originRef = useRef(origin);
  onSelectRangeRef.current = onSelectRange;
  originRef.current = origin;

  const beforeMount = useCallback<BeforeMount>((monaco) => {
    monaco.editor.defineTheme("nettle-light", {
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
        "editor.lineHighlightBackground": "#f8faf9",
        "editor.selectionBackground": "#dcefe1",
        "editorCursor.foreground": "#167b3d",
        "editorGutter.background": "#ffffff",
      },
    });
  }, []);

  const applyOrigin = useCallback(
    (instance: editor.IStandaloneCodeEditor, nextOrigin: SourceOrigin | undefined) => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      if (!nextOrigin) return;
      decorationsRef.current = instance.createDecorationsCollection([
        {
          range: {
            startLineNumber: nextOrigin.startLine,
            startColumn: nextOrigin.startColumn,
            endLineNumber: nextOrigin.endLine ?? nextOrigin.startLine,
            endColumn: nextOrigin.endColumn ?? nextOrigin.startColumn + 1,
          },
          options: {
            className: "source-cross-highlight",
            inlineClassName: "source-cross-highlight-inline",
            linesDecorationsClassName: "source-cross-highlight-gutter",
            overviewRuler: { color: "#1b8b47", position: 2 },
          },
        },
      ]);
      instance.revealLineInCenterIfOutsideViewport(nextOrigin.startLine);
    },
    [],
  );

  const applyElaborationRanges = useCallback(
    (instance: editor.IStandaloneCodeEditor, ranges: readonly SourceElaborationRange[]) => {
      elaborationDecorationsRef.current?.clear();
      elaborationDecorationsRef.current = null;
      const decorations = ranges
        .filter((range) => !range.active)
        .map((range) => ({
          range: {
            startLineNumber: range.startLine,
            startColumn: range.startColumn,
            endLineNumber: range.endLine,
            endColumn: range.endColumn,
          },
          options: {
            inlineClassName: "source-inactive-generate-inline",
            hoverMessage: {
              value: "Inactive generate branch for this bundle's elaboration.",
            },
          },
        }));
      if (decorations.length) {
        elaborationDecorationsRef.current = instance.createDecorationsCollection(decorations);
      }
    },
    [],
  );

  const onMount = useCallback<OnMount>(
    (instance) => {
      editorRef.current = instance;
      selectionListenerRef.current?.dispose();
      selectionListenerRef.current = instance.onDidChangeCursorSelection(
        ({ selection, source }) => {
          if (source !== "mouse" && source !== "keyboard") return;
          const endColumn = selection.isEmpty() ? selection.startColumn + 1 : selection.endColumn;
          onSelectRangeRef.current(
            selection.startLineNumber,
            selection.startColumn,
            selection.endLineNumber,
            endColumn,
          );
        },
      );
      applyOrigin(instance, originRef.current);
      applyElaborationRanges(instance, elaborationRanges);
    },
    [applyElaborationRanges, applyOrigin, elaborationRanges],
  );

  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    applyOrigin(instance, origin);
  }, [applyOrigin, origin]);

  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    applyElaborationRanges(instance, elaborationRanges);
  }, [applyElaborationRanges, elaborationRanges]);

  useEffect(
    () => () => {
      selectionListenerRef.current?.dispose();
      selectionListenerRef.current = null;
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      elaborationDecorationsRef.current?.clear();
      elaborationDecorationsRef.current = null;
      editorRef.current = null;
    },
    [],
  );

  return (
    <section className="source-pane" aria-label="Read-only source">
      <div className="source-tabbar">
        <div className="pane-view-tabs" role="tablist" aria-label="Left pane view">
          <button className="pane-view-tab active" type="button" role="tab" aria-selected="true">
            <Braces size={13} /> Source
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
        <span className="source-file-name" title={path}>
          {path.split("/").at(-1)}
        </span>
      </div>
      <div className="editor-shell">
        <Editor
          height="100%"
          language={language.id}
          path={path}
          value={source}
          theme="nettle-light"
          beforeMount={beforeMount}
          onMount={onMount}
          loading={<div className="editor-loading">Loading source viewer…</div>}
          options={{
            readOnly: true,
            domReadOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
            fontSize: 12.5,
            lineHeight: 20,
            lineNumbersMinChars: 3,
            glyphMargin: true,
            folding: true,
            renderLineHighlight: "line",
            scrollBeyondLastLine: false,
            overviewRulerBorder: false,
            padding: { top: 9, bottom: 12 },
            wordWrap: "off",
            selectionHighlight: false,
          }}
        />
        {loading ? (
          <output className="source-state" aria-live="polite">
            <LoaderCircle className="source-state-spinner" size={18} />
            <strong>Loading source</strong>
            <span>{path}</span>
          </output>
        ) : error ? (
          <div className="source-state error" role="alert">
            <TriangleAlert size={19} />
            <strong>Source unavailable</strong>
            <span>{error}</span>
          </div>
        ) : null}
      </div>
      <footer className="source-status">
        <span>{origin ? `${path}:${origin.startLine}:${origin.startColumn}` : path}</span>
        <span>{language.label}</span>
        <span className="source-readonly">
          <LockKeyhole size={11} /> Read-only
        </span>
      </footer>
    </section>
  );
}
