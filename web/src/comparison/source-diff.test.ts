// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { changedSourceHunks, diffSourceTexts, diffSourceTextsAsync } from "./source-diff";
import { diffSourceTextsInWorker } from "./source-diff-client";

describe("bundled source line diff", () => {
  it("returns positioned changes and unchanged line correspondence", () => {
    const result = diffSourceTexts(
      "rtl/old.sv",
      "rtl/new.sv",
      "first\nold\nlast\n",
      "first\nnew\nlast\n",
      { referenceLines: [3, 1, 3] },
    );

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect([...result.lineMapping.referenceToCandidate]).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(result.changes).toEqual([
      expect.objectContaining({ count: 1, referenceStartLine: 1, candidateStartLine: 1 }),
      expect.objectContaining({ removed: true, count: 1, referenceStartLine: 2 }),
      expect.objectContaining({ added: true, count: 1, candidateStartLine: 2 }),
      expect.objectContaining({ count: 1, referenceStartLine: 3, candidateStartLine: 3 }),
    ]);
    expect(changedSourceHunks(result)).toEqual([
      {
        referenceStartLine: 2,
        referenceEndLine: 2,
        candidateStartLine: 2,
        candidateEndLine: 2,
      },
    ]);
  });

  it("materializes correspondence only for requested graph origin lines", () => {
    const common = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`);
    const reference = [...common.slice(0, 10_000), "old", ...common.slice(10_000)].join("\n");
    const candidate = [...common.slice(0, 10_000), "new", ...common.slice(10_000)].join("\n");

    const presentation = diffSourceTexts("a.sv", "a.sv", reference, candidate);
    expect(presentation.status).toBe("complete");
    if (presentation.status !== "complete") return;
    expect(presentation.lineMapping.referenceToCandidate.size).toBe(0);

    const matching = diffSourceTexts("a.sv", "a.sv", reference, candidate, {
      referenceLines: [1, 10_000, 10_001, 20_001],
    });
    expect(matching.status).toBe("complete");
    if (matching.status !== "complete") return;
    expect([...matching.lineMapping.referenceToCandidate]).toEqual([
      [1, 1],
      [10_000, 10_000],
      [20_001, 20_001],
    ]);
  });

  it("rejects invalid requested mapping lines", async () => {
    expect(() => diffSourceTexts("a.sv", "a.sv", "a\n", "a\n", { referenceLines: [0] })).toThrow(
      "positive safe integers",
    );
    await expect(
      diffSourceTextsAsync("a.sv", "a.sv", "a\n", "a\n", { referenceLines: [1.5] }),
    ).rejects.toThrow("positive safe integers");
  });

  it("fails closed at source-byte and edit-distance bounds", () => {
    expect(diffSourceTexts("a.sv", "a.sv", "abcd", "abcd", { maxSourceBytes: 3 })).toMatchObject({
      status: "tooLarge",
      reason: "sourceBytes",
    });
    expect(
      diffSourceTexts("a.sv", "a.sv", "a\nb\nc\n", "x\ny\nz\n", {
        maxEditLength: 1,
      }),
    ).toMatchObject({ status: "tooLarge", reason: "editLength" });
  });

  it("supports asynchronous diffing and abort", async () => {
    const complete = await diffSourceTextsAsync("a.sv", "a.sv", "a\n", "a\nb\n");
    expect(complete.status).toBe("complete");

    const controller = new AbortController();
    controller.abort();
    await expect(
      diffSourceTextsAsync("a.sv", "a.sv", "a\n", "b\n", {}, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("provides a worker-backed API with a non-browser fallback", async () => {
    const complete = await diffSourceTextsInWorker("a.sv", "a.sv", "a\n", "a\nb\n");
    expect(complete.status).toBe("complete");

    const controller = new AbortController();
    controller.abort();
    await expect(
      diffSourceTextsInWorker("a.sv", "a.sv", "a\n", "b\n", {}, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
