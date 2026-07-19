// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ApiGraphSlice } from "../api/contracts";
import { flattenSelected, flattenSlice } from "./projection";

const boundary = (id: string, kind: "input" | "output", direction: "input" | "output") => ({
  id,
  kind,
  label: id,
  ports: [{ id: `${id}-port`, name: id, direction }],
});

const child: ApiGraphSlice = {
  snapshotId: "snapshot",
  module: { id: "child-module", name: "child", instancePath: "child", definitionName: "child" },
  nodes: [boundary("a", "input", "output"), boundary("y", "output", "input")],
  edges: [
    {
      id: "child-edge",
      sourceNode: "a",
      sourcePort: "a-port",
      targetNode: "y",
      targetPort: "y-port",
    },
  ],
};

const top: ApiGraphSlice = {
  snapshotId: "snapshot",
  module: { id: "top-module", name: "top", instancePath: "top", definitionName: "top" },
  nodes: [
    boundary("a", "input", "output"),
    {
      id: "u-child",
      kind: "moduleInstance",
      label: "u_child",
      definitionName: "child",
      ports: [
        { id: "u-a", name: "a", direction: "input" },
        { id: "u-y", name: "y", direction: "output" },
      ],
    },
    boundary("y", "output", "input"),
  ],
  edges: [
    {
      id: "top-in",
      sourceNode: "a",
      sourcePort: "a-port",
      targetNode: "u-child",
      targetPort: "u-a",
    },
    {
      id: "top-out",
      sourceNode: "u-child",
      sourcePort: "u-y",
      targetNode: "y",
      targetPort: "y-port",
    },
  ],
};

describe("browser-local hierarchy projection", () => {
  const load = async (name: string) => (name === "child" ? child : undefined);

  it("rewires a selected instance and retains its boundary", async () => {
    const flattened = await flattenSelected(top, ["u-child"], load);
    expect(flattened.nodes.map((node) => node.id)).toEqual(["a", "u-child/a", "u-child/y", "y"]);
    expect(flattened.edges.find((edge) => edge.id === "top-in")?.targetNode).toBe("u-child/a");
    expect(flattened.edges.find((edge) => edge.id === "top-out")?.sourceNode).toBe("u-child/y");
    expect(flattened.groups).toEqual([
      expect.objectContaining({ id: "u-child", childNodeIds: ["u-child/a", "u-child/y"] }),
    ]);
    expect(flattened.elaborationRanges).toBeUndefined();
  });

  it("applies equal-depth flattening and preserves depth zero", async () => {
    expect(await flattenSlice(top, 0, load)).toEqual(top);
    const flattened = await flattenSlice(top, 1, load);
    expect(flattened.nodes.some((node) => node.kind === "moduleInstance")).toBe(false);
    expect(flattened.groups).toHaveLength(1);
  });

  it("rejects an expansion before it exceeds the projection budget", async () => {
    await expect(flattenSelected(top, ["u-child"], load, 5)).rejects.toThrow(
      "Projected graph would have 8 objects, exceeding budget 5",
    );
  });

  it("folds slice-scoped elaboration ranges while flattening", async () => {
    const parent = structuredClone(top);
    const nested = structuredClone(child);
    parent.elaborationRanges = [
      {
        file: "rtl/shared.sv",
        startLine: 2,
        startColumn: 1,
        endLine: 4,
        endColumn: 2,
        active: false,
      },
    ];
    nested.elaborationRanges = [
      { ...parent.elaborationRanges[0], active: true },
      {
        file: "rtl/shared.sv",
        startLine: 5,
        startColumn: 1,
        endLine: 7,
        endColumn: 2,
        active: false,
      },
    ];
    const loadNested = async (name: string) => (name === "child" ? nested : undefined);

    const flattened = await flattenSelected(parent, ["u-child"], loadNested);
    expect(flattened.elaborationRanges).toEqual([
      { ...parent.elaborationRanges[0], active: true },
      nested.elaborationRanges[1],
    ]);
    await expect(flattenSelected(parent, ["u-child"], loadNested, 100, 1)).rejects.toThrow(
      "2 elaboration ranges, exceeding budget 1",
    );
  });

  it("shares one projection budget between origins and elaboration ranges", async () => {
    const parent = structuredClone(top);
    const nested = structuredClone(child);
    nested.nodes[0].origins = [{ file: "rtl/shared.sv", startLine: 1, startColumn: 1, endLine: 1 }];
    nested.elaborationRanges = [
      {
        file: "rtl/shared.sv",
        startLine: 2,
        startColumn: 1,
        endLine: 4,
        endColumn: 2,
        active: true,
      },
    ];
    const loadNested = async (name: string) => (name === "child" ? nested : undefined);

    await expect(flattenSelected(parent, ["u-child"], loadNested, 100, 1)).rejects.toThrow(
      "2 origins and elaboration ranges, exceeding budget 1",
    );
    await expect(flattenSelected(parent, ["u-child"], loadNested, 100, 2)).resolves.toBeDefined();
  });
});
