// SPDX-License-Identifier: Apache-2.0

`include "defs.svh"

module top #(
  parameter int WIDTH = 8
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic [WIDTH-1:0] a,
  input  logic [WIDTH-1:0] b,
  input  logic             select,
  output logic [WIDTH-1:0] y
);
  logic [WIDTH-1:0] sum;
  logic [WIDTH-1:0] selected;

  assign sum = a + b;
  assign selected = select ? sum : a;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      y <= `RESET_VALUE;
    else
      y <= selected;
  end

  child #(.WIDTH(WIDTH)) u_child (.in(y), .out());
endmodule
