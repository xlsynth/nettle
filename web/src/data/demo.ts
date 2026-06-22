// SPDX-License-Identifier: Apache-2.0

import type { GraphEdge, GraphNode, GraphSlice, ProjectSnapshot } from "../model/graph";

export const demoSource = `module alu #(
  parameter int XLEN = 32,
  parameter bit REGISTER_OUTPUT = 1
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic [XLEN-1:0]  a,
  input  logic [XLEN-1:0]  b,
  input  logic [3:0]       alu_op,
  output logic [XLEN-1:0]  result_q,
  output logic             zero
);

  logic [XLEN-1:0] result_d;

  always_comb begin
    unique case (alu_op)
      4'h0: result_d = a + b;
      4'h1: result_d = a - b;
      4'h2: result_d = a ^ b;
      4'h3: result_d = a << b[4:0];
      4'h4: result_d = ($signed(a) < $signed(b)) ? 1 : 0;
      default: result_d = '0;
    endcase
    zero = (result_d == '0);
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      result_q <= '0;
    else
      result_q <= result_d;
  end
endmodule
`;

const origin = (line: number, startColumn = 23, endColumn = 28) => [
  {
    file: "rtl/execute/alu.sv",
    startLine: line,
    startColumn,
    endLine: line,
    endColumn,
    role: "expression",
    quality: "exact" as const,
  },
];

const ports = {
  unaryIn: [{ id: "a", name: "A", direction: "input" as const }],
  binary: [
    { id: "a", name: "A", direction: "input" as const },
    { id: "b", name: "B", direction: "input" as const },
    { id: "y", name: "Y", direction: "output" as const },
  ],
};

export const demoNodes: GraphNode[] = [
  {
    id: "a",
    kind: "input",
    label: "a",
    ports: [{ id: "out", name: "a", direction: "output", width: 32 }],
  },
  {
    id: "b",
    kind: "input",
    label: "b",
    ports: [{ id: "out", name: "b", direction: "output", width: 32 }],
  },
  {
    id: "alu_op",
    kind: "input",
    label: "alu_op",
    ports: [{ id: "out", name: "alu_op", direction: "output", width: 4 }],
  },
  {
    id: "clk",
    kind: "input",
    label: "clk",
    ports: [{ id: "out", name: "clk", direction: "output", role: "clock" }],
  },
  {
    id: "rst_n",
    kind: "input",
    label: "rst_n",
    ports: [{ id: "out", name: "rst_n", direction: "output", role: "reset" }],
  },
  {
    id: "u_decode",
    kind: "module",
    label: "u_decode",
    definitionName: "decoder",
    parameters: { Ops: 5 },
    ports: [
      { id: "op", name: "op_i", direction: "input", width: 4 },
      { id: "sel", name: "sel", direction: "output", width: 3 },
    ],
    origins: origin(17, 5, 11),
  },
  {
    id: "add",
    kind: "operator",
    label: "Binary add",
    glyph: "+",
    ports: ports.binary,
    origins: origin(17, 26, 31),
  },
  {
    id: "sub",
    kind: "operator",
    label: "Binary subtract",
    glyph: "−",
    ports: ports.binary,
    origins: origin(18, 26, 31),
  },
  {
    id: "xor",
    kind: "operator",
    label: "Bitwise xor",
    glyph: "^",
    ports: ports.binary,
    origins: origin(19, 26, 31),
  },
  {
    id: "shl",
    kind: "operator",
    label: "Shift left",
    glyph: "<<",
    ports: ports.binary,
    origins: origin(20, 26, 37),
  },
  {
    id: "lt",
    kind: "operator",
    label: "Signed less than",
    glyph: "<",
    ports: ports.binary,
    origins: origin(21, 26, 57),
  },
  {
    id: "mux",
    kind: "mux",
    label: "result mux",
    ports: [
      { id: "i0", name: "0", direction: "input" },
      { id: "i1", name: "1", direction: "input" },
      { id: "i2", name: "2", direction: "input" },
      { id: "i3", name: "3", direction: "input" },
      { id: "i4", name: "4", direction: "input" },
      { id: "sel", name: "sel", direction: "input", role: "select", width: 3 },
      { id: "y", name: "Y", direction: "output", width: 32 },
    ],
    origins: origin(16, 5, 11),
  },
  {
    id: "result_q",
    kind: "register",
    label: "result_q",
    ports: [
      { id: "d", name: "D", direction: "input", width: 32 },
      { id: "q", name: "Q", direction: "output", width: 32 },
      { id: "clk", name: "CLK", direction: "input", role: "clock" },
      { id: "rst", name: "RST_N", direction: "input", role: "reset" },
    ],
    origins: origin(31, 7, 27),
    metadata: { edge: "posedge", reset: "async active-low" },
  },
  {
    id: "u_shifter",
    kind: "module",
    label: "u_shifter",
    definitionName: "barrel_shifter",
    parameters: { Width: 32 },
    transparent: true,
    ports: [
      { id: "a", name: "data_i", direction: "input", width: 32 },
      { id: "y", name: "data_o", direction: "output", width: 32 },
    ],
    origins: origin(20, 26, 37),
  },
  {
    id: "result_o",
    kind: "output",
    label: "result_o",
    ports: [{ id: "in", name: "result_o", direction: "input", width: 32 }],
  },
];

