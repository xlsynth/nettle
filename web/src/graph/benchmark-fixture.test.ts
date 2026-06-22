// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeLayeredBenchmarkSlice } from "./benchmark-fixture";

describe("layout benchmark fixture", () => {
  it("keeps the requested node count and a bounded edge budget", () => {
    const slice = makeLayeredBenchmarkSlice(5_000);
    expect(slice.nodes).toHaveLength(5_000);
    expect(slice.edges.length).toBeGreaterThan(5_000);
    expect(slice.edges.length).toBeLessThanOrEqual(10_000);
  });
});
