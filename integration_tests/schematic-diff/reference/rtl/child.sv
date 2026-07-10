// SPDX-License-Identifier: Apache-2.0

module diff_child #(
  parameter int WIDTH = 8,
  parameter int BIAS = 1
) (
  input  logic [WIDTH-1:0] data_i,
  output logic [WIDTH-1:0] data_o
);
  assign data_o = data_i + BIAS;
endmodule

module legacy_child #(
  parameter int WIDTH = 8
) (
  input  logic [WIDTH-1:0] data_i,
  output logic [WIDTH-1:0] data_o
);
  assign data_o = ~data_i;
endmodule
