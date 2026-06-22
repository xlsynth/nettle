// SPDX-License-Identifier: Apache-2.0

import { bench, describe } from "vitest";
import { makeLayeredBenchmarkSlice } from "./benchmark-fixture";
import { runElkLayout } from "./elk-layout";

describe("ELK layered hardware graph", () => {
  for (const nodeCount of [500, 2_000, 5_000]) {
    const slice = makeLayeredBenchmarkSlice(nodeCount);
    bench(
      `${nodeCount.toLocaleString()} nodes / ${slice.edges.length.toLocaleString()} edges`,
      async () => {
        await runElkLayout(slice, "detailed");
      },
      {
        iterations: 5,
        warmupIterations: 1,
        time: 0,
        warmupTime: 0,
      },
    );
  }
});

describe("Grouped-grid hardware overview", () => {
  for (const nodeCount of [500, 2_000, 5_000]) {
    const slice = makeLayeredBenchmarkSlice(nodeCount);
    bench(
      `${nodeCount.toLocaleString()} nodes / ${slice.edges.length.toLocaleString()} edges`,
      async () => {
        await runElkLayout(slice, "fast");
      },
      {
        iterations: 5,
        warmupIterations: 1,
        time: 0,
        warmupTime: 0,
      },
    );
  }
});
