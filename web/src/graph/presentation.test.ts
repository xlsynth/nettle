// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { demoSlice } from "../data/demo";
import type { GraphSlice } from "../model/graph";
import { controlSignalKey, detectedControlSignals, shortModuleName } from "./presentation";

describe("schematic presentation", () => {
  it("uses the final hierarchy component and bounds unusually long names", () => {
    expect(shortModuleName("core_top.execute.u_alu")).toBe("u_alu");
    expect(shortModuleName("work::library/decoder")).toBe("decoder");
    expect(shortModuleName("an_unusually_long_flat_instance_name", 12)).toBe("an_unusuall…");
  });

  it("detects each clock and reset without changing the graph", () => {
    const signals = detectedControlSignals(demoSlice);
    expect(signals.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: "clk", role: "clock" },
      { name: "rst_n", role: "reset" },
    ]);

    const clock = signals.find((signal) => signal.role === "clock");
    expect(clock).toBeDefined();
    const clockEdge = demoSlice.edges.find((edge) => edge.role === "clock");
    expect(clockEdge && controlSignalKey(demoSlice, clockEdge)).toBe(clock?.key);
    expect(demoSlice.nodes.some((node) => node.id === "clk")).toBe(true);
    expect(demoSlice.edges.some((edge) => edge.role === "clock")).toBe(true);
  });

  it("infers reset and clock filters from common signal-name substrings", () => {
    const resetNames = ["arst_n", "rst_n", "rstn", "rst", "reset", "reset_n"];
    const clockNames = ["clk", "clk_i", "clock", "core_clock_n"];
    const names = [...resetNames, ...clockNames, "enable"];
    const slice = {
      snapshotId: "named-controls",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [
        ...names.map((name) => ({
          id: name,
          kind: "input" as const,
          label: name,
          ports: [{ id: `${name}-out`, name, direction: "output" as const }],
        })),
        {
          id: "sink",
          kind: "unknown" as const,
          label: "sink",
          ports: names.map((name) => ({
            id: `${name}-in`,
            name: "input",
            direction: "input" as const,
          })),
        },
      ],
      edges: names.map((name) => ({
        id: `${name}-edge`,
        sourceNode: name,
        sourcePort: `${name}-out`,
        targetNode: "sink",
        targetPort: `${name}-in`,
      })),
    } satisfies GraphSlice;

    const detected = detectedControlSignals(slice);
    const roles = new Map(detected.map((signal) => [signal.name, signal.role]));
    for (const name of resetNames) expect(roles.get(name)).toBe("reset");
    for (const name of clockNames) expect(roles.get(name)).toBe("clock");
    expect(roles.has("enable")).toBe(false);
  });
});
