// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphSlice } from "../model/graph";
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
          label: "y",
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
