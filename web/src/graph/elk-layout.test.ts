// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { demoSlice } from "../data/demo";
import type { GraphSlice } from "../model/graph";
import { makeLayeredBenchmarkSlice } from "./benchmark-fixture";
import { packDisconnectedComponents, runElkLayout, toElkGraph } from "./elk-layout";
import { effectiveLayoutProfile } from "./layout-profile";
import type { LayoutResult } from "./layout-types";

describe("ELK schematic layout", () => {
  it("rejects an obsolete layout request before starting work", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runElkLayout(demoSlice, "auto", "grouped", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("automatically chooses a fast overview for large flattened graphs", async () => {
    expect(effectiveLayoutProfile(demoSlice, "auto")).toBe("detailed");
    expect(effectiveLayoutProfile(makeLayeredBenchmarkSlice(2_000), "auto")).toBe("fast");
    expect(
      effectiveLayoutProfile(
        {
          ...demoSlice,
          edges: Array.from({ length: 1_000 }, (_, index) => ({
            ...demoSlice.edges[0],
            id: `dense-edge-${index}`,
          })),
        },
        "auto",
      ),
    ).toBe("fast");

    const layout = await runElkLayout(makeLayeredBenchmarkSlice(2_000), "auto");
    expect(layout.nodes).toHaveLength(2_000);
    expect(layout.nodes[0]).toMatchObject({ id: "n-0-0" });
  });

  it("offers detailed, balanced, and wide layered-flow profiles", () => {
    const detailed = toElkGraph(demoSlice, "detailed");
    const balanced = toElkGraph(demoSlice, "balanced");
    const wide = toElkGraph(demoSlice, "wide");
    expect(detailed.layoutOptions?.["elk.layered.wrapping.strategy"]).toBeUndefined();
    expect(detailed.layoutOptions?.["elk.layered.nodePlacement.strategy"]).toBeUndefined();
    expect(wide.layoutOptions).toMatchObject({
      "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
      "elk.layered.nodePlacement.strategy": "SIMPLE",
      "elk.layered.thoroughness": "1",
    });
    expect(balanced.layoutOptions).toMatchObject({
      "elk.aspectRatio": "1.8",
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
    });
    expect(wide.layoutOptions?.["elk.layered.wrapping.strategy"]).toBeUndefined();
  });

  it("renders a fast grouped overview with fixed top-level boundaries", async () => {
    const groupedSlice = {
      ...demoSlice,
      groups: [
        {
          id: "math",
          name: "u_math",
          definitionName: "math_unit",
          parameters: {},
          childNodeIds: ["add", "sub", "xor"],
        },
      ],
    };
    const layout = await runElkLayout(groupedSlice, "fast");
    expect(layout.nodes).toHaveLength(groupedSlice.nodes.length);
    expect(layout.edges).toHaveLength(groupedSlice.edges.length);
    expect(layout.edges.every((edge) => edge.sections.length > 0)).toBe(true);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]).toMatchObject({ id: "math", name: "u_math" });

    const inputs = layout.nodes.filter((node) => node.kind === "input");
    const outputs = layout.nodes.filter((node) => node.kind === "output");
    expect(inputs.every((node) => node.x === 8)).toBe(true);
    expect(outputs.every((node) => node.x + node.width === layout.width - 8)).toBe(true);
  });

  it("separates disconnected fast-overview nodes from routed geometry", async () => {
    const slice = {
      snapshotId: "fast-disconnected",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "source",
          kind: "operator",
          label: "source",
          glyph: "+",
          ports: [{ id: "out", name: "Y", direction: "output" }],
        },
        {
          id: "island",
          kind: "operator",
          label: "island",
          glyph: "+",
          ports: [],
        },
        {
          id: "target",
          kind: "operator",
          label: "target",
          glyph: "+",
          ports: [{ id: "in", name: "A", direction: "input" }],
        },
      ],
      edges: [
        {
          id: "routed",
          sourceNode: "source",
          sourcePort: "out",
          targetNode: "target",
          targetPort: "in",
        },
      ],
    } satisfies GraphSlice;

    const layout = await runElkLayout(slice, "fast", "grouped", undefined, true);
    const source = layout.nodes.find((node) => node.id === "source");
    const target = layout.nodes.find((node) => node.id === "target");
    const island = layout.nodes.find((node) => node.id === "island");
    expect(layout.disconnectedRegion?.componentCount).toBe(1);
    expect(layout.edges[0].sections).not.toHaveLength(0);
    expect(island?.y ?? 0).toBeGreaterThan(
      Math.max((source?.y ?? 0) + (source?.height ?? 0), (target?.y ?? 0) + (target?.height ?? 0)),
    );
  });

  it("places every semantic node and routes every net", async () => {
    const layout = await runElkLayout(demoSlice);
    expect(layout.nodes).toHaveLength(demoSlice.nodes.length);
    expect(layout.edges).toHaveLength(demoSlice.edges.length);
    expect(layout.width).toBeGreaterThan(500);
    expect(layout.height).toBeGreaterThan(200);
    expect(layout.edges.every((edge) => edge.sections.length > 0)).toBe(true);
  });

  it("keeps graph ports on node boundaries", async () => {
    const layout = await runElkLayout(demoSlice);
    for (const node of layout.nodes) {
      for (const port of node.ports) {
        const onVerticalBoundary =
          (port.x <= node.x && port.x + port.width >= node.x) ||
          (port.x <= node.x + node.width && port.x + port.width >= node.x + node.width);
        const onHorizontalBoundary =
          (port.y <= node.y && port.y + port.height >= node.y) ||
          (port.y <= node.y + node.height && port.y + port.height >= node.y + node.height);
        expect(onVerticalBoundary || onHorizontalBoundary).toBe(true);
      }
    }
  });

  it("constrains top inputs to the first layer and outputs to the last", () => {
    const graph = toElkGraph(demoSlice);
    const inputNodes = (graph.children ?? []).filter((node) =>
      demoSlice.nodes.some((source) => source.id === node.id && source.kind === "input"),
    );
    const outputNodes = (graph.children ?? []).filter((node) =>
      demoSlice.nodes.some((source) => source.id === node.id && source.kind === "output"),
    );
    expect(inputNodes).not.toHaveLength(0);
    expect(outputNodes).not.toHaveLength(0);
    expect(
      inputNodes.every(
        (node) => node.layoutOptions?.["elk.layered.layering.layerConstraint"] === "FIRST_SEPARATE",
      ),
    ).toBe(true);
    expect(
      outputNodes.every(
        (node) => node.layoutOptions?.["elk.layered.layering.layerConstraint"] === "LAST_SEPARATE",
      ),
    ).toBe(true);
  });

  it("can ask ELK to pack disconnected comparison components independently", () => {
    expect(toElkGraph(demoSlice).layoutOptions?.["elk.separateConnectedComponents"]).toBe("false");
    expect(
      toElkGraph(demoSlice, "auto", "grouped", true).layoutOptions?.[
        "elk.separateConnectedComponents"
      ],
    ).toBe("true");
  });

  it("packs disconnected islands without changing their internal routed geometry", () => {
    const slice = {
      snapshotId: "comparison-islands",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: ["main-a", "main-b", "island-a", "island-b", "island-c", "island-d", "island-e"].map(
        (id) => ({ id, kind: "operator" as const, label: id, glyph: "+", ports: [] }),
      ),
      edges: [{ id: "main-edge", sourceNode: "main-a", targetNode: "main-b" }],
    } satisfies GraphSlice;
    const layout = {
      width: 200,
      height: 900,
      elapsedMs: 1,
      groups: [],
      nodes: slice.nodes.map((node, index) => ({
        ...node,
        x: node.id === "main-a" ? 0 : node.id === "main-b" ? 100 : 100,
        y: node.id.startsWith("main") ? 100 : 250 + index * 100,
        width: 50,
        height: 50,
        ports: [],
      })),
      edges: [
        {
          ...slice.edges[0],
          sections: [
            {
              startPoint: { x: 50, y: 125 },
              bendPoints: [],
              endPoint: { x: 100, y: 125 },
            },
          ],
        },
      ],
    };

    const packed = packDisconnectedComponents(layout, slice);
    const islandXs = new Set(
      packed.nodes.filter((node) => node.id.startsWith("island")).map((node) => node.x),
    );
    expect(islandXs.size).toBeGreaterThan(1);
    expect(packed.height).toBeLessThan(layout.height);
    expect(packed.disconnectedRegion?.componentCount).toBe(5);
    expect(packed.disconnectedRegion?.componentEntityIds).toHaveLength(5);
    expect(packed.disconnectedRegion?.width).toBeGreaterThan(0);
    expect(packed.disconnectedRegion?.height).toBeGreaterThan(0);
    const source = packed.nodes.find((node) => node.id === "main-a");
    const target = packed.nodes.find((node) => node.id === "main-b");
    const section = packed.edges[0].sections[0];
    expect(section.startPoint.x - (source?.x ?? 0)).toBe(50);
    expect(section.endPoint.x - (target?.x ?? 0)).toBe(0);
    expect(section.startPoint.y - (source?.y ?? 0)).toBe(25);
    expect(section.endPoint.y - (target?.y ?? 0)).toBe(25);
  });

  it("keeps groups aligned with their routed component while packing", () => {
    const slice = {
      snapshotId: "comparison-group-island",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: ["main-a", "main-b", "island"].map((id) => ({
        id,
        kind: "operator" as const,
        label: id,
        glyph: "+",
        ports: [],
      })),
      edges: [{ id: "main-edge", sourceNode: "main-a", targetNode: "main-b" }],
      groups: [
        {
          id: "main-group",
          name: "u_main",
          definitionName: "main",
          parameters: {},
          childNodeIds: ["main-a", "main-b"],
        },
      ],
    } satisfies GraphSlice;
    const layout = {
      width: 500,
      height: 500,
      elapsedMs: 1,
      groups: [{ ...slice.groups[0], x: 20, y: 30, width: 220, height: 120 }],
      nodes: slice.nodes.map((node, index) => ({
        ...node,
        x: index === 0 ? 40 : index === 1 ? 160 : 420,
        y: index === 2 ? 400 : 60,
        width: 50,
        height: 50,
        ports: [],
      })),
      edges: [
        {
          ...slice.edges[0],
          sections: [
            {
              startPoint: { x: 90, y: 85 },
              bendPoints: [],
              endPoint: { x: 160, y: 85 },
            },
          ],
        },
      ],
    } satisfies LayoutResult;

    const packed = packDisconnectedComponents(layout, slice);
    const originalGroup = layout.groups[0];
    const originalNode = layout.nodes[0];
    const packedGroup = packed.groups[0];
    const packedNode = packed.nodes.find((node) => node.id === originalNode.id);
    expect(packedGroup.x - (packedNode?.x ?? 0)).toBe(originalGroup.x - originalNode.x);
    expect(packedGroup.y - (packedNode?.y ?? 0)).toBe(originalGroup.y - originalNode.y);
    expect(packed.disconnectedRegion?.componentCount).toBe(1);
  });

  it("labels a view made entirely of isolated components", () => {
    const slice = {
      snapshotId: "comparison-all-isolated",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: ["a", "b", "c"].map((id) => ({
        id,
        kind: "operator" as const,
        label: id,
        glyph: "+",
        ports: [],
      })),
      edges: [],
    } satisfies GraphSlice;
    const layout = {
      width: 100,
      height: 400,
      elapsedMs: 1,
      groups: [],
      nodes: slice.nodes.map((node, index) => ({
        ...node,
        x: 10,
        y: index * 120,
        width: 50,
        height: 50,
        ports: [],
      })),
      edges: [],
    } satisfies LayoutResult;

    const packed = packDisconnectedComponents(layout, slice);
    const region = packed.disconnectedRegion;
    expect(region?.componentCount).toBe(3);
    expect(
      Math.min(...packed.nodes.map((node) => node.y)) - (region?.y ?? 0),
    ).toBeGreaterThanOrEqual(56);
    expect(
      packed.nodes.every(
        (node) =>
          region &&
          node.x >= region.x &&
          node.y >= region.y &&
          node.x + node.width <= region.x + region.width &&
          node.y + node.height <= region.y + region.height,
      ),
    ).toBe(true);
  });

  it("packs a long reverse-directed chain without recursive union-find overflow", () => {
    const chainLength = 25_000;
    const nodes = Array.from({ length: chainLength + 1 }, (_, index) => ({
      id: index === chainLength ? "island" : `chain-${index}`,
      kind: "operator" as const,
      label: "+",
      glyph: "+",
      ports: [],
    }));
    const edges = Array.from({ length: chainLength - 1 }, (_, index) => ({
      id: `edge-${index}`,
      sourceNode: `chain-${index + 1}`,
      targetNode: `chain-${index}`,
    }));
    const slice = {
      snapshotId: "comparison-long-chain",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes,
      edges,
    } satisfies GraphSlice;
    const layout = {
      width: chainLength,
      height: 2,
      elapsedMs: 1,
      groups: [],
      nodes: nodes.map((node, index) => ({
        ...node,
        x: index,
        y: 0,
        width: 1,
        height: 1,
        ports: [],
      })),
      edges: edges.map((edge) => ({ ...edge, sections: [] })),
    } satisfies LayoutResult;

    const packed = packDisconnectedComponents(layout, slice);
    expect(packed.nodes).toHaveLength(chainLength + 1);
    expect(packed.disconnectedRegion?.componentCount).toBe(1);
  });

  it("places top-level input and output symbols flush with the module boundary", async () => {
    const layout = await runElkLayout(demoSlice);
    const inputs = layout.nodes.filter((node) => node.kind === "input");
    const outputs = layout.nodes.filter((node) => node.kind === "output");

    expect(inputs).not.toHaveLength(0);
    expect(outputs).not.toHaveLength(0);
    expect(inputs.every((node) => Math.abs(node.x - 8) < 0.01)).toBe(true);
    expect(outputs.every((node) => Math.abs(node.x + node.width - (layout.width - 8)) < 0.01)).toBe(
      true,
    );
  });

  it("places the mux select pin on the bottom edge", async () => {
    const layout = await runElkLayout(demoSlice);
    const mux = layout.nodes.find((node) => node.kind === "mux");
    expect(mux).toBeDefined();
    if (!mux) return;

    const select = mux.ports.find((port) => port.role === "select");
    const dataInputs = mux.ports.filter(
      (port) => port.direction === "input" && port.role !== "select",
    );
    expect(select).toBeDefined();
    if (!select) return;

    expect(select.y + select.height / 2).toBeGreaterThanOrEqual(mux.y + mux.height);
    expect(select.x + select.width / 2).toBeGreaterThan(mux.x);
    expect(select.x + select.width / 2).toBeLessThan(mux.x + mux.width);
    expect(dataInputs.every((port) => port.x + port.width / 2 <= mux.x)).toBe(true);
  });

  it("uses fixed semantic pin positions for standard boolean gates", () => {
    const slice = {
      snapshotId: "gate-layout",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "nand",
          kind: "operator",
          label: "Nand",
          glyph: "NAND",
          ports: [
            { id: "a", name: "A", direction: "input", role: "data" },
            { id: "b", name: "B", direction: "input", role: "data" },
            { id: "y", name: "Y", direction: "output", role: "data" },
          ],
        },
      ],
      edges: [],
    } satisfies GraphSlice;

    const gate = toElkGraph(slice, "detailed").children?.[0];
    expect(gate).toBeDefined();
    if (!gate) return;
    expect(gate.width).toBe(68);
    expect(gate.height).toBe(58);
    expect(gate.layoutOptions?.["elk.portConstraints"]).toBe("FIXED_POS");
    const ports = gate.ports ?? [];
    expect(ports).toHaveLength(3);
    expect(ports[0].y ?? 0).toBeLessThan(ports[1].y ?? 0);
    expect(ports[2].x ?? 0).toBeGreaterThan(ports[0].x ?? 0);
  });

  it("grows a multi-way mux and assigns every choice a distinct ordered pin", async () => {
    const choicePorts = Array.from({ length: 7 }, (_, index) => ({
      id: `choice-${index}`,
      name: index === 0 ? "A" : `B${index - 1}`,
      direction: "input" as const,
      role: "data" as const,
      index,
      width: 32,
    }));
    const slice = {
      snapshotId: "multi-way-mux",
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
            ...choicePorts,
            { id: "select", name: "S", direction: "input", role: "select", width: 6 },
            { id: "output", name: "Y", direction: "output", role: "data", width: 32 },
          ],
        },
      ],
      edges: [],
    } satisfies GraphSlice;

    const layout = await runElkLayout(slice, "detailed");
    const mux = layout.nodes[0];
    const choices = mux.ports.filter((port) => port.role === "data" && port.direction === "input");
    const choiceCenters = choices.map((port) => port.y + port.height / 2);
    const select = mux.ports.find((port) => port.role === "select");

    expect(mux.height).toBe(202);
    expect(choices.map((port) => port.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(choiceCenters).size).toBe(7);
    expect(choiceCenters).toEqual([...choiceCenters].sort((left, right) => left - right));
    expect(select).toBeDefined();
    if (!select) return;
    expect(select.y + select.height / 2).toBeGreaterThanOrEqual(mux.y + mux.height);
    expect(select.y + select.height / 2).toBeLessThanOrEqual(mux.y + mux.height + select.height);
  });

  it("sizes major module instances for dense, readable port labels", async () => {
    const inputs = Array.from({ length: 64 }, (_, index) => ({
      id: `input-${index}`,
      name: `representative_input_signal_${index}`,
      direction: "input" as const,
    }));
    const outputs = Array.from({ length: 48 }, (_, index) => ({
      id: `output-${index}`,
      name: `representative_output_signal_${index}`,
      direction: "output" as const,
    }));
    const controls = [
      { id: "clk", name: "clk_i", direction: "input" as const, role: "clock" },
      { id: "rst", name: "rst_ni", direction: "input" as const, role: "reset" },
      { id: "enable", name: "fetch_enable_i", direction: "input" as const, role: "enable" },
    ];
    const slice = {
      snapshotId: "dense-module",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "major-subsystem",
          kind: "module",
          label: "u_major_subsystem",
          definitionName: "major_subsystem",
          ports: [...inputs, ...outputs, ...controls],
        },
      ],
      edges: [],
    } satisfies GraphSlice;

    const layout = await runElkLayout(slice);
    const module = layout.nodes[0];
    expect(module.height).toBeGreaterThan(1_200);
    expect(module.width).toBeGreaterThan(300);

    const verticalPorts = module.ports.filter(
      (port) => port.role !== "clock" && port.role !== "reset" && port.role !== "enable",
    );
    const positionsBySide = ["input", "output"].map((direction) =>
      verticalPorts
        .filter((port) => port.direction === direction)
        .map((port) => port.y)
        .sort((left, right) => left - right),
    );
    for (const positions of positionsBySide) {
      expect(positions[0]).toBeGreaterThanOrEqual(module.y + 38);
      for (let index = 1; index < positions.length; index += 1) {
        expect(positions[index] - positions[index - 1]).toBeGreaterThanOrEqual(17);
      }
    }
    const south = module.ports.filter((port) => controls.some((control) => control.id === port.id));
    expect(south.every((port) => port.y + port.height / 2 >= module.y + module.height)).toBe(true);
    expect(new Set(south.map((port) => port.x)).size).toBe(south.length);
  });

  it("sizes memory cells for named ports and gives every side port a distinct position", () => {
    const memoryInputs = Array.from({ length: 10 }, (_, index) => ({
      id: `input-${index}`,
      name: index === 0 ? "RD_ARST_VALUE" : `CONTROL_${index}`,
      direction: "input" as const,
    }));
    const slice = {
      snapshotId: "memory-ports",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "memory",
          kind: "memory",
          label: "MEM",
          ports: [
            ...memoryInputs,
            { id: "output", name: "RD_DATA", direction: "output" as const, width: 32 },
          ],
        },
      ],
      edges: [],
    } satisfies GraphSlice;

    const memory = toElkGraph(slice, "detailed").children?.[0];
    expect(memory).toBeDefined();
    if (!memory) return;
    expect(memory.width).toBeGreaterThan(142);
    expect(memory.height).toBeGreaterThan(220);
    expect(memory.layoutOptions?.["elk.portConstraints"]).toBe("FIXED_POS");
    const westPorts = memory.ports?.filter(
      (port) => port.layoutOptions?.["elk.port.side"] === "WEST",
    );
    expect(new Set(westPorts?.map((port) => port.y)).size).toBe(westPorts?.length);
  });

  it("produces deterministic seeded geometry", async () => {
    const first = await runElkLayout(demoSlice);
    const second = await runElkLayout(demoSlice);
    const geometry = ({ elapsedMs: _elapsedMs, ...layout }: typeof first) => layout;
    expect(geometry(second)).toEqual(geometry(first));
  });

  it("wraps projected children in a padded transparent group", async () => {
    const groupedSlice = {
      ...demoSlice,
      groups: [
        {
          id: "math",
          name: "u_math",
          definitionName: "math_unit",
          parameters: { WIDTH: 32 },
          childNodeIds: ["add", "sub", "xor"],
        },
      ],
    };
    const layout = await runElkLayout(groupedSlice);
    const group = layout.groups[0];
    const children = layout.nodes.filter((node) =>
      groupedSlice.groups[0].childNodeIds.includes(node.id),
    );

    expect(group).toMatchObject({
      id: "math",
      name: "u_math",
      definitionName: "math_unit",
    });
    expect(group.x).toBeGreaterThanOrEqual(8);
    expect(group.x + group.width).toBeLessThanOrEqual(layout.width - 8);
    for (const child of children) {
      expect(child.x).toBeGreaterThan(group.x);
      expect(child.y).toBeGreaterThan(group.y);
      expect(child.x + child.width).toBeLessThan(group.x + group.width);
      expect(child.y + child.height).toBeLessThan(group.y + group.height);
    }
  });

  it("lays out sibling transparent groups as non-overlapping compound nodes", async () => {
    const groupedSlice = {
      ...demoSlice,
      groups: [
        {
          id: "arithmetic",
          name: "u_arithmetic",
          definitionName: "arithmetic_unit",
          parameters: {},
          childNodeIds: ["add", "sub", "xor"],
        },
        {
          id: "compare-shift",
          name: "u_compare_shift",
          definitionName: "compare_shift_unit",
          parameters: {},
          childNodeIds: ["shl", "lt"],
        },
      ],
    } satisfies GraphSlice;

    const graph = toElkGraph(groupedSlice, "detailed");
    const topLevelIds = graph.children?.map((child) => child.id) ?? [];
    expect(topLevelIds).toContain("arithmetic");
    expect(topLevelIds).toContain("compare-shift");
    expect(topLevelIds).not.toContain("add");
    expect(graph.children?.find((child) => child.id === "arithmetic")?.children).toHaveLength(3);

    const layout = await runElkLayout(groupedSlice, "detailed");
    const arithmetic = layout.groups.find((group) => group.id === "arithmetic");
    const state = layout.groups.find((group) => group.id === "compare-shift");
    expect(arithmetic).toBeDefined();
    expect(state).toBeDefined();
    if (!arithmetic || !state) return;

    const overlaps =
      arithmetic.x < state.x + state.width &&
      arithmetic.x + arithmetic.width > state.x &&
      arithmetic.y < state.y + state.height &&
      arithmetic.y + arithmetic.height > state.y;
    expect(overlaps).toBe(false);

    const balancedLayout = await runElkLayout(groupedSlice, "balanced");
    expect(balancedLayout.groups).toHaveLength(2);
    expect(balancedLayout.nodes).toHaveLength(groupedSlice.nodes.length);
    const wideLayout = await runElkLayout(groupedSlice, "wide");
    expect(wideLayout.groups).toHaveLength(2);
    expect(wideLayout.nodes).toHaveLength(groupedSlice.nodes.length);

    const flatGraph = toElkGraph(groupedSlice, "detailed", "flat");
    const flatTopLevelIds = flatGraph.children?.map((child) => child.id) ?? [];
    expect(flatTopLevelIds).toContain("add");
    expect(flatTopLevelIds).not.toContain("arithmetic");
    const flatLayout = await runElkLayout(groupedSlice, "detailed", "flat");
    expect(flatLayout.groups).toHaveLength(0);
    expect(flatLayout.nodes).toHaveLength(groupedSlice.nodes.length);
  });

  it("preserves nested transparent groups as nested compound nodes", async () => {
    const nestedSlice = {
      ...demoSlice,
      groups: [
        {
          id: "outer",
          name: "u_outer",
          definitionName: "outer_unit",
          parameters: {},
          childNodeIds: ["add", "sub", "xor"],
        },
        {
          id: "outer/inner",
          name: "u_inner",
          definitionName: "inner_unit",
          parameters: {},
          childNodeIds: ["add", "sub"],
        },
      ],
    } satisfies GraphSlice;

    const graph = toElkGraph(nestedSlice, "detailed");
    const outer = graph.children?.find((child) => child.id === "outer");
    expect(outer?.children?.map((child) => child.id)).toEqual(["outer/inner", "xor"]);
    expect(outer?.children?.[0].children?.map((child) => child.id)).toEqual(["add", "sub"]);

    const layout = await runElkLayout(nestedSlice, "detailed");
    const outerGroup = layout.groups.find((group) => group.id === "outer");
    const innerGroup = layout.groups.find((group) => group.id === "outer/inner");
    const add = layout.nodes.find((node) => node.id === "add");
    expect(outerGroup).toBeDefined();
    expect(innerGroup).toBeDefined();
    expect(add).toBeDefined();
    if (!outerGroup || !innerGroup || !add) return;
    expect(innerGroup.x).toBeGreaterThan(outerGroup.x);
    expect(innerGroup.y).toBeGreaterThan(outerGroup.y);
    expect(innerGroup.x + innerGroup.width).toBeLessThan(outerGroup.x + outerGroup.width);
    expect(innerGroup.y + innerGroup.height).toBeLessThan(outerGroup.y + outerGroup.height);
    expect(add.x).toBeGreaterThan(innerGroup.x);
    expect(add.y).toBeGreaterThan(innerGroup.y);
  });

  it("places grouped boundary pins on the box and contracts them in flat mode", async () => {
    const boundarySlice = {
      snapshotId: "boundary-groups",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "top-in",
          kind: "input",
          label: "data_i",
          ports: [{ id: "p", name: "data_i", direction: "output" }],
        },
        {
          id: "child/in",
          kind: "input",
          label: "data_i",
          ports: [{ id: "p", name: "data_i", direction: "output" }],
        },
        {
          id: "child/logic",
          kind: "primitive",
          label: "logic",
          ports: [
            { id: "i", name: "i", direction: "input" },
            { id: "o", name: "o", direction: "output" },
          ],
        },
        {
          id: "child/out",
          kind: "output",
          label: "data_o",
          ports: [{ id: "p", name: "data_o", direction: "input" }],
        },
        {
          id: "top-out",
          kind: "output",
          label: "data_o",
          ports: [{ id: "p", name: "data_o", direction: "input" }],
        },
      ],
      edges: [
        {
          id: "parent-in",
          sourceNode: "top-in",
          sourcePort: "p",
          targetNode: "child/in",
          targetPort: "p",
        },
        {
          id: "child-in",
          sourceNode: "child/in",
          sourcePort: "p",
          targetNode: "child/logic",
          targetPort: "i",
        },
        {
          id: "child-out",
          sourceNode: "child/logic",
          sourcePort: "o",
          targetNode: "child/out",
          targetPort: "p",
        },
        {
          id: "parent-out",
          sourceNode: "child/out",
          sourcePort: "p",
          targetNode: "top-out",
          targetPort: "p",
        },
      ],
      groups: [
        {
          id: "child",
          name: "u_child",
          definitionName: "child",
          parameters: {},
          childNodeIds: ["child/in", "child/logic", "child/out"],
        },
      ],
    } satisfies GraphSlice;

    const groupedGraph = toElkGraph(boundarySlice, "detailed", "grouped");
    const groupedInput = groupedGraph.children?.[1]?.children?.find(
      (node) => node.id === "child/in",
    );
    expect(groupedInput?.ports?.map((port) => port.layoutOptions?.["elk.port.side"])).toEqual([
      "EAST",
      "WEST",
    ]);
    expect(groupedGraph.edges?.find((edge) => edge.id === "parent-in")).toMatchObject({
      targets: ["child/in:p:external"],
    });
    expect(groupedGraph.edges?.find((edge) => edge.id === "child-in")).toMatchObject({
      sources: ["child/in:p"],
    });

    const groupedLayout = await runElkLayout(boundarySlice, "detailed", "grouped");
    const group = groupedLayout.groups[0];
    const childInput = groupedLayout.nodes.find((node) => node.id === "child/in");
    const childOutput = groupedLayout.nodes.find((node) => node.id === "child/out");
    expect(childInput?.x).toBeCloseTo(group.x);
    expect((childOutput?.x ?? 0) + (childOutput?.width ?? 0)).toBeCloseTo(group.x + group.width);

    const flatGraph = toElkGraph(boundarySlice, "detailed", "flat");
    expect(flatGraph.children?.map((node) => node.id)).toEqual([
      "top-in",
      "child/logic",
      "top-out",
    ]);
    expect(flatGraph.edges).toHaveLength(2);
    expect(flatGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sources: ["top-in:p"], targets: ["child/logic:i"] }),
        expect.objectContaining({ sources: ["child/logic:o"], targets: ["top-out:p"] }),
      ]),
    );
    const flatLayout = await runElkLayout(boundarySlice, "detailed", "flat");
    expect(flatLayout.groups).toHaveLength(0);
    expect(flatLayout.nodes.map((node) => node.id)).toEqual(["top-in", "child/logic", "top-out"]);

    const fastLayout = await runElkLayout(boundarySlice, "fast", "grouped");
    const fastGroup = fastLayout.groups[0];
    const fastInput = fastLayout.nodes.find((node) => node.id === "child/in");
    const fastOutput = fastLayout.nodes.find((node) => node.id === "child/out");
    const fastParentIn = fastLayout.edges.find((edge) => edge.id === "parent-in");
    const fastParentOut = fastLayout.edges.find((edge) => edge.id === "parent-out");
    expect(fastInput?.x).toBe(fastGroup.x);
    expect((fastOutput?.x ?? 0) + (fastOutput?.width ?? 0)).toBe(fastGroup.x + fastGroup.width);
    expect(fastParentIn?.sections[0].endPoint.x).toBe(fastGroup.x);
    expect(fastParentOut?.sections[0].startPoint.x).toBe(fastGroup.x + fastGroup.width);
  });

  it("fixes register ports to their conventional symbols independent of input order", async () => {
    const slice = {
      snapshotId: "register-ports",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        {
          id: "data",
          kind: "input",
          label: "data",
          ports: [{ id: "data-y", name: "data", direction: "output", width: 8 }],
        },
        {
          id: "clk",
          kind: "input",
          label: "clk",
          ports: [{ id: "clk-y", name: "clk", direction: "output" }],
        },
        {
          id: "rst",
          kind: "input",
          label: "rst_n",
          ports: [{ id: "rst-y", name: "rst_n", direction: "output" }],
        },
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
          parameters: { ALOAD_POLARITY: "0" },
          ports: [
            { id: "state-rst", name: "ALOAD", direction: "input", role: "reset" },
            { id: "state-q", name: "Q", direction: "output", role: "data", width: 8 },
            { id: "state-ad", name: "AD", direction: "input", role: "data", width: 8 },
            { id: "state-clk", name: "CLK", direction: "input", role: "clock" },
            { id: "state-d", name: "D", direction: "input", role: "data", width: 8 },
          ],
        },
        {
          id: "q",
          kind: "output",
          label: "q",
          ports: [{ id: "q-a", name: "q", direction: "input", width: 8 }],
        },
      ],
      edges: [
        {
          id: "data-d",
          sourceNode: "data",
          sourcePort: "data-y",
          targetNode: "state",
          targetPort: "state-d",
          width: 8,
        },
        {
          id: "zero-ad",
          sourceNode: "zero",
          sourcePort: "zero-y",
          targetNode: "state",
          targetPort: "state-ad",
          width: 8,
        },
        {
          id: "clk-state",
          sourceNode: "clk",
          sourcePort: "clk-y",
          targetNode: "state",
          targetPort: "state-clk",
          role: "clock",
        },
        {
          id: "rst-state",
          sourceNode: "rst",
          sourcePort: "rst-y",
          targetNode: "state",
          targetPort: "state-rst",
          role: "reset",
        },
        {
          id: "state-q",
          sourceNode: "state",
          sourcePort: "state-q",
          targetNode: "q",
          targetPort: "q-a",
          width: 8,
        },
      ],
    } satisfies GraphSlice;

    const layout = await runElkLayout(slice);
    const register = layout.nodes.find((node) => node.id === "state");
    const constant = layout.nodes.find((node) => node.id === "zero");
    expect(register).toBeDefined();
    expect(constant).toBeDefined();
    if (!register || !constant) return;
    const center = (id: string) => {
      const port = register.ports.find((candidate) => candidate.id === id);
      expect(port).toBeDefined();
      if (!port) return { x: Number.NaN, y: Number.NaN };
      return { x: port.x + port.width / 2, y: port.y + port.height / 2 };
    };
    expect(center("state-d")).toEqual({
      x: register.x - 3.5,
      y: register.y + register.height / 2,
    });
    expect(center("state-q")).toEqual({
      x: register.x + register.width + 3.5,
      y: register.y + register.height / 2,
    });
    expect(center("state-clk")).toEqual({
      x: register.x - 3.5,
      y: register.y + register.height - 22,
    });
    expect(center("state-rst").y).toBe(register.y + register.height + 3.5);
    expect(center("state-ad")).toEqual({
      x: register.x - 3.5,
      y: register.y + register.height * 0.27,
    });
    expect(constant.height).toBe(24);
    expect(constant.ports[0].x + constant.ports[0].width / 2).toBe(
      constant.x + constant.width + 3.5,
    );
  });
});
