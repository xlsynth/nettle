// SPDX-License-Identifier: Apache-2.0

module top #(
  parameter int WIDTH = 2,
  parameter bit USE_XOR = 1'b1,
  parameter bit ENABLE_OPTIONAL = 1'b0,
  parameter int EMPTY_WIDTH = 0,
  parameter int CASE_MODE = 1
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

  if (ENABLE_OPTIONAL) begin : g_optional
    logic optional_value;
    assign optional_value = a[0];
  end

  for (genvar j = 0; j < EMPTY_WIDTH; j++) begin : g_empty
    logic empty_value;
    assign empty_value = a[j];
  end

  case (CASE_MODE)
    0: begin : g_case_zero
      logic case_zero_value;
      assign case_zero_value = a[0];
    end
    1: begin : g_case_one
      logic case_one_value;
      assign case_one_value = a[0];
    end
    default: begin : g_case_default
      logic case_default_value;
      assign case_default_value = b[0];
    end
  endcase

  logic [WIDTH-1:0] child_xor_y;
  logic [WIDTH-1:0] child_or_y;

  generated_child #(.WIDTH(WIDTH), .USE_XOR(1'b1)) u_child_xor (
    .a,
    .b,
    .y(child_xor_y)
  );
  generated_child #(.WIDTH(WIDTH), .USE_XOR(1'b0)) u_child_or (
    .a,
    .b,
    .y(child_or_y)
  );
endmodule

module generated_child #(
  parameter int WIDTH = 2,
  parameter bit USE_XOR = 1'b1
) (
  input  logic [WIDTH-1:0] a,
  input  logic [WIDTH-1:0] b,
  output logic [WIDTH-1:0] y
);
  if (USE_XOR) begin : g_xor
    assign y = a ^ b;
  end else begin : g_or
    assign y = a | b;
  end
endmodule
