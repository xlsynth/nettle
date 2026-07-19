// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { GraphSlice, SourceElaborationRange } from "../model/graph";
import { elaborationRangesForSource, mergeElaborationRanges } from "./elaboration-ranges";

const range = (startLine: number, endLine: number, active: boolean): SourceElaborationRange => ({
  file: "rtl/top.sv",
  startLine,
  startColumn: 1,
  endLine,
  endColumn: 4,
  active,
});

const slice = (elaborationRanges?: SourceElaborationRange[]): GraphSlice => ({
  snapshotId: "snapshot",
  module: {
    id: "module",
    name: "shared",
    instancePath: "shared",
    definitionName: "shared",
    parameters: {},
  },
  nodes: [],
  edges: [],
  elaborationRanges,
});

describe("slice-scoped elaboration ranges", () => {
  it("selects opposite branch activity for two slices of the same source", () => {
    const trueSlice = slice([range(2, 4, true), range(5, 7, false)]);
    const falseSlice = slice([range(2, 4, false), range(5, 7, true)]);
    const globalFallback = [range(2, 4, true), range(5, 7, true)];

    expect(elaborationRangesForSource(trueSlice, "rtl/top.sv", globalFallback)).toEqual(
      trueSlice.elaborationRanges,
    );
    expect(elaborationRangesForSource(falseSlice, "rtl/top.sv", globalFallback)).toEqual(
      falseSlice.elaborationRanges,
    );
  });

  it("falls back to source-index activity when legacy slices have no range field", () => {
    const fallback = [range(2, 4, true)];
    expect(elaborationRangesForSource(slice(), "rtl/top.sv", fallback)).toEqual(fallback);
  });

  it("does not conflate canonical project paths that merely share a suffix", () => {
    const nested = { ...range(2, 4, false), file: "sub/rtl/top.sv" };
    const fallback = [range(2, 4, true)];
    expect(elaborationRangesForSource(slice([nested]), "rtl/top.sv", fallback)).toEqual([]);
  });

  it("folds duplicate projection ranges by activating a range selected in either slice", () => {
    expect(mergeElaborationRanges([range(2, 4, false)], [range(2, 4, true)], 2)).toEqual([
      range(2, 4, true),
    ]);
    expect(() => mergeElaborationRanges([range(2, 4, true)], [range(5, 7, true)], 1)).toThrow(
      "2 elaboration ranges, exceeding budget 1",
    );
  });

  it("preserves absent slice metadata so legacy projections retain their fallback", () => {
    expect(mergeElaborationRanges(undefined, undefined, 1)).toBeUndefined();
  });
});
