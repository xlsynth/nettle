// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decodeComparisonStartup } from "./startup";

describe("comparison startup descriptor", () => {
  it("accepts a bounded same-origin route contract", () => {
    expect(
      decodeComparisonStartup({
        reference: { name: "before.nettle", route: "/startup-reference.nettle" },
        candidate: { name: "after.nettle", route: "/startup-candidate.nettle" },
        matching: "aggressive",
      }),
    ).toEqual({
      reference: { name: "before.nettle", route: "/startup-reference.nettle" },
      candidate: { name: "after.nettle", route: "/startup-candidate.nettle" },
      matching: "aggressive",
    });
  });

  it("rejects unsafe or incomplete descriptors", () => {
    expect(() =>
      decodeComparisonStartup({
        reference: { name: "before.nettle", route: "https://example.test/before.nettle" },
        candidate: { name: "after.nettle", route: "/after.nettle" },
        matching: "conservative",
      }),
    ).toThrow("reference route");
    expect(() =>
      decodeComparisonStartup({
        reference: { name: "before.nettle", route: "/before.nettle" },
        candidate: { name: "after.nettle", route: "/after.nettle" },
        matching: "unknown",
      }),
    ).toThrow("matching policy");
  });
});
