// SPDX-License-Identifier: Apache-2.0

module child #(
  parameter int WIDTH = 8
) (
  input  logic [WIDTH-1:0] in,
  output logic [WIDTH-1:0] out
);
  assign out = in ^ WIDTH'(1);
endmodule
