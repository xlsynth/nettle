// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ComparisonSlice } from "../comparison/types";
import type { GraphSlice } from "../model/graph";
import { TOP_MODULE_ID } from "./constants";
import type { FlattenRenderMode, LayoutResult } from "./layout-types";
import { SchematicCanvas } from "./SchematicCanvas";

const layoutHarness = vi.hoisted(() => ({
  layout: null as LayoutResult | null,
  receivedSlices: [] as GraphSlice[],
  receivedModes: [] as FlattenRenderMode[],
}));

vi.mock("./use-layout", () => ({
  useLayout: (slice: GraphSlice, _profile: string, mode: FlattenRenderMode) => {
    layoutHarness.receivedSlices.push(slice);
    layoutHarness.receivedModes.push(mode);
    return { layout: layoutHarness.layout, loading: false, error: null };
  },
}));

afterEach(cleanup);

beforeAll(() => {
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true,
    value: { baseVal: { x: 0, y: 0, width: 0, height: 0 } },
  });
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const chooseComparisonView = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: /Schematic comparison view:/ }));
  fireEvent.click(screen.getByRole("radio", { name }));
};

describe("SchematicCanvas node symbols", () => {
  it("renders constants without boxes and aligns the clock triangle to its fixed port", () => {
    const slice = {
      snapshotId: "symbols",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "zero",
          kind: "constant",
          label: "8'b0",
          ports: [{ id: "zero-y", name: "Y", direction: "output", width: 8 }],
        },
        {
          id: "state",
          kind: "register",
          label: "DFF",
          parameters: { ALOAD_POLARITY: "0000" },
          ports: [
            { id: "d", name: "D", direction: "input", role: "data", width: 8 },
            { id: "q", name: "Q", direction: "output", role: "data", width: 8 },
            { id: "clk", name: "CLK", direction: "input", role: "clock" },
            { id: "rst", name: "ALOAD", direction: "input", role: "reset" },
          ],
        },
        {
          id: "u_child",
          kind: "module",
          label: "u_child",
          definitionName: "child",
          ports: [],
        },
        {
          id: "mem",
          kind: "memory",
          label: "MEM",
          ports: [
            { id: "rd-clk", name: "RD_CLK", direction: "input" },
            { id: "rd-arst", name: "RD_ARST_VALUE", direction: "input", width: 32 },
            { id: "rd-data", name: "RD_DATA", direction: "output", width: 32 },
          ],
        },
      ],
      edges: [
        {
          id: "zero-d",
          sourceNode: "zero",
          sourcePort: "zero-y",
          targetNode: "state",
          targetPort: "d",
          width: 686,
        },
      ],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 600,
      height: 180,
      groups: [],
      elapsedMs: 1,
      edges: [
        {
          ...slice.edges[0],
          sections: [{ startPoint: { x: 66, y: 82 }, bendPoints: [], endPoint: { x: 130, y: 82 } }],
        },
      ],
      nodes: [
        {
          ...slice.nodes[0],
          x: 20,
          y: 70,
          width: 46,
          height: 24,
          ports: [
            {
              ...slice.nodes[0].ports[0],
              x: 62.5,
              y: 78.5,
              width: 7,
              height: 7,
              bitWidth: 8,
            },
          ],
        },
        {
          ...slice.nodes[1],
          x: 130,
          y: 30,
          width: 104,
          height: 116,
          ports: [
            { ...slice.nodes[1].ports[0], x: 126.5, y: 84.5, width: 7, height: 7, bitWidth: 8 },
            { ...slice.nodes[1].ports[1], x: 230.5, y: 84.5, width: 7, height: 7, bitWidth: 8 },
            { ...slice.nodes[1].ports[2], x: 126.5, y: 120.5, width: 7, height: 7 },
            { ...slice.nodes[1].ports[3], x: 178.5, y: 142.5, width: 7, height: 7 },
          ],
        },
        {
          ...slice.nodes[2],
          x: 250,
          y: 40,
          width: 142,
          height: 110,
          ports: [],
        },
        {
          ...slice.nodes[3],
          x: 410,
          y: 20,
          width: 180,
          height: 110,
          ports: [
            { ...slice.nodes[3].ports[0], x: 406.5, y: 54.5, width: 7, height: 7 },
            {
              ...slice.nodes[3].ports[1],
              x: 406.5,
              y: 72.5,
              width: 7,
              height: 7,
              bitWidth: 32,
            },
            {
              ...slice.nodes[3].ports[2],
              x: 586.5,
              y: 54.5,
              width: 7,
              height: 7,
              bitWidth: 32,
            },
          ],
        },
      ],
    };

    const onConstantRadixChange = vi.fn();
    const onLayoutProfileChange = vi.fn();
    const onFlattenRenderModeChange = vi.fn();
    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={onFlattenRenderModeChange}
        layoutProfile="auto"
        onLayoutProfileChange={onLayoutProfileChange}
        constantRadix="hex"
        onConstantRadixChange={onConstantRadixChange}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />,
    );

    const constant = view.container.querySelector(".kind-constant");
    expect(constant?.querySelector(".constant-value")?.textContent).toBe("8'h0");
    expect(constant?.querySelector("rect")).toBeNull();
    expect(constant?.querySelector(".node-port circle")).toBeNull();

    const register = view.container.querySelector(".kind-register");
    expect(register?.querySelector(".node-shape")?.classList.contains("storage-element")).toBe(
      true,
    );
    expect(register?.querySelector(".storage-element")?.getAttribute("x")).toBe("0");
    expect(register?.querySelector(".storage-element")?.getAttribute("width")).toBe("104");
    expect(register?.querySelector(".role-clock circle")).toBeNull();
    expect(register?.querySelector(".clock-marker")?.getAttribute("d")).toBe("M0,85 l18,9 l-18,9");
    expect(register?.querySelector(".role-reset.active-low circle")).not.toBeNull();
    expect(register?.querySelector(".register-control-label")?.textContent).toBe("ALOAD");
    const submodule = view.container.querySelector(".kind-module .node-shape");
    expect(submodule?.classList.contains("submodule-instance")).toBe(true);
    expect(submodule?.classList.contains("transparent-boundary")).toBe(false);
    const memory = view.container.querySelector(".kind-memory");
    expect(memory?.querySelector(".memory-element")).not.toBeNull();
    expect(
      [...(memory?.querySelectorAll(".port-label") ?? [])].map((label) => label.textContent),
    ).toEqual(["RD_CLK", "RD_ARST_VALUE", "RD_DATA"]);
    const widthAnnotation = view.container.querySelector(".bus-width-annotation");
    expect(widthAnnotation?.querySelector("text")?.textContent).toBe("686");
    expect(widthAnnotation?.querySelector("rect")?.getAttribute("width")).toBe("21.5");
    expect(widthAnnotation?.querySelector("rect")?.getAttribute("x")).toBe("-10.75");
    expect(widthAnnotation?.querySelector("path")?.getAttribute("d")).toBe("M-3,3 L3,-3");
    fireEvent.change(screen.getByLabelText("Constant number format"), {
      target: { value: "decimal" },
    });
    expect(onConstantRadixChange).toHaveBeenCalledWith("decimal");
    expect(screen.getByLabelText("Schematic layout profile").textContent).toContain("Auto");
    expect(screen.getByLabelText("Schematic layout profile").textContent).not.toContain("(");
    fireEvent.click(screen.getByLabelText("Schematic layout profile"));
    const fastOption = screen.getByRole("menuitemradio", { name: /Fast grouped grid/ });
    expect(fastOption.textContent).toContain("simple grouped grid");
    expect(fastOption.textContent).not.toContain("ELK");
    fireEvent.click(fastOption);
    expect(onLayoutProfileChange).toHaveBeenCalledWith("fast");
    expect(screen.getByLabelText("Flatten render mode").textContent).toContain("Grouped");
    fireEvent.click(screen.getByLabelText("Flatten render mode"));
    const groupedMode = screen.getByRole("menuitemradio", { name: /Grouped/ });
    const flatMode = screen.getByRole("menuitemradio", { name: /Flat/ });
    expect(groupedMode.textContent).toContain("non-overlapping region");
    expect(flatMode.textContent).toContain("one flat graph");
    fireEvent.click(flatMode);
    expect(onFlattenRenderModeChange).toHaveBeenCalledWith("flat");
    expect(layoutHarness.receivedModes.at(-1)).toBe("grouped");
  });

  it("renders boolean operators with standard gate outlines and inversion bubbles", () => {
    const definitions = [
      ["and", "&"],
      ["or", "|"],
      ["xor", "^"],
      ["nand", "NAND"],
      ["nor", "NOR"],
      ["xnor", "~^"],
      ["not", "!"],
      ["buffer", "→"],
    ] as const;
    const nodes = definitions.map(([id, glyph]) => ({
      id,
      kind: "operator" as const,
      label: id,
      glyph,
      ports: [
        { id: `${id}-a`, name: "A", direction: "input" as const, role: "data" as const },
        ...(id === "not" || id === "buffer"
          ? []
          : [{ id: `${id}-b`, name: "B", direction: "input" as const, role: "data" as const }]),
        { id: `${id}-y`, name: "Y", direction: "output" as const, role: "data" as const },
      ],
    }));
    const slice = {
      snapshotId: "logic-gates",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes,
      edges: [],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 700,
      height: 220,
      groups: [],
      edges: [],
      elapsedMs: 1,
      nodes: nodes.map((node, index) => {
        const x = 20 + (index % 4) * 160;
        const y = 25 + Math.floor(index / 4) * 100;
        const inputs = node.ports.filter((port) => port.direction === "input");
        return {
          ...node,
          x,
          y,
          width: 68,
          height: 58,
          ports: node.ports.map((port) => {
            const inputIndex = inputs.findIndex((candidate) => candidate.id === port.id);
            const centerY =
              port.direction === "output" ? 29 : (58 * (inputIndex + 1)) / (inputs.length + 1);
            return {
              ...port,
              x: x + (port.direction === "output" ? 64.5 : -3.5),
              y: y + centerY - 3.5,
              width: 7,
              height: 7,
            };
          }),
        };
      }),
    };

    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: false,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />,
    );

    for (const [id] of definitions) {
      expect(view.container.querySelector(`.gate-${id} .gate-body`)).not.toBeNull();
    }
    expect(view.container.querySelectorAll(".gate-inversion")).toHaveLength(4);
    expect(view.container.querySelectorAll(".gate-xor-arc")).toHaveLength(2);
    expect(view.container.querySelectorAll(".logic-gate .operator-glyph")).toHaveLength(0);
    expect(view.container.querySelectorAll(".kind-operator .node-port circle")).toHaveLength(0);
    expect(view.container.querySelectorAll(".logic-gate .symbol-port-lead")).toHaveLength(0);
  });

  it("points output boundary symbols toward the outside of the circuit", () => {
    const slice = {
      snapshotId: "boundary-symbols",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "a",
          kind: "input",
          label: "a",
          ports: [{ id: "a-y", name: "a", direction: "output", width: 8 }],
        },
        {
          id: "y",
          kind: "output",
          label: "very_long_output_name",
          ports: [{ id: "y-a", name: "y", direction: "input", width: 8 }],
        },
      ],
      edges: [],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 300,
      height: 120,
      groups: [],
      edges: [],
      elapsedMs: 1,
      nodes: slice.nodes.map((node, index) => ({
        ...node,
        x: index * 180 + 20,
        y: 40,
        width: 76,
        height: 34,
        ports: [
          {
            ...node.ports[0],
            x: index === 0 ? index * 180 + 92.5 : index * 180 + 16.5,
            y: 53.5,
            width: 7,
            height: 7,
            bitWidth: 8,
          },
        ],
      })),
    };

    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: false,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />,
    );

    const inputPath = view.container.querySelector(".kind-input .node-shape")?.getAttribute("d");
    const outputPath = view.container.querySelector(".kind-output .node-shape")?.getAttribute("d");
    expect(inputPath).toBe("M0,7 H63 L76,17 L63,27 H0 Z");
    expect(outputPath).toBe("M0,7 H63 L76,17 L63,27 H0 Z");
    const boundaryHitTargets = view.container.querySelectorAll(".node-hit");
    expect(boundaryHitTargets).toHaveLength(2);
    expect(boundaryHitTargets[1]?.getAttribute("x")).toBe("131.5");
    expect(boundaryHitTargets[1]?.getAttribute("width")).toBe("144.5");
    expect(boundaryHitTargets[1]?.getAttribute("y")).toBe("18");
    expect(boundaryHitTargets[1]?.getAttribute("height")).toBe("78");
    expect(view.container.querySelectorAll(".kind-input .node-port circle")).toHaveLength(0);
    expect(view.container.querySelectorAll(".kind-output .node-port circle")).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Signals" }));
    expect(view.getByText("No clocks detected at this level.")).toBeTruthy();
    expect(view.getByText("No resets detected at this level.")).toBeTruthy();
  });

  it("indexes mux choices and ordered binary operands at their physical ports", () => {
    const slice = {
      snapshotId: "mux-symbol",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "mux",
          kind: "mux",
          label: "MUX",
          ports: [
            { id: "a", name: "A", direction: "input", index: 0, role: "data" },
            { id: "b", name: "B", direction: "input", index: 1, role: "data" },
            { id: "s", name: "S", direction: "input", role: "select" },
            { id: "y", name: "Y", direction: "output", role: "data" },
          ],
        },
        {
          id: "sub",
          kind: "operator",
          label: "Subtract",
          glyph: "−",
          ports: [
            { id: "sub-a", name: "A", direction: "input", index: 0, role: "data" },
            { id: "sub-b", name: "B", direction: "input", index: 1, role: "data" },
            { id: "sub-y", name: "Y", direction: "output", role: "data" },
          ],
        },
      ],
      edges: [],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 220,
      height: 220,
      groups: [],
      edges: [],
      elapsedMs: 1,
      nodes: [
        {
          ...slice.nodes[0],
          x: 70,
          y: 30,
          width: 74,
          height: 138,
          ports: [
            { ...slice.nodes[0].ports[0], x: 66.5, y: 65, width: 7, height: 7 },
            { ...slice.nodes[0].ports[1], x: 66.5, y: 115, width: 7, height: 7 },
            { ...slice.nodes[0].ports[2], x: 103.5, y: 164.5, width: 7, height: 7 },
            { ...slice.nodes[0].ports[3], x: 140.5, y: 92, width: 7, height: 7 },
          ],
        },
        {
          ...slice.nodes[1],
          x: 150,
          y: 30,
          width: 58,
          height: 58,
          ports: [
            { ...slice.nodes[1].ports[0], x: 146.5, y: 40, width: 7, height: 7 },
            { ...slice.nodes[1].ports[1], x: 146.5, y: 70, width: 7, height: 7 },
            { ...slice.nodes[1].ports[2], x: 204.5, y: 55.5, width: 7, height: 7 },
          ],
        },
      ],
    };

    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: false,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />,
    );

    const mux = view.container.querySelector(".kind-mux");
    const lead = mux?.querySelector(".mux-select-lead");
    expect(lead?.getAttribute("x1")).toBe("37");
    expect(lead?.getAttribute("x2")).toBe("37");
    expect(Number(lead?.getAttribute("y1"))).toBeLessThan(Number(lead?.getAttribute("y2")));
    expect(lead?.getAttribute("y2")).toBe("138");
    expect(mux?.querySelector(".node-shape")?.getAttribute("d")).toBe(
      "M0,5 L74,30.36 L74,107.64 L0,133 Z",
    );
    expect(mux?.querySelectorAll(".node-port circle")).toHaveLength(0);
    expect(
      [...(mux?.querySelectorAll(".mux-input-index") ?? [])].map((label) => label.textContent),
    ).toEqual(["0", "1"]);

    const subtraction = view.container.querySelector(".kind-operator");
    const operandLabels = [...(subtraction?.querySelectorAll(".operand-order-label") ?? [])];
    expect(operandLabels.map((label) => label.textContent)).toEqual(["lhs", "rhs"]);
    expect(Number(operandLabels[0]?.getAttribute("y"))).toBeLessThan(
      Number(operandLabels[1]?.getAttribute("y")),
    );
    expect(subtraction?.querySelectorAll(".symbol-port-lead")).toHaveLength(3);
    expect(subtraction?.querySelectorAll(".node-port circle")).toHaveLength(0);
  });

  it("hides a control trace without changing its routed geometry or layout input", () => {
    const slice = {
      snapshotId: "signal-visibility",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "clk",
          kind: "input",
          label: "clk",
          ports: [{ id: "clk-y", name: "clk", direction: "output", role: "clock" }],
        },
        {
          id: "state",
          kind: "register",
          label: "state",
          ports: [{ id: "state-clk", name: "CLK", direction: "input", role: "clock" }],
        },
      ],
      edges: [
        {
          id: "clk-state",
          sourceNode: "clk",
          sourcePort: "clk-y",
          targetNode: "state",
          targetPort: "state-clk",
          label: "clk",
          role: "clock",
        },
      ],
    } satisfies GraphSlice;
    layoutHarness.receivedSlices = [];
    layoutHarness.layout = {
      width: 300,
      height: 180,
      groups: [],
      elapsedMs: 1,
      edges: [
        {
          ...slice.edges[0],
          sections: [
            {
              startPoint: { x: 84, y: 87 },
              bendPoints: [{ x: 120, y: 87 }],
              endPoint: { x: 150, y: 87 },
            },
          ],
        },
      ],
      nodes: [
        {
          ...slice.nodes[0],
          x: 8,
          y: 70,
          width: 76,
          height: 34,
          ports: [{ ...slice.nodes[0].ports[0], x: 80.5, y: 83.5, width: 7, height: 7 }],
        },
        {
          ...slice.nodes[1],
          x: 150,
          y: 30,
          width: 104,
          height: 116,
          ports: [{ ...slice.nodes[1].ports[0], x: 146.5, y: 83.5, width: 7, height: 7 }],
        },
      ],
    };

    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
      />,
    );

    const edge = view.container.querySelector(".schematic-edge.role-clock");
    const path = edge?.querySelector(".edge-line")?.getAttribute("d");
    fireEvent.click(screen.getByRole("button", { name: /Signals/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "clk" }));

    expect(edge?.classList.contains("hidden-signal")).toBe(true);
    expect(edge?.querySelector(".edge-line")?.getAttribute("d")).toBe(path);
    expect(edge?.querySelector(".bus-width-annotation")).toBeNull();
    expect(view.container.querySelectorAll(".schematic-node")).toHaveLength(2);
    expect(view.container.querySelector(".canvas-status")?.textContent).toContain("2 nodes");
    expect(view.container.querySelector(".canvas-status")?.textContent).toContain("1 nets");
    expect(layoutHarness.receivedSlices.every((received) => received === slice)).toBe(true);
  });
});

