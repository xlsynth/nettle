// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffSourcePane } from "./DiffSourcePane";

type MountedDiffEditor = (instance: unknown, monaco: unknown) => void;
type MockDiffEditorProps = {
  onMount?: MountedDiffEditor;
  keepCurrentOriginalModel?: boolean;
  keepCurrentModifiedModel?: boolean;
  original?: string;
  modified?: string;
  options?: {
    renderSideBySide?: boolean;
    hideUnchangedRegions?: { enabled?: boolean };
  };
};

const editorHarness = vi.hoisted(() => ({
  renders: 0,
  props: undefined as MockDiffEditorProps | undefined,
}));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: vi.fn() },
  DiffEditor: (props: MockDiffEditorProps) => {
    editorHarness.renders += 1;
    editorHarness.props = props;
    return <div data-testid="mock-diff-editor" />;
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  editorHarness.renders = 0;
  editorHarness.props = undefined;
  vi.clearAllMocks();
});

const baseProps = {
  status: "unchanged" as const,
  onShowHierarchy: vi.fn(),
  onSelectRange: vi.fn(),
};

describe("DiffSourcePane bounded states", () => {
  it("shows an explicit empty-inventory state without mounting Monaco", () => {
    render(
      <DiffSourcePane
        {...baseProps}
        reference={{ path: "", source: "" }}
        candidate={{ path: "", source: "" }}
      />,
    );

    expect(screen.getByText("No bundled source")).toBeTruthy();
    expect(screen.queryByTestId("mock-diff-editor")).toBeNull();
    expect(editorHarness.renders).toBe(0);
  });

  it("ignores model-driven cursor events and defers retained-model disposal", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const onSelectRange = vi.fn();
    let referenceSelectionListener:
      | ((event: {
          source: string;
          selection: {
            isEmpty: () => boolean;
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          };
        }) => void)
      | undefined;
    let referenceModelListener: (() => void) | undefined;
    const referenceModel = {
      dispose: vi.fn(() => order.push("dispose-reference")),
      getLineMaxColumn: vi.fn(() => 12),
    };
    const candidateModel = {
      dispose: vi.fn(() => order.push("dispose-candidate")),
      getLineMaxColumn: vi.fn(() => 12),
    };
    const nextReferenceModel = {
      dispose: vi.fn(() => order.push("dispose-next-reference")),
      getLineMaxColumn: vi.fn(() => 12),
    };
    const sideEditor = (
      model: typeof referenceModel,
      captureSelection = false,
      captureModel = false,
    ) => ({
      getModel: vi.fn(() => model),
      onDidChangeCursorSelection: vi.fn(
        (listener: NonNullable<typeof referenceSelectionListener>) => {
          if (captureSelection) referenceSelectionListener = listener;
          return { dispose: vi.fn() };
        },
      ),
      onDidChangeModel: vi.fn((listener: () => void) => {
        if (captureModel) referenceModelListener = listener;
        return { dispose: vi.fn() };
      }),
      createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
      revealLineInCenterIfOutsideViewport: vi.fn(),
    });
    const referenceEditor = sideEditor(referenceModel, true, true);
    const candidateEditor = sideEditor(candidateModel);
    const diffEditor = {
      getOriginalEditor: vi.fn(() => referenceEditor),
      getModifiedEditor: vi.fn(() => candidateEditor),
      setModel: vi.fn(),
    };
    const view = render(
      <DiffSourcePane
        {...baseProps}
        status="modified"
        reference={{
          path: "rtl/top.sv",
          source: "old",
          elaborationRanges: [
            {
              file: "rtl/top.sv",
              startLine: 2,
              startColumn: 3,
              endLine: 4,
              endColumn: 5,
              active: false,
            },
          ],
        }}
        candidate={{
          path: "rtl/top.sv",
          source: "new",
          elaborationRanges: [
            {
              file: "rtl/top.sv",
              startLine: 6,
              startColumn: 7,
              endLine: 8,
              endColumn: 9,
              active: false,
            },
          ],
        }}
        hunks={[
          {
            referenceStartLine: 4,
            referenceEndLine: 6,
            candidateStartLine: 4,
            candidateEndLine: 6,
            sourceOnly: false,
          },
        ]}
        onSelectRange={onSelectRange}
      />,
    );

    expect(editorHarness.props?.keepCurrentOriginalModel).toBe(true);
    expect(editorHarness.props?.keepCurrentModifiedModel).toBe(true);
    act(() => editorHarness.props?.onMount?.(diffEditor, {}));
    expect(referenceEditor.createDecorationsCollection).toHaveBeenCalledWith([
      {
        range: {
          startLineNumber: 2,
          startColumn: 3,
          endLineNumber: 4,
          endColumn: 5,
        },
        options: {
          inlineClassName: "source-inactive-generate-inline",
          hoverMessage: {
            value: "Inactive generate branch for the visible schematic.",
          },
        },
      },
    ]);
    expect(candidateEditor.createDecorationsCollection).toHaveBeenCalledWith([
      {
        range: {
          startLineNumber: 6,
          startColumn: 7,
          endLineNumber: 8,
          endColumn: 9,
        },
        options: {
          inlineClassName: "source-inactive-generate-inline",
          hoverMessage: {
            value: "Inactive generate branch for the visible schematic.",
          },
        },
      },
    ]);

    const selection = {
      isEmpty: () => true,
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 3,
    };
    act(() => {
      referenceSelectionListener?.({ source: "api", selection });
      referenceSelectionListener?.({ source: "modelChange", selection });
      referenceSelectionListener?.({ source: "restoreState", selection });
    });
    expect(onSelectRange).not.toHaveBeenCalled();
    act(() => referenceSelectionListener?.({ source: "mouse", selection }));
    expect(onSelectRange).toHaveBeenCalledWith(
      "reference",
      { startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 },
      undefined,
    );

    const hunkSelection = {
      isEmpty: () => true,
      startLineNumber: 5,
      startColumn: 4,
      endLineNumber: 5,
      endColumn: 4,
    };
    act(() => referenceSelectionListener?.({ source: "mouse", selection: hunkSelection }));
    expect(onSelectRange).toHaveBeenLastCalledWith(
      "reference",
      { startLine: 5, startColumn: 4, endLine: 5, endColumn: 5 },
      { startLine: 4, startColumn: 1, endLine: 6, endColumn: 12 },
    );

    referenceEditor.getModel.mockReturnValue(nextReferenceModel);
    act(() => referenceModelListener?.());
    expect(referenceModel.dispose).not.toHaveBeenCalled();

    const reusedReferenceEditor = sideEditor(referenceModel);
    const reusedCandidateEditor = sideEditor(candidateModel);
    const reusedDiffEditor = {
      getOriginalEditor: vi.fn(() => reusedReferenceEditor),
      getModifiedEditor: vi.fn(() => reusedCandidateEditor),
      setModel: vi.fn(),
    };
    act(() => editorHarness.props?.onMount?.(reusedDiffEditor, {}));
    await act(async () => vi.runAllTimers());
    expect(order).toEqual(["dispose-next-reference"]);
    expect(referenceModel.dispose).not.toHaveBeenCalled();
    expect(candidateModel.dispose).not.toHaveBeenCalled();

    view.unmount();
    await act(async () => vi.runAllTimers());
    expect(order).toEqual(["dispose-next-reference", "dispose-reference", "dispose-candidate"]);
  });

  it("does not ask Monaco to repeat a source diff rejected by the worker limit", () => {
    render(
      <DiffSourcePane
        {...baseProps}
        status="modified"
        suppressDiff
        reference={{ path: "rtl/top.sv", source: "old" }}
        candidate={{ path: "rtl/top.sv", source: "new" }}
      />,
    );

    expect(screen.getByText("Text diff too large")).toBeTruthy();
    expect(screen.getByText(/schematic comparison remains available/i)).toBeTruthy();
    expect(screen.queryByTestId("mock-diff-editor")).toBeNull();
    expect(editorHarness.renders).toBe(0);
  });

  it("keeps the loading state authoritative while a bounded diff is pending", () => {
    render(
      <DiffSourcePane
        {...baseProps}
        status="modified"
        suppressDiff
        reference={{ path: "rtl/top.sv", source: "", loading: true }}
        candidate={{ path: "rtl/top.sv", source: "", loading: true }}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Loading source diff");
    expect(screen.queryByText("Text diff too large")).toBeNull();
    expect(screen.queryByTestId("mock-diff-editor")).toBeNull();
  });

  it("keeps deleted reference text visible in a one-sided layout", () => {
    render(
      <DiffSourcePane
        {...baseProps}
        status="removed"
        reference={{ path: "rtl/legacy_child.sv", source: "module legacy_child(); endmodule\n" }}
        candidate={{ path: "", source: "" }}
      />,
    );

    expect(screen.getByTestId("mock-diff-editor")).toBeTruthy();
    expect(editorHarness.props?.original).toBe("module legacy_child(); endmodule\n");
    expect(editorHarness.props?.modified).toBe("");
    expect(editorHarness.props?.options?.renderSideBySide).toBe(true);
    expect(editorHarness.props?.options?.hideUnchangedRegions?.enabled).toBe(true);
  });

  it("identifies an exact content rename without presenting it as a modification", () => {
    render(
      <DiffSourcePane
        {...baseProps}
        status="renamed"
        reference={{ path: "rtl/old_name.sv", source: "module same; endmodule\n" }}
        candidate={{ path: "rtl/new_name.sv", source: "module same; endmodule\n" }}
      />,
    );

    expect(screen.getByTitle("Renamed").textContent).toBe("R");
    expect(editorHarness.props?.original).toBe(editorHarness.props?.modified);
  });
});
