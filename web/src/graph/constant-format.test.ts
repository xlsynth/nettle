// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatConstantLiteral } from "./constant-format";

describe("constant literal formatting", () => {
  it("converts known binary constants without losing their declared width", () => {
    expect(formatConstantLiteral("8'b00101010", "binary")).toBe("8'b00101010");
    expect(formatConstantLiteral("8'b00101010", "hex")).toBe("8'h2a");
    expect(formatConstantLiteral("8'b00101010", "decimal")).toBe("8'd42");
    expect(
      formatConstantLiteral(
        "64'b1111111111111111111111111111111111111111111111111111111111111111",
        "decimal",
      ),
    ).toBe("64'd18446744073709551615");
  });

  it("preserves Yosys fill shorthand and unknown-state information", () => {
    expect(formatConstantLiteral("8'b0", "hex")).toBe("8'h0");
    expect(formatConstantLiteral("8'bx", "decimal")).toBe("8'dx");
    expect(formatConstantLiteral("8'bz", "hex")).toBe("8'hz");
    expect(formatConstantLiteral("3'bx", "hex")).toBe("3'hx");
    expect(formatConstantLiteral("4'b10xz", "hex")).toBe("4'b10xz");
    expect(formatConstantLiteral("4'b10xz", "decimal")).toBe("4'b10xz");
  });

  it("leaves unsupported source expressions untouched", () => {
    expect(formatConstantLiteral("'1", "hex")).toBe("'1");
    expect(formatConstantLiteral("some_package::VALUE", "decimal")).toBe("some_package::VALUE");
    expect(formatConstantLiteral("4294967295'b0", "hex")).toBe("4294967295'b0");
  });
});