describe("SchematicCanvas comparison presentation", () => {
  it("styles statuses, filters without relayout, and changes matching policy", () => {
    const slice = {
      snapshotId: "comparison",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        { id: "old", kind: "operator", label: "old", glyph: "+", ports: [] },
        { id: "new", kind: "operator", label: "new", glyph: "−", ports: [] },
        { id: "old-constant", kind: "constant", label: "1'b0", ports: [] },
        { id: "new-constant", kind: "constant", label: "1'b1", ports: [] },
        { id: "changed-constant", kind: "constant", label: "2'b10", ports: [] },
      ],
      edges: [
        { id: "changed-net", sourceNode: "old", targetNode: "new", label: "value" },
        { id: "old-net", sourceNode: "old", targetNode: "new", label: "old value" },
        { id: "new-net", sourceNode: "old", targetNode: "new", label: "new value" },
      ],
    } satisfies GraphSlice;
    layoutHarness.receivedSlices = [];
    layoutHarness.layout = {
      width: 300,
      height: 160,
      groups: [],
      elapsedMs: 1,
      disconnectedRegion: {
        x: 10,
        y: 30,
        width: 280,
        height: 120,
        componentCount: 2,
        componentEntityIds: [["old"], ["new"]],
      },
      nodes: [
        { ...slice.nodes[0], x: 30, y: 55, width: 50, height: 50, ports: [] },
        { ...slice.nodes[1], x: 210, y: 55, width: 50, height: 50, ports: [] },
        { ...slice.nodes[2], x: 90, y: 120, width: 38, height: 22, ports: [] },
        { ...slice.nodes[3], x: 135, y: 120, width: 38, height: 22, ports: [] },
        { ...slice.nodes[4], x: 180, y: 120, width: 38, height: 22, ports: [] },
      ],
      edges: slice.edges.map((edge) => ({
        ...edge,
        sections: [
          {
            startPoint: { x: 80, y: 80 },
            bendPoints: [],
            endPoint: { x: 210, y: 80 },
          },
        ],
      })),
    };
    const onSelect = vi.fn();
    const onPolicyChange = vi.fn();
    const view = render(
      <SchematicCanvas
        slice={slice}
        selectedId="new"
        focusEntityId="new"
        focusEntityRevision={1}
        onSelect={onSelect}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "conservative",
          onPolicyChange,
          entities: {
            old: { status: "removed", referenceId: "old" },
            new: {
              status: "added",
              candidateId: "new",
              matchMethod: "heuristic",
              confidence: { score: 0.77, band: "medium", evidence: ["same neighbors"] },
              sourceHighlighted: true,
            },
            "changed-net": { status: "modified" },
            "old-net": { status: "removed", referenceId: "old-net" },
            "new-net": { status: "added", candidateId: "new-net" },
            "old-constant": { status: "removed", referenceId: "old-constant" },
            "new-constant": {
              status: "added",
              candidateId: "new-constant",
              matchMethod: "heuristic",
              sourceHighlighted: true,
            },
            "changed-constant": { status: "modified" },
          },
        }}
      />,
    );

    const removed = view.container.querySelector('[href="#schematic-old"]');
    const added = view.container.querySelector('[href="#schematic-new"]');
    const modified = view.container.querySelector('[href="#schematic-changed-net"]');
    const removedEdge = view.container.querySelector('[href="#schematic-old-net"]');
    const addedEdge = view.container.querySelector('[href="#schematic-new-net"]');
    const removedConstant = view.container.querySelector('[href="#schematic-old-constant"]');
    const addedConstant = view.container.querySelector('[href="#schematic-new-constant"]');
    const modifiedConstant = view.container.querySelector('[href="#schematic-changed-constant"]');
    expect(removed?.classList.contains("diff-removed")).toBe(true);
    expect(added?.classList.contains("diff-added")).toBe(true);
    expect(added?.classList.contains("diff-heuristic")).toBe(true);
    expect(added?.classList.contains("source-cross-probed")).toBe(true);
    expect(added?.querySelector(".node-shape.selected")).not.toBeNull();
    expect(added?.getAttribute("aria-label")).toContain("intersects selected source hunk");
    expect(modified?.classList.contains("diff-modified")).toBe(true);
    expect(removedEdge?.querySelector(".edge-line")?.getAttribute("transform")).toBe(
      "translate(0 -2.5)",
    );
    expect(addedEdge?.querySelector(".edge-line")?.getAttribute("transform")).toBe(
      "translate(0 2.5)",
    );
    expect(removedConstant?.querySelector(".diff-constant-outline.removed")).not.toBeNull();
    expect(removedConstant?.querySelector(".constant-value")?.textContent).toBe("1'b0");
    expect(addedConstant?.querySelector(".diff-constant-outline.added")).not.toBeNull();
    expect(addedConstant?.querySelector(".constant-value")?.textContent).toBe("1'b1");
    expect(addedConstant?.classList).toContain("diff-heuristic");
    expect(addedConstant?.classList).toContain("source-cross-probed");
    expect(addedConstant?.getAttribute("aria-label")).toContain("heuristic match");
    expect(modifiedConstant?.querySelector(".diff-modified-outline")).not.toBeNull();
    expect(modifiedConstant?.classList).toContain("diff-modified");
    expect(view.container.querySelector(".diff-node-badge")).toBeNull();
    expect(view.container.querySelector(".diff-edge-badge")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Schematic comparison view:/ }).textContent,
    ).toContain("Diff overlay");
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
    expect(screen.getByText("2 isolated components")).toBeTruthy();
    expect(view.container.querySelector<HTMLElement>(".schematic-stage")?.style.transform).toBe(
      "none",
    );

    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "aggressive" },
    });
    expect(onPolicyChange).toHaveBeenCalledWith("aggressive");

    chooseComparisonView("Reference snapshot");
    expect(removedEdge?.classList).toContain("diff-unchanged");
    expect(addedEdge?.classList).toContain("diff-filtered");
    expect(removedEdge?.querySelector(".edge-line")?.getAttribute("transform")).toBeNull();
    chooseComparisonView("Candidate snapshot");
    expect(removedEdge?.classList).toContain("diff-filtered");
    expect(addedEdge?.classList).toContain("diff-unchanged");
    expect(addedEdge?.querySelector(".edge-line")?.getAttribute("transform")).toBeNull();
    chooseComparisonView("Diff overlay");
    expect(removedEdge?.querySelector(".edge-line")?.getAttribute("transform")).toBe(
      "translate(0 -2.5)",
    );
    expect(addedEdge?.querySelector(".edge-line")?.getAttribute("transform")).toBe(
      "translate(0 2.5)",
    );

    const viewButton = screen.getByRole("button", { name: /Schematic comparison view:/ });
    fireEvent.click(viewButton);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Diff overlay" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Added in candidate" }));
    expect(added?.classList.contains("diff-filtered")).toBe(true);
    expect(
      screen.getByRole("button", { name: /Schematic comparison view:/ }).textContent,
    ).toContain("Custom overlay");
    expect(screen.getByText("1 isolated component")).toBeTruthy();
    expect(layoutHarness.receivedSlices.every((received) => received === slice)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(viewButton);

    fireEvent.click(screen.getByRole("button", { name: "Next schematic change" }));
    expect(onSelect).toHaveBeenCalledWith("old");

    fireEvent.click(viewButton);
    for (const status of ["Missing from candidate", "Modified"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: status }));
    }
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(viewButton);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Reference snapshot" }));
  });

  it("fits changes-only to changed geometry without changing the union layout", () => {
    const slice = {
      snapshotId: "sparse-flattened-comparison",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        { id: "irrelevant", kind: "operator", label: "irrelevant", glyph: "+", ports: [] },
        { id: "context", kind: "operator", label: "context", glyph: "+", ports: [] },
        { id: "changed", kind: "operator", label: "changed", glyph: "−", ports: [] },
      ],
      edges: [{ id: "changed-edge", sourceNode: "context", targetNode: "changed" }],
    } satisfies GraphSlice;
    layoutHarness.receivedSlices = [];
    layoutHarness.layout = {
      width: 6_000,
      height: 4_000,
      elapsedMs: 1,
      groups: [],
      nodes: [
        { ...slice.nodes[0], x: 50, y: 50, width: 200, height: 100, ports: [] },
        { ...slice.nodes[1], x: 4_650, y: 3_100, width: 50, height: 60, ports: [] },
        { ...slice.nodes[2], x: 4_800, y: 3_100, width: 80, height: 60, ports: [] },
      ],
      edges: [
        {
          ...slice.edges[0],
          sections: [
            {
              startPoint: { x: 4_700, y: 3_130 },
              bendPoints: [],
              endPoint: { x: 4_800, y: 3_130 },
            },
          ],
        },
      ],
    };

    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={8}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="flat"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "conservative",
          onPolicyChange: vi.fn(),
          entities: {
            irrelevant: { status: "unchanged" },
            context: { status: "unchanged" },
            changed: { status: "modified" },
            "changed-edge": { status: "unchanged" },
          },
        }}
      />,
    );

    const viewport = view.container.querySelector(".schematic-viewport");
    const fit = screen.getByRole("button", { name: "Fit schematic" });
    expect(viewport?.getAttribute("viewBox")).toBe("0 0 6000 4000");

    chooseComparisonView("Changes only");
    expect(viewport?.getAttribute("viewBox")).toBe("4626 3076 278 108");
    expect(screen.getByText("2158%")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /operator context.*context for visible change/ }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /operator irrelevant/ }).classList).toContain(
      "diff-filtered",
    );
    expect(
      screen.getByRole("link", {
        name: "Select net unlabeled net from context to changed, Unchanged, context for visible change",
      }),
    ).toBeTruthy();

    viewport?.setAttribute("viewBox", "0 0 6000 4000");
    fireEvent.click(fit);
    expect(viewport?.getAttribute("viewBox")).toBe("4626 3076 278 108");

    chooseComparisonView("Diff overlay");
    expect(viewport?.getAttribute("viewBox")).toBe("4626 3076 278 108");
    fireEvent.click(fit);
    expect(viewport?.getAttribute("viewBox")).toBe("0 0 6000 4000");
    expect(layoutHarness.receivedSlices.every((received) => received === slice)).toBe(true);
  });

  it("refits replacement-policy changes instead of focusing a retained hidden selection", () => {
    const conservativeSlice = {
      snapshotId: "conservative-union",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        { id: "retained", kind: "operator", label: "retained", glyph: "+", ports: [] },
        { id: "old-change", kind: "operator", label: "old", glyph: "−", ports: [] },
      ],
      edges: [],
    } satisfies GraphSlice;
    const aggressiveSlice = {
      ...conservativeSlice,
      snapshotId: "aggressive-union",
      nodes: [
        conservativeSlice.nodes[0],
        { id: "new-change", kind: "operator", label: "new", glyph: "−", ports: [] },
      ],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 6_000,
      height: 4_000,
      elapsedMs: 1,
      groups: [],
      edges: [],
      nodes: [
        { ...conservativeSlice.nodes[0], x: 100, y: 100, width: 50, height: 50, ports: [] },
        {
          ...conservativeSlice.nodes[1],
          x: 4_800,
          y: 3_100,
          width: 80,
          height: 60,
          ports: [],
        },
      ],
    };
    const sharedProps = {
      onSelect: vi.fn(),
      onOpenInstance: vi.fn(),
      canGoUp: false,
      onGoUp: vi.fn(),
      onGoTop: vi.fn(),
      labelSettings: {
        nets: true,
        signalTypes: false,
        bitWidths: true,
        instances: true,
        definitions: true,
      },
      onToggleLabel: vi.fn(),
      flattenDepth: 0,
      onFlattenDepthChange: vi.fn(),
      flattenRenderMode: "flat" as const,
      onFlattenRenderModeChange: vi.fn(),
      layoutProfile: "auto" as const,
      onLayoutProfileChange: vi.fn(),
      constantRadix: "binary" as const,
      onConstantRadixChange: vi.fn(),
      onFlattenInstance: vi.fn(),
      onRestoreInstance: vi.fn(),
      individuallyFlattened: false,
      topLevelDefines: [],
      inspectorOpen: false,
      onToggleInspector: vi.fn(),
    };
    const view = render(
      <SchematicCanvas
        {...sharedProps}
        slice={conservativeSlice}
        selectedId="retained"
        focusEntityId="retained"
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "conservative",
          onPolicyChange: vi.fn(),
          entities: {
            retained: { status: "unchanged" },
            "old-change": { status: "removed" },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Schematic comparison view:/ }));
    expect(screen.queryByRole("checkbox", { name: "Modified" })).toBeNull();
    expect(view.container.querySelector(".diff-count.modified")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Schematic comparison view:/ }));
    chooseComparisonView("Changes only");
    const viewport = view.container.querySelector(".schematic-viewport");
    expect(viewport?.getAttribute("viewBox")).toBe("4776 3076 128 108");

    layoutHarness.layout = {
      width: 6_000,
      height: 4_000,
      elapsedMs: 1,
      groups: [],
      edges: [],
      nodes: [
        {
          ...aggressiveSlice.nodes[0],
          x: 5_200,
          y: 3_400,
          width: 50,
          height: 50,
          ports: [],
        },
        {
          ...aggressiveSlice.nodes[1],
          x: 100,
          y: 100,
          width: 80,
          height: 60,
          ports: [],
        },
      ],
    };
    view.rerender(
      <SchematicCanvas
        {...sharedProps}
        slice={aggressiveSlice}
        selectedId="retained"
        focusEntityId="retained"
        focusEntityRevision={1}
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "aggressive",
          onPolicyChange: vi.fn(),
          entities: {
            retained: { status: "unchanged" },
            "new-change": { status: "added" },
          },
        }}
      />,
    );

    expect(viewport?.getAttribute("viewBox")).toBe("76 76 128 108");
    expect(screen.getByRole("link", { name: /operator retained/ }).classList).toContain(
      "diff-filtered",
    );
  });

  it("keeps overlay zoom while centering a retained entity after policy layout replacement", () => {
    const conservativeSlice = {
      snapshotId: "overlay-conservative",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        { id: "retained", kind: "operator", label: "retained", glyph: "+", ports: [] },
        { id: "change", kind: "operator", label: "change", glyph: "−", ports: [] },
      ],
      edges: [],
    } satisfies GraphSlice;
    const aggressiveSlice = { ...conservativeSlice, snapshotId: "overlay-aggressive" };
    const comparison = (policy: "conservative" | "aggressive") => ({
      referenceName: "reference.nettle",
      candidateName: "candidate.nettle",
      policy,
      onPolicyChange: vi.fn(),
      entities: {
        retained: { status: "unchanged" as const },
        change: { status: "modified" as const },
      },
    });
    layoutHarness.layout = {
      width: 6_000,
      height: 4_000,
      elapsedMs: 1,
      groups: [],
      edges: [],
      nodes: [
        {
          ...conservativeSlice.nodes[0],
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          ports: [],
        },
        {
          ...conservativeSlice.nodes[1],
          x: 4_800,
          y: 3_100,
          width: 80,
          height: 60,
          ports: [],
        },
      ],
    };
    const canvas = (slice: GraphSlice, policy: "conservative" | "aggressive") => (
      <SchematicCanvas
        slice={slice}
        selectedId="retained"
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="flat"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
        comparison={comparison(policy)}
      />
    );
    const view = render(canvas(conservativeSlice, "conservative"));
    const viewport = view.container.querySelector(".schematic-viewport");
    chooseComparisonView("Changes only");
    expect(viewport?.getAttribute("viewBox")).toBe("4776 3076 128 108");
    chooseComparisonView("Diff overlay");

    layoutHarness.layout = {
      width: 6_000,
      height: 4_000,
      elapsedMs: 1,
      groups: [],
      edges: [],
      nodes: [
        {
          ...aggressiveSlice.nodes[0],
          x: 300,
          y: 200,
          width: 50,
          height: 50,
          ports: [],
        },
        {
          ...aggressiveSlice.nodes[1],
          x: 400,
          y: 200,
          width: 80,
          height: 60,
          ports: [],
        },
      ],
    };
    view.rerender(canvas(aggressiveSlice, "aggressive"));

    expect(viewport?.getAttribute("viewBox")).toBe("261 171 128 108");
  });

  it("renders reference and candidate semantics over stable union geometry", () => {
    const reference = {
      snapshotId: "reference",
      module: {
        id: "reference-top",
        name: "reference-top",
        instancePath: "reference-top",
        definitionName: "reference-top-definition",
        parameters: { REF_TOP: "reference-top-value" },
      },
      nodes: [
        {
          id: "reference-boundary",
          kind: "input",
          label: "reference-input",
          ports: [
            {
              id: "reference-boundary-port",
              name: "reference-boundary-port",
              direction: "output",
              width: 8,
            },
          ],
        },
        {
          id: "reference-operator",
          kind: "operator",
          label: "reference-operator",
          glyph: "+",
          ports: [],
        },
        {
          id: "reference-node",
          kind: "module",
          label: "reference-instance",
          definitionName: "reference-child",
          parameters: { REF_NODE: "reference-node-value" },
          ports: [
            {
              id: "reference-common",
              name: "reference-common",
              direction: "input",
              width: 8,
            },
            {
              id: "reference-only",
              name: "reference-only",
              direction: "input",
              width: 2,
            },
          ],
        },
      ],
      edges: [
        {
          id: "reference-edge",
          sourceNode: "reference-boundary",
          targetNode: "reference-operator",
          label: "reference-edge",
          width: 8,
          signalType: "reference-type",
          role: "clock",
        },
      ],
      groups: [
        {
          id: "reference-group",
          name: "reference-group",
          definitionName: "reference-group-definition",
          parameters: { REF_GROUP: "reference-group-value" },
          childNodeIds: ["reference-boundary", "reference-operator", "reference-node"],
        },
      ],
    } satisfies GraphSlice;
    const candidate = {
      snapshotId: "candidate",
      module: {
        id: "candidate-top",
        name: "candidate-top",
        instancePath: "candidate-top",
        definitionName: "candidate-top-definition",
        parameters: { CAND_TOP: "candidate-top-value" },
      },
      nodes: [
        {
          id: "candidate-boundary",
          kind: "input",
          label: "candidate-input",
          ports: [
            {
              id: "candidate-boundary-port",
              name: "candidate-boundary-port",
              direction: "output",
              width: 16,
            },
          ],
        },
        {
          id: "candidate-operator",
          kind: "operator",
          label: "candidate-operator",
          glyph: "−",
          ports: [],
        },
        {
          id: "candidate-node",
          kind: "module",
          label: "candidate-instance",
          definitionName: "candidate-child",
          parameters: { CAND_NODE: "candidate-node-value" },
          ports: [
            {
              id: "candidate-common",
              name: "candidate-common",
              direction: "input",
              width: 16,
            },
            {
              id: "candidate-only",
              name: "candidate-only",
              direction: "input",
              width: 4,
            },
          ],
        },
      ],
      edges: [
        {
          id: "candidate-edge",
          sourceNode: "candidate-boundary",
          targetNode: "candidate-operator",
          label: "candidate-edge",
          width: 16,
          signalType: "candidate-type",
          role: "reset",
        },
      ],
      groups: [
        {
          id: "candidate-group",
          name: "candidate-group",
          definitionName: "candidate-group-definition",
          parameters: { CAND_GROUP: "candidate-group-value" },
          childNodeIds: ["candidate-boundary", "candidate-operator", "candidate-node"],
        },
      ],
    } satisfies GraphSlice;
    const slice = {
      snapshotId: "union",
      module: { ...candidate.module, id: "top" },
      nodes: [
        {
          ...candidate.nodes[0],
          id: "boundary",
          ports: [{ ...candidate.nodes[0].ports[0], id: "boundary-port" }],
        },
        { ...candidate.nodes[1], id: "operator" },
        {
          ...candidate.nodes[2],
          id: "node",
          ports: [
            { ...candidate.nodes[2].ports[0], id: "common" },
            { ...reference.nodes[2].ports[1], id: "removed-port" },
            { ...candidate.nodes[2].ports[1], id: "added-port" },
          ],
        },
      ],
      edges: [
        {
          ...candidate.edges[0],
          id: "edge",
          sourceNode: "boundary",
          sourcePort: "boundary-port",
          targetNode: "operator",
        },
      ],
      groups: [
        {
          ...candidate.groups[0],
          id: "group",
          childNodeIds: ["boundary", "operator", "node"],
        },
      ],
    } satisfies GraphSlice;
    const comparisonSlice = {
      reference,
      candidate,
      union: slice,
      nodes: [
        {
          id: "boundary",
          status: "modified",
          reference: reference.nodes[0],
          candidate: candidate.nodes[0],
        },
        {
          id: "operator",
          status: "modified",
          reference: reference.nodes[1],
          candidate: candidate.nodes[1],
        },
        {
          id: "node",
          status: "modified",
          reference: reference.nodes[2],
          candidate: candidate.nodes[2],
        },
      ],
      ports: [
        {
          id: "boundary-port",
          nodeId: "boundary",
          status: "modified",
          referenceNodeId: "reference-boundary",
          candidateNodeId: "candidate-boundary",
          reference: reference.nodes[0].ports[0],
          candidate: candidate.nodes[0].ports[0],
        },
        {
          id: "common",
          nodeId: "node",
          status: "modified",
          referenceNodeId: "reference-node",
          candidateNodeId: "candidate-node",
          reference: reference.nodes[2].ports[0],
          candidate: candidate.nodes[2].ports[0],
        },
        {
          id: "removed-port",
          nodeId: "node",
          status: "removed",
          referenceNodeId: "reference-node",
          reference: reference.nodes[2].ports[1],
        },
        {
          id: "added-port",
          nodeId: "node",
          status: "added",
          candidateNodeId: "candidate-node",
          candidate: candidate.nodes[2].ports[1],
        },
      ],
      edges: [
        {
          id: "edge",
          status: "modified",
          reference: reference.edges[0],
          candidate: candidate.edges[0],
        },
      ],
      groups: [
        {
          id: "group",
          status: "modified",
          reference: reference.groups[0],
          candidate: candidate.groups[0],
        },
      ],
      policy: "conservative",
      heuristicMatchCount: 0,
    } satisfies ComparisonSlice;
    layoutHarness.receivedSlices = [];
    layoutHarness.layout = {
      width: 500,
      height: 260,
      elapsedMs: 1,
      groups: [{ ...slice.groups[0], x: 10, y: 58, width: 480, height: 185 }],
      nodes: [
        {
          ...slice.nodes[0],
          x: 18,
          y: 120,
          width: 80,
          height: 40,
          ports: [
            {
              ...slice.nodes[0].ports[0],
              x: 94.5,
              y: 136.5,
              width: 7,
              height: 7,
              bitWidth: 16,
            },
          ],
        },
        { ...slice.nodes[1], x: 140, y: 115, width: 50, height: 50, ports: [] },
        {
          ...slice.nodes[2],
          x: 270,
          y: 82,
          width: 180,
          height: 130,
          ports: [
            {
              ...slice.nodes[2].ports[0],
              x: 266.5,
              y: 101.5,
              width: 7,
              height: 7,
              bitWidth: 16,
            },
            {
              ...slice.nodes[2].ports[1],
              x: 266.5,
              y: 131.5,
              width: 7,
              height: 7,
              bitWidth: 2,
            },
            {
              ...slice.nodes[2].ports[2],
              x: 266.5,
              y: 161.5,
              width: 7,
              height: 7,
              bitWidth: 4,
            },
          ],
        },
      ],
      edges: [
        {
          ...slice.edges[0],
          sections: [
            {
              startPoint: { x: 98, y: 140 },
              bendPoints: [],
              endPoint: { x: 140, y: 140 },
            },
          ],
        },
      ],
    };

    const onSemanticSideChange = vi.fn();
    const view = render(
      <SchematicCanvas
        slice={slice}
        selectedId="group"
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: true,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "conservative",
          onPolicyChange: vi.fn(),
          entities: {
            [TOP_MODULE_ID]: { status: "modified" },
            boundary: { status: "modified" },
            operator: { status: "modified" },
            node: { status: "modified" },
            edge: { status: "modified" },
            group: { status: "modified", matchMethod: "heuristic", sourceHighlighted: true },
          },
          comparisonSlice,
          referenceDefines: [{ name: "REFERENCE_BUILD" }],
          candidateDefines: [{ name: "CANDIDATE_BUILD" }],
          onSemanticSideChange,
        }}
      />,
    );
    const node = () => view.container.querySelector('[href="#schematic-node"]');
    const edge = () => view.container.querySelector('[href="#schematic-edge"]');
    const portLabels = () =>
      [...(node()?.querySelectorAll(".port-label") ?? [])].map((label) => label.textContent);
    const visibleLabel = (selector: string) =>
      view.container.querySelector(selector)?.lastChild?.textContent;
    const geometry = () => ({
      edge: edge()?.querySelector(".edge-line")?.getAttribute("d"),
      node: node()?.querySelector(".schematic-node")?.getAttribute("transform"),
      group: view.container.querySelector(".transparent-group")?.getAttribute("transform"),
      viewBox: view.container.querySelector(".schematic-viewport")?.getAttribute("viewBox"),
    });
    const unionGeometry = geometry();

    expect(visibleLabel(".top-level-title")).toBe("candidate-top");
    expect(view.container.querySelector(".operator-glyph")?.textContent).toBe("−");
    expect(portLabels()).toEqual(["candidate-common", "reference-only", "candidate-only"]);
    expect(node()?.classList).toContain("diff-modified");
    expect(edge()?.classList).toContain("diff-modified");
    expect(node()?.querySelector(".diff-modified-outline")).not.toBeNull();
    expect(view.container.querySelector(".group-layer > .diff-modified")).not.toBeNull();
    expect(view.container.querySelector(".group-layer > .diff-heuristic")).not.toBeNull();
    expect(
      view.container.querySelector(".group-layer .source-cross-probed .transparent-group.selected"),
    ).not.toBeNull();
    expect(view.container.querySelector(".top-level-layer.diff-modified")).not.toBeNull();

    chooseComparisonView("Reference snapshot");
    expect(onSemanticSideChange).toHaveBeenLastCalledWith("reference");
    expect(visibleLabel(".top-level-title")).toBe("reference-top");
    expect(visibleLabel(".top-level-definition")).toBe("reference-top-definition");
    expect(visibleLabel(".group-title")).toBe("reference-group");
    expect(visibleLabel(".group-definition")).toBe("reference-group-definition");
    expect(node()?.querySelector(".module-title")?.lastChild?.textContent).toBe(
      "reference-instance",
    );
    expect(node()?.querySelector(".node-subtitle")?.lastChild?.textContent).toBe("reference-child");
    expect(view.container.querySelector(".operator-glyph")?.textContent).toBe("+");
    expect(view.container.querySelector(".boundary-label")?.textContent).toBe("reference-input");
    expect(view.container.querySelector(".bus-width")?.textContent).toBe("[7:0]");
    expect(portLabels()).toEqual(["reference-common", "reference-only"]);
    expect(edge()?.querySelector(".net-label text")?.textContent).toBe(
      "reference-edge · reference-type",
    );
    expect(edge()?.querySelector(".bus-width-annotation")?.getAttribute("aria-label")).toBe(
      "8 bits",
    );
    expect(edge()?.classList.contains("role-clock")).toBe(true);
    expect(node()?.classList).toContain("diff-unchanged");
    expect(node()?.classList).not.toContain("diff-modified");
    expect(edge()?.classList).toContain("diff-unchanged");
    expect(node()?.querySelector(".diff-modified-outline")).toBeNull();
    expect(node()?.querySelector(".diff-node-badge")).toBeNull();
    expect(geometry()).toEqual(unionGeometry);

    const renderedNode = node() as Element;
    fireEvent.mouseEnter(renderedNode);
    fireEvent.mouseMove(renderedNode, { clientX: 30, clientY: 30 });
    expect(screen.getByRole("tooltip").textContent).toContain("REF_NODE");
    expect(screen.getByRole("tooltip").textContent).toContain("reference-node-value");
    fireEvent.mouseLeave(renderedNode);

    const renderedGroup = view.container.querySelector('[href="#schematic-group"]') as Element;
    fireEvent.mouseEnter(renderedGroup);
    fireEvent.mouseMove(renderedGroup, { clientX: 30, clientY: 30 });
    expect(screen.getByRole("tooltip").textContent).toContain("REF_GROUP");
    expect(screen.getByRole("tooltip").textContent).toContain("reference-group-value");
    fireEvent.mouseLeave(renderedGroup);

    const top = view.container.querySelector(`[href="#schematic-${TOP_MODULE_ID}"]`) as Element;
    fireEvent.mouseEnter(top);
    fireEvent.mouseMove(top, { clientX: 30, clientY: 30 });
    expect(screen.getByRole("tooltip").textContent).toContain("REF_TOP");
    expect(screen.getByRole("tooltip").textContent).toContain("reference-top-value");
    expect(screen.getByRole("tooltip").textContent).toContain("REFERENCE_BUILD");
    expect(screen.getByRole("tooltip").textContent).not.toContain("CANDIDATE_BUILD");
    fireEvent.mouseLeave(top);

    chooseComparisonView("Candidate snapshot");
    expect(onSemanticSideChange).toHaveBeenLastCalledWith("candidate");
    expect(visibleLabel(".top-level-title")).toBe("candidate-top");
    expect(visibleLabel(".top-level-definition")).toBe("candidate-top-definition");
    expect(visibleLabel(".group-title")).toBe("candidate-group");
    expect(node()?.querySelector(".module-title")?.lastChild?.textContent).toBe(
      "candidate-instance",
    );
    expect(node()?.querySelector(".node-subtitle")?.lastChild?.textContent).toBe("candidate-child");
    expect(view.container.querySelector(".operator-glyph")?.textContent).toBe("−");
    expect(view.container.querySelector(".boundary-label")?.textContent).toBe("candidate-input");
    expect(view.container.querySelector(".bus-width")?.textContent).toBe("[15:0]");
    expect(portLabels()).toEqual(["candidate-common", "candidate-only"]);
    expect(edge()?.querySelector(".net-label text")?.textContent).toBe(
      "candidate-edge · candidate-type",
    );
    expect(edge()?.querySelector(".bus-width-annotation")?.getAttribute("aria-label")).toBe(
      "16 bits",
    );
    expect(edge()?.classList.contains("role-reset")).toBe(true);
    expect(node()?.classList).toContain("diff-unchanged");
    expect(edge()?.classList).toContain("diff-unchanged");
    expect(geometry()).toEqual(unionGeometry);
    fireEvent.mouseEnter(top);
    fireEvent.mouseMove(top, { clientX: 30, clientY: 30 });
    expect(screen.getByRole("tooltip").textContent).toContain("CAND_TOP");
    expect(screen.getByRole("tooltip").textContent).toContain("candidate-top-value");
    expect(screen.getByRole("tooltip").textContent).toContain("CANDIDATE_BUILD");
    expect(screen.getByRole("tooltip").textContent).not.toContain("REFERENCE_BUILD");
    fireEvent.mouseLeave(top);
    chooseComparisonView("Diff overlay");
    expect(onSemanticSideChange).toHaveBeenLastCalledWith(undefined);
    expect(node()?.classList).toContain("diff-modified");
    expect(edge()?.classList).toContain("diff-modified");
    expect(node()?.querySelector(".diff-modified-outline")).not.toBeNull();
    expect(geometry()).toEqual(unionGeometry);
    expect(layoutHarness.receivedSlices.every((received) => received === slice)).toBe(true);
  });

  it("excludes hidden control-signal changes from context and navigation", () => {
    const slice = {
      snapshotId: "hidden-control-comparison",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        { id: "clock-source", kind: "input", label: "clk", ports: [] },
        { id: "clock-target", kind: "register", label: "state", ports: [] },
      ],
      edges: [
        {
          id: "changed-clock",
          sourceNode: "clock-source",
          targetNode: "clock-target",
          label: "clk",
          role: "clock",
        },
      ],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 300,
      height: 160,
      groups: [],
      nodes: [
        { ...slice.nodes[0], x: 30, y: 55, width: 50, height: 50, ports: [] },
        { ...slice.nodes[1], x: 210, y: 55, width: 50, height: 50, ports: [] },
      ],
      edges: [
        {
          ...slice.edges[0],
          sections: [
            {
              startPoint: { x: 80, y: 80 },
              bendPoints: [],
              endPoint: { x: 210, y: 80 },
            },
          ],
        },
      ],
      elapsedMs: 1,
    };
    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={vi.fn()}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: false,
          instances: true,
          definitions: false,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "conservative",
          onPolicyChange: vi.fn(),
          entities: {
            "clock-source": { status: "unchanged" },
            "clock-target": { status: "unchanged" },
            "changed-clock": { status: "modified" },
          },
        }}
      />,
    );

    chooseComparisonView("Changes only");
    expect(view.container.querySelector('[href="#schematic-clock-source"]')?.classList).toContain(
      "diff-context",
    );
    fireEvent.click(screen.getByRole("button", { name: /Signals/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "clk" }));

    expect(view.container.querySelector('[href="#schematic-changed-clock"]')?.classList).toContain(
      "hidden-signal",
    );
    expect(view.container.querySelector('[href="#schematic-clock-source"]')?.classList).toContain(
      "diff-filtered",
    );
    expect(view.container.querySelector('[href="#schematic-clock-target"]')?.classList).toContain(
      "diff-filtered",
    );
    expect(
      (screen.getByRole("button", { name: "Next schematic change" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("counts and navigates a top-module-only semantic change", () => {
    const slice = {
      snapshotId: "top-only-comparison",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: { WIDTH: "9" },
      },
      nodes: [],
      edges: [],
    } satisfies GraphSlice;
    layoutHarness.layout = {
      width: 0,
      height: 0,
      groups: [],
      edges: [],
      nodes: [],
      elapsedMs: 1,
    };
    const onSelect = vi.fn();
    const view = render(
      <SchematicCanvas
        slice={slice}
        onSelect={onSelect}
        onOpenInstance={vi.fn()}
        canGoUp={false}
        onGoUp={vi.fn()}
        onGoTop={vi.fn()}
        labelSettings={{
          nets: true,
          signalTypes: false,
          bitWidths: true,
          instances: true,
          definitions: true,
        }}
        onToggleLabel={vi.fn()}
        flattenDepth={0}
        onFlattenDepthChange={vi.fn()}
        flattenRenderMode="grouped"
        onFlattenRenderModeChange={vi.fn()}
        layoutProfile="auto"
        onLayoutProfileChange={vi.fn()}
        constantRadix="binary"
        onConstantRadixChange={vi.fn()}
        onFlattenInstance={vi.fn()}
        onRestoreInstance={vi.fn()}
        individuallyFlattened={false}
        topLevelDefines={[]}
        inspectorOpen={false}
        onToggleInspector={vi.fn()}
        comparison={{
          referenceName: "reference.nettle",
          candidateName: "candidate.nettle",
          policy: "conservative",
          onPolicyChange: vi.fn(),
          entities: { [TOP_MODULE_ID]: { status: "modified" } },
        }}
      />,
    );

    expect(screen.getByText("1 visible")).toBeTruthy();
    expect(view.container.querySelector(".canvas-status")?.textContent).toContain("±1");
    expect(view.container.querySelector(".top-level-boundary")?.getAttribute("width")).toBe("0");
    expect(view.container.querySelector(".top-level-boundary")?.getAttribute("height")).toBe("0");
    expect(view.container.querySelector(".top-level-hit")?.getAttribute("width")).toBe("0");
    const canvas = view.container.querySelector(".canvas-wrap") as HTMLElement;
    const topInteraction = view.container.querySelector(
      `[href="#schematic-${TOP_MODULE_ID}"]`,
    ) as Element;
    const setPointerCapture = vi.fn();
    Object.defineProperty(canvas, "setPointerCapture", { value: setPointerCapture });
    fireEvent.pointerDown(topInteraction, { button: 0, pointerId: 1 });
    expect(setPointerCapture).not.toHaveBeenCalled();
    fireEvent.click(topInteraction);
    expect(onSelect).toHaveBeenCalledWith(TOP_MODULE_ID);
    onSelect.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next schematic change" }));
    expect(onSelect).toHaveBeenCalledWith(TOP_MODULE_ID);
  });
});
