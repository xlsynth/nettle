// SPDX-License-Identifier: Apache-2.0

module top #(
  parameter int WIDTH = 2,
  parameter bit USE_XOR = 1'b1
) (
  input  logic [WIDTH-1:0] a,
  input  logic [WIDTH-1:0] b,
  output logic [WIDTH-1:0] y
);
  for (genvar i = 0; i < WIDTH; i++) begin : g_bit
    if (USE_XOR) begin : g_xor
      assign y[i] = a[i] ^ b[i];
    end else begin : g_or
      assign y[i] = a[i] | b[i];
    end
  end
endmodule
