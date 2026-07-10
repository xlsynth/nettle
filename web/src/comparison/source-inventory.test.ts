// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SourceInventoryEntry } from "../api/contracts";
import { compareSourceInventories } from "./source-inventory";

const source = (id: string, path: string, sha256: string): SourceInventoryEntry => ({
  id,
  path,
  sha256,
  size: 10,
});

describe("compareSourceInventories", () => {
  it("classifies same-path content without reading source bodies", () => {
    const result = compareSourceInventories(
      [source("r-a", "rtl/a.sv", "same"), source("r-b", "rtl/b.sv", "old")],
      [source("c-a", "rtl/a.sv", "same"), source("c-b", "rtl/b.sv", "new")],
    );

    expect(result.map(({ status }) => status)).toEqual(["unchanged", "modified"]);
    expect(result[0].reference?.id).toBe("r-a");
    expect(result[0].candidate?.id).toBe("c-a");
  });

  it("infers only unique exact-digest renames", () => {
    const result = compareSourceInventories(
      [
        source("unique-old", "old.sv", "unique"),
        source("copy-a", "a.sv", "duplicate"),
        source("copy-b", "b.sv", "duplicate"),
      ],
      [source("unique-new", "new.sv", "unique"), source("copy-c", "c.sv", "duplicate")],
    );

    const rename = result.find(({ status }) => status === "renamed");
    expect(rename?.reference?.path).toBe("old.sv");
    expect(rename?.candidate?.path).toBe("new.sv");
    expect(result.filter(({ status }) => status === "renamed")).toHaveLength(1);
    expect(result.filter(({ status }) => status === "removed")).toHaveLength(2);
    expect(result.filter(({ status }) => status === "added")).toHaveLength(1);
  });

  it("normalizes paths and rejects duplicates after normalization", () => {
    expect(() =>
      compareSourceInventories([source("a", "./rtl/a.sv", "a"), source("b", "rtl/a.sv", "b")], []),
    ).toThrow("duplicate path rtl/a.sv");
  });

  it("is deterministic under input reordering", () => {
    const reference = [source("a", "a.sv", "a"), source("b", "b.sv", "b")];
    const candidate = [source("c", "c.sv", "c"), source("b2", "b.sv", "b")];
    expect(compareSourceInventories(reference, candidate)).toEqual(
      compareSourceInventories([...reference].reverse(), [...candidate].reverse()),
    );
  });
});
