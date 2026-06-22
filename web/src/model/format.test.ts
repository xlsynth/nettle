// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatJsonValue, MAX_DECIMAL_FORMAT_BITS, MAX_FORMATTED_METADATA_DEPTH } from "./format";
import type { JsonValue } from "./graph";

describe("formatJsonValue", () => {
  it("presents Yosys binary parameter strings as concrete decimal values", () => {
    expect(formatJsonValue("00000000000000000000000000001000")).toBe("8");
  });

  it("preserves non-binary strings and formats structured values", () => {
    expect(formatJsonValue("FAST")).toBe("FAST");
    expect(formatJsonValue({ WIDTH: 8 })).toBe('{"WIDTH":8}');
  });

  it("does not construct BigInts from oversized binary metadata", () => {
    const value = "1".repeat(MAX_DECIMAL_FORMAT_BITS + 1);
    expect(formatJsonValue(value)).toBe(value);
  });

  it("does not recursively stringify excessively deep metadata", () => {
    let value: JsonValue = "leaf";
    for (let depth = 0; depth <= MAX_FORMATTED_METADATA_DEPTH; depth += 1) {
      value = { child: value };
    }
    expect(formatJsonValue(value)).toBe("[metadata omitted: exceeds display limits]");
  });
});
