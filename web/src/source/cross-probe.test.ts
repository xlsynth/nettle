// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { GraphSlice } from "../model/graph";
import { entityForSourceSelection } from "./cross-probe";

const source = `module top (
  input logic [7:0] a,
  input logic [7:0] b,
  output logic [7:0] y
);
  assign y = a + b;
endmodule
`;

const slice: GraphSlice = {
  snapshotId: "snapshot",
  module: { id: "top", name: "top", instancePath: "top", definitionName: "top", parameters: {} },
  nodes: [
    {
      id: "a-node",
      kind: "input",
      label: "a",
      ports: [{ id: "a", name: "a", direction: "output" }],
      origins: [{ file: "rtl/top.sv", startLine: 2, startColumn: 21, endLine: 2, endColumn: 22 }],
    },
    {
      id: "b-node",
      kind: "input",
      label: "b",
      ports: [{ id: "b", name: "b", direction: "output" }],
      origins: [{ file: "rtl/top.sv", startLine: 3, startColumn: 21, endLine: 3, endColumn: 22 }],
    },
    {
      id: "add-node",
      kind: "operator",
      label: "Add",
      glyph: "+",
      ports: [],
      origins: [{ file: "rtl/top.sv", startLine: 6, startColumn: 16, endLine: 6, endColumn: 21 }],
    },
  ],
  edges: [
    {
      id: "y-edge",
      sourceNode: "add-node",
      targetNode: "y-node",
      label: "y",
      origins: [{ file: "rtl/top.sv", startLine: 6, startColumn: 10, endLine: 6, endColumn: 11 }],
    },
  ],
};

describe("source cross-probing", () => {
  it("uses the identifier under the cursor to distinguish input declarations", () => {
    expect(
      entityForSourceSelection(slice, "/project/rtl/top.sv", source, {
        startLine: 2,
        startColumn: 21,
        endLine: 2,
        endColumn: 22,
      }),
    ).toBe("a-node");
    expect(
      entityForSourceSelection(slice, "rtl/top.sv", source, {
        startLine: 3,
        startColumn: 21,
        endLine: 3,
        endColumn: 22,
      }),
    ).toBe("b-node");
  });

  it("prefers an operator token over another origin on the same line", () => {
    expect(
      entityForSourceSelection(slice, "rtl/top.sv", source, {
        startLine: 6,
        startColumn: 18,
        endLine: 6,
        endColumn: 19,
      }),
    ).toBe("add-node");
  });

  it("uses line overlap when a plain cursor click lands near assign", () => {
    expect(
      entityForSourceSelection(slice, "rtl/top.sv", source, {
        startLine: 6,
        startColumn: 3,
        endLine: 6,
        endColumn: 4,
      }),
    ).toBe("add-node");
  });

  it("falls back to the most specific origin when a click is outside its columns", () => {
    expect(
      entityForSourceSelection(slice, "rtl/top.sv", source, {
        startLine: 2,
        startColumn: 3,
        endLine: 2,
        endColumn: 4,
      }),
    ).toBe("a-node");
  });
});
