// SPDX-License-Identifier: Apache-2.0

module top #(
  parameter int WIDTH = 8
) (
  input  logic [WIDTH-1:0] data_i,
  input  logic             select_i,
  output logic [WIDTH-1:0] data_o,
  output logic             legacy_o
);
  logic [WIDTH-1:0] keep_o;
  logic [WIDTH-1:0] removed_o;

  diff_child #(.WIDTH(WIDTH), .BIAS(1)) u_keep (
    .data_i,
    .data_o(keep_o)
  );
  legacy_child #(.WIDTH(WIDTH)) u_removed (
    .data_i,
    .data_o(removed_o)
  );

  assign data_o = select_i ? keep_o : removed_o;
  assign legacy_o = &removed_o;
endmodule