const edge = (
  id: string,
  sourceNode: string,
  sourcePort: string,
  targetNode: string,
  targetPort: string,
  label?: string,
  width = 32,
  role: GraphEdge["role"] = "data",
): GraphEdge => ({ id, sourceNode, sourcePort, targetNode, targetPort, label, width, role });

export const demoEdges: GraphEdge[] = [
  edge("a_add", "a", "out", "add", "a", "a[31:0]"),
  edge("b_add", "b", "out", "add", "b", "b[31:0]"),
  edge("a_sub", "a", "out", "sub", "a"),
  edge("b_sub", "b", "out", "sub", "b"),
  edge("a_xor", "a", "out", "xor", "a"),
  edge("b_xor", "b", "out", "xor", "b"),
  edge("a_shl", "a", "out", "u_shifter", "a"),
  edge("shift_mux", "u_shifter", "y", "mux", "i3"),
  edge("a_lt", "a", "out", "lt", "a"),
  edge("b_lt", "b", "out", "lt", "b"),
  edge("add_mux", "add", "y", "mux", "i0", "add_sum[31:0]"),
  edge("sub_mux", "sub", "y", "mux", "i1"),
  edge("xor_mux", "xor", "y", "mux", "i2"),
  edge("lt_mux", "lt", "y", "mux", "i4"),
  edge("op_decode", "alu_op", "out", "u_decode", "op", "alu_op[3:0]", 4, "control"),
  edge("decode_mux", "u_decode", "sel", "mux", "sel", "sel[2:0]", 3, "control"),
  edge("mux_d", "mux", "y", "result_q", "d", "alu_res_nxt[31:0]"),
  edge("clk_reg", "clk", "out", "result_q", "clk", "clk", 1, "clock"),
  edge("rst_reg", "rst_n", "out", "result_q", "rst", "rst_n", 1, "reset"),
  edge("q_out", "result_q", "q", "result_o", "in", "result_q[31:0]"),
];

export const demoSlice: GraphSlice = {
  snapshotId: "demo-2026-06-16",
  module: {
    id: "alu-variant-32",
    name: "alu",
    instancePath: "core_top.execute.alu",
    definitionName: "alu",
    parameters: { XLEN: 32, REGISTER_OUTPUT: true },
  },
  nodes: demoNodes,
  edges: demoEdges,
};

export const demoProject: ProjectSnapshot = {
  name: "cpu_core.f",
  projectRoot: ".",
  filelist: "cpu_core.f",
  yosysJson: "",
  slangAstJson: "",
  bundleStatus: "Bundle ready",
  snapshotId: demoSlice.snapshotId,
  files: [
    {
      name: "rtl",
      path: "rtl",
      kind: "directory",
      children: [
        { name: "core_top.sv", path: "rtl/core_top.sv", kind: "file" },
        {
          name: "execute",
          path: "rtl/execute",
          kind: "directory",
          children: [
            { name: "alu.sv", path: "rtl/execute/alu.sv", kind: "file" },
            { name: "regfile.sv", path: "rtl/execute/regfile.sv", kind: "file" },
            { name: "branch_unit.sv", path: "rtl/execute/branch_unit.sv", kind: "file" },
          ],
        },
        {
          name: "decode",
          path: "rtl/decode",
          kind: "directory",
          children: [
            { name: "decoder.sv", path: "rtl/decode/decoder.sv", kind: "file" },
            { name: "imm_gen.sv", path: "rtl/decode/imm_gen.sv", kind: "file" },
          ],
        },
      ],
    },
  ],
  defines: [
    { name: "SYNTHESIS", value: "1", origin: "cpu_core.f:2" },
    { name: "XLEN", value: "32", origin: "cpu_core.f:3" },
  ],
  elaboration: {
    parameters: [],
    defines: [],
    undefines: [],
  },
  effectiveElaboration: {
    parameters: [],
    defines: [
      { name: "SYNTHESIS", value: "1" },
      { name: "XLEN", value: "32" },
    ],
    undefines: [],
  },
  inputMode: "fixture",
  tools: [],
};
