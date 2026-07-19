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

const oneLineGenerateSource = "module one; if (ENABLE) begin assign y = a; end endmodule\n";

const oneLineNode = (
  id: string,
  startColumn: number,
  endColumn: number,
): GraphSlice["nodes"][number] => ({
  id,
  kind: "primitive",
  label: id,
  ports: [],
  origins: [{ file: "rtl/one.sv", startLine: 1, startColumn, endLine: 1, endColumn }],
});

const oneLineGenerateSlice: GraphSlice = {
  ...slice,
  nodes: [
    oneLineNode("before-node", 8, 13),
    oneLineNode("inside-node", 42, 43),
    oneLineNode("after-node", 48, 58),
  ],
  edges: [],
};

const oneLineGenerateRange = [
  {
    file: "rtl/one.sv",
    startLine: 1,
    startColumn: 13,
    endLine: 1,
    endColumn: 48,
    active: true,
  },
];

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

  it("links an active generate header to an elaborated entity in that construct", () => {
    const generateSource = `module generated;
  generate
    if (USE_XOR) begin : use_xor
      assign y = a ^ b;
    end else begin : use_or
      assign y = a | b;
    end
  endgenerate
endmodule
`;
    const generateSlice: GraphSlice = {
      ...slice,
      nodes: [
        {
          id: "xor-node",
          kind: "operator",
          label: "Xor",
          glyph: "^",
          ports: [],
          origins: [
            { file: "rtl/generated.sv", startLine: 4, startColumn: 18, endLine: 4, endColumn: 23 },
          ],
        },
      ],
      edges: [],
    };
    const elaborationRanges = [
      {
        file: "rtl/generated.sv",
        startLine: 2,
        startColumn: 3,
        endLine: 8,
        endColumn: 14,
        active: true,
      },
      {
        file: "rtl/generated.sv",
        startLine: 5,
        startColumn: 9,
        endLine: 7,
        endColumn: 8,
        active: false,
      },
    ];

    expect(
      entityForSourceSelection(
        generateSlice,
        "rtl/generated.sv",
        generateSource,
        { startLine: 3, startColumn: 5, endLine: 3, endColumn: 6 },
        elaborationRanges,
      ),
    ).toBe("xor-node");
  });

  it("ignores same-line origins immediately before and after a one-line generate construct", () => {
    expect(
      entityForSourceSelection(
        oneLineGenerateSlice,
        "rtl/one.sv",
        oneLineGenerateSource,
        { startLine: 1, startColumn: 13, endLine: 1, endColumn: 15 },
        oneLineGenerateRange,
      ),
    ).toBe("inside-node");
  });

  it("does not link a one-line generate header when all same-line origins are outside it", () => {
    expect(
      entityForSourceSelection(
        {
          ...oneLineGenerateSlice,
          nodes: oneLineGenerateSlice.nodes.filter((node) => node.id !== "inside-node"),
        },
        "rtl/one.sv",
        oneLineGenerateSource,
        { startLine: 1, startColumn: 13, endLine: 1, endColumn: 15 },
        oneLineGenerateRange,
      ),
    ).toBeUndefined();
  });

  it("does not cross-probe source inside an inactive generate branch", () => {
    const generateSource = `module generated;
  generate
    if (USE_XOR) begin : use_xor
      assign y = a ^ b;
    end else begin : use_or
      assign y = a | b;
    end
  endgenerate
endmodule
`;

    expect(
      entityForSourceSelection(
        slice,
        "rtl/generated.sv",
        generateSource,
        { startLine: 6, startColumn: 7, endLine: 6, endColumn: 8 },
        [
          {
            file: "rtl/generated.sv",
            startLine: 2,
            startColumn: 3,
            endLine: 8,
            endColumn: 14,
            active: true,
          },
          {
            file: "rtl/generated.sv",
            startLine: 5,
            startColumn: 9,
            endLine: 7,
            endColumn: 8,
            active: false,
          },
        ],
      ),
    ).toBeUndefined();
  });

  it("gives an inactive same-line branch precedence over line-level origin fallback", () => {
    expect(
      entityForSourceSelection(
        slice,
        "rtl/top.sv",
        source,
        { startLine: 6, startColumn: 3, endLine: 6, endColumn: 4 },
        [
          {
            file: "rtl/top.sv",
            startLine: 6,
            startColumn: 1,
            endLine: 6,
            endColumn: 10,
            active: false,
          },
        ],
      ),
    ).toBeUndefined();
  });
});
