// SPDX-License-Identifier: Apache-2.0

module top #(
  parameter int WIDTH = 8
) (
  input  logic [WIDTH-1:0] data_i,
  input  logic             select_i,
  input  logic             enable_i,
  output logic [WIDTH-1:0] data_o,
  output logic             status_o
);
  logic [WIDTH-1:0] keep_o;
  logic [WIDTH-1:0] added_o;
  logic [WIDTH-1:0] combined;

  diff_child #(.WIDTH(WIDTH), .BIAS(1)) u_keep (
    .data_i,
    .data_o(keep_o)
  );
  new_child #(.WIDTH(WIDTH)) u_added (
    .data_i,
    .enable_i,
    .data_o(added_o)
  );

  assign combined = keep_o ^ added_o;
  assign data_o = enable_i ? combined : data_i;
  assign status_o = select_i && (|combined);
endmodule
