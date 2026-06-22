// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readStreamWithLimit } from "./zip";

describe("bounded bundle stream reads", () => {
  it("rejects and cancels before retaining output beyond the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readStreamWithLimit(stream, 4, "test stream")).rejects.toThrow(
      "expands beyond its size limit",
    );
    expect(cancelled).toBe(true);
  });

  it("preserves legitimate output at the exact limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });

    await expect(readStreamWithLimit(stream, 4, "test stream")).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });
});
