// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourcePane, sourceLanguageForPath } from "./SourcePane";

type MountedEditor = (instance: unknown, monaco: unknown) => void;
type SelectionEvent = {
  source: string;
  selection: {
    isEmpty: () => boolean;
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
};

const editorHarness = vi.hoisted(() => ({
  onMount: undefined as MountedEditor | undefined,
}));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: vi.fn() },
  default: (props: { onMount?: MountedEditor }) => {
    editorHarness.onMount = props.onMount;
    return <div data-testid="mock-editor" />;
  },
}));

describe("SourcePane", () => {
  it("detects HDL and repository metadata file languages", () => {
    expect(sourceLanguageForPath("rtl/top.sv")).toEqual({
      id: "systemverilog",
      label: "SystemVerilog",
    });
    expect(sourceLanguageForPath("netlist/top.v")).toEqual({ id: "verilog", label: "Verilog" });
    expect(sourceLanguageForPath("build/top.json")).toEqual({ id: "json", label: "JSON" });
    expect(sourceLanguageForPath("project.f")).toEqual({ id: "plaintext", label: "File list" });
    expect(sourceLanguageForPath("README.unknown")).toEqual({
      id: "plaintext",
      label: "Plain text",
    });
  });

  it("uses the latest range callback and applies the current origin when Monaco mounts", () => {
    let selectionListener: ((event: SelectionEvent) => void) | undefined;
    const dispose = vi.fn();
    const clear = vi.fn();
    const createDecorationsCollection = vi.fn(() => ({ clear }));
    const revealLineInCenterIfOutsideViewport = vi.fn();
    const editor = {
      createDecorationsCollection,
      revealLineInCenterIfOutsideViewport,
      onDidChangeCursorSelection: vi.fn((listener: typeof selectionListener) => {
        selectionListener = listener;
        return { dispose };
      }),
    };
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const origin = {
      file: "rtl/top.sv",
      startLine: 7,
      startColumn: 3,
      endLine: 7,
      endColumn: 12,
    };
    const view = render(
      <SourcePane
        path="rtl/top.sv"
        source="module top; endmodule"
        onShowHierarchy={vi.fn()}
        origin={origin}
        onSelectRange={firstCallback}
      />,
    );

    act(() => editorHarness.onMount?.(editor, {}));
    expect(createDecorationsCollection).toHaveBeenCalledOnce();
    expect(revealLineInCenterIfOutsideViewport).toHaveBeenCalledWith(7);

    view.rerender(
      <SourcePane
        path="rtl/top.sv"
        source="module top; endmodule"
        onShowHierarchy={vi.fn()}
        origin={origin}
        onSelectRange={secondCallback}
      />,
    );
    act(() =>
      selectionListener?.({
        source: "mouse",
        selection: {
          isEmpty: () => false,
          startLineNumber: 9,
          startColumn: 4,
          endLineNumber: 10,
          endColumn: 10,
        },
      }),
    );

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(9, 4, 10, 10);

    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalled();
  });

  it("treats a cursor click as a one-character source selection", () => {
    let selectionListener: ((event: SelectionEvent) => void) | undefined;
    const callback = vi.fn();
    const editor = {
      createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
      revealLineInCenterIfOutsideViewport: vi.fn(),
      onDidChangeCursorSelection: vi.fn((listener: typeof selectionListener) => {
        selectionListener = listener;
        return { dispose: vi.fn() };
      }),
    };
    const view = render(
      <SourcePane
        path="rtl/top.sv"
        source="module top; endmodule"
        onShowHierarchy={vi.fn()}
        onSelectRange={callback}
      />,
    );
    act(() => editorHarness.onMount?.(editor, {}));
    act(() =>
      selectionListener?.({
        source: "mouse",
        selection: {
          isEmpty: () => true,
          startLineNumber: 3,
          startColumn: 17,
          endLineNumber: 3,
          endColumn: 17,
        },
      }),
    );
    expect(callback).toHaveBeenCalledWith(3, 17, 3, 18);
    view.unmount();
  });

  it("dims only inactive generate ranges", () => {
    const clear = vi.fn();
    const createDecorationsCollection = vi.fn(() => ({ clear }));
    const editor = {
      createDecorationsCollection,
      revealLineInCenterIfOutsideViewport: vi.fn(),
      onDidChangeCursorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const view = render(
      <SourcePane
        path="rtl/top.sv"
        source="module top; endmodule"
        onShowHierarchy={vi.fn()}
        onSelectRange={vi.fn()}
        elaborationRanges={[
          {
            file: "rtl/top.sv",
            startLine: 2,
            startColumn: 3,
            endLine: 4,
            endColumn: 6,
            active: true,
          },
          {
            file: "rtl/top.sv",
            startLine: 4,
            startColumn: 7,
            endLine: 6,
            endColumn: 6,
            active: false,
          },
        ]}
      />,
    );

    act(() => editorHarness.onMount?.(editor, {}));
    expect(createDecorationsCollection).toHaveBeenCalledOnce();
    expect(createDecorationsCollection).toHaveBeenCalledWith([
      {
        range: {
          startLineNumber: 4,
          startColumn: 7,
          endLineNumber: 6,
          endColumn: 6,
        },
        options: {
          inlineClassName: "source-inactive-generate-inline",
          hoverMessage: {
            value: "Inactive generate branch for the visible schematic.",
          },
        },
      },
    ]);

    view.unmount();
    expect(clear).toHaveBeenCalled();
  });

  it("ignores cursor selections caused by API, model, and view-state synchronization", () => {
    let selectionListener: ((event: SelectionEvent) => void) | undefined;
    const callback = vi.fn();
    const editor = {
      createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
      revealLineInCenterIfOutsideViewport: vi.fn(),
      onDidChangeCursorSelection: vi.fn((listener: typeof selectionListener) => {
        selectionListener = listener;
        return { dispose: vi.fn() };
      }),
    };
    const view = render(
      <SourcePane
        path="rtl/top.sv"
        source="module top; endmodule"
        onShowHierarchy={vi.fn()}
        onSelectRange={callback}
      />,
    );
    act(() => editorHarness.onMount?.(editor, {}));

    const selection = {
      isEmpty: () => true,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
    act(() => {
      selectionListener?.({ source: "api", selection });
      selectionListener?.({ source: "modelChange", selection });
      selectionListener?.({ source: "restoreState", selection });
    });
    expect(callback).not.toHaveBeenCalled();

    act(() => selectionListener?.({ source: "keyboard", selection }));
    expect(callback).toHaveBeenCalledWith(1, 1, 1, 2);
    view.unmount();
  });

  it("renders source loading as pane chrome instead of editor content", () => {
    const view = render(
      <SourcePane
        path="rtl/child.sv"
        source=""
        loading
        onShowHierarchy={vi.fn()}
        onSelectRange={vi.fn()}
      />,
    );

    expect(view.getByRole("status").textContent).toContain("Loading source");
    expect(view.getByRole("status").textContent).toContain("rtl/child.sv");
    expect(view.queryByText(/\/\/ Loading/)).toBeNull();
    view.unmount();
  });
});
