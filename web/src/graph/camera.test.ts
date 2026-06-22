// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  cameraTransform,
  constrainedCameraSize,
  panCameraByScreenDelta,
  resizeCameraAt,
  wheelZoomFactor,
} from "./camera";

describe("schematic camera", () => {
  it("fits a world view with centered letterboxing", () => {
    expect(
      cameraTransform({ x: 10, y: 20, width: 400, height: 200 }, { width: 1000, height: 800 }),
    ).toEqual({ scale: 2.5, x: -25, y: 100 });
  });

  it("keeps the world point under the pointer fixed while zooming", () => {
    const viewport = { width: 1000, height: 800 };
    const anchor = { x: 730, y: 170 };
    const before = { x: 10, y: 20, width: 400, height: 200 };
    const beforeTransform = cameraTransform(before, viewport);
    const worldBefore = {
      x: (anchor.x - beforeTransform.x) / beforeTransform.scale,
      y: (anchor.y - beforeTransform.y) / beforeTransform.scale,
    };

    const after = resizeCameraAt(before, { width: 320, height: 160 }, viewport, anchor);
    const afterTransform = cameraTransform(after, viewport);
    const worldAfter = {
      x: (anchor.x - afterTransform.x) / afterTransform.scale,
      y: (anchor.y - afterTransform.y) / afterTransform.scale,
    };

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10);
  });

  it("uses the uniform meet scale for panning through letterboxed space", () => {
    const camera = { x: 10, y: 20, width: 1_000, height: 100 };
    const moved = panCameraByScreenDelta(camera, { width: 500, height: 500 }, { x: 50, y: 50 });

    // The meet scale is 0.5 on both axes, even though the graph is letterboxed vertically.
    expect(moved.x).toBe(-90);
    expect(moved.y).toBe(-80);
  });

  it("normalizes trackpad, line, and page wheel deltas without unbounded jumps", () => {
    expect(wheelZoomFactor(1, 0, 800)).toBeCloseTo(Math.exp(0.0015));
    expect(wheelZoomFactor(1, 1, 800)).toBeCloseTo(Math.exp(0.024));
    expect(wheelZoomFactor(1, 2, 800)).toBeCloseTo(Math.exp(0.32));
    expect(wheelZoomFactor(-10_000, 0, 800)).toBeCloseTo(Math.exp(-0.32));
  });

  it("preserves camera aspect ratio when zoom limits are reached", () => {
    const size = constrainedCameraSize({ x: 0, y: 0, width: 2_000, height: 100 }, 0.01, {
      minWidth: 160,
      minHeight: 100,
      maxWidth: 8_000,
      maxHeight: 4_000,
    });
    expect(size).toEqual({ width: 2_000, height: 100 });
  });
});
