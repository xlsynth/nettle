// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  cameraFocusedOnBounds,
  cameraTransform,
  cameraViewBoxForBounds,
  constrainedCameraSize,
  panCameraByScreenDelta,
  resizeCameraAt,
  unionCameraBounds,
  wheelZoomFactor,
} from "./camera";

describe("schematic camera", () => {
  it("unions sparse visible geometry and fits only that region", () => {
    const bounds = unionCameraBounds([
      { x: 4_700, y: 3_130, width: 0, height: 0 },
      { x: 4_800, y: 3_100, width: 80, height: 60 },
    ]);
    expect(bounds).toEqual({ x: 4_700, y: 3_100, width: 180, height: 60 });
    if (!bounds) throw new Error("expected visible geometry bounds");
    expect(cameraViewBoxForBounds(bounds, { width: 6_000, height: 4_000 }, 24)).toEqual({
      x: 4_676,
      y: 3_076,
      width: 228,
      height: 108,
    });
  });

  it("clamps a padded visible-geometry fit at the union-world boundary", () => {
    expect(
      cameraViewBoxForBounds({ x: 5, y: 3, width: 40, height: 20 }, { width: 100, height: 80 }, 24),
    ).toEqual({ x: 0, y: 0, width: 69, height: 47 });
    expect(unionCameraBounds([])).toBeUndefined();
  });

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

  it("never reverses the requested zoom direction when the camera starts outside limits", () => {
    expect(
      constrainedCameraSize({ x: 0, y: 0, width: 80, height: 60 }, 0.84, {
        minWidth: 160,
        minHeight: 100,
        maxWidth: 8_000,
        maxHeight: 4_000,
      }),
    ).toEqual({ width: 80, height: 60 });
    expect(
      constrainedCameraSize({ x: 0, y: 0, width: 10_000, height: 8_000 }, 1.18, {
        minWidth: 160,
        minHeight: 100,
        maxWidth: 8_000,
        maxHeight: 4_000,
      }),
    ).toEqual({ width: 10_000, height: 8_000 });
  });

  it("zooms to a change while clamping the camera inside the layout world", () => {
    const focused = cameraFocusedOnBounds(
      { x: 0, y: 0, width: 200, height: 600 },
      { x: 86, y: 420, width: 28, height: 28 },
      { width: 200, height: 600 },
      true,
    );
    expect(focused.x).toBeCloseTo(44);
    expect(focused.y).toBeCloseTo(264);
    expect(focused.width).toBeCloseTo(112);
    expect(focused.height).toBeCloseTo(336);
  });

  it("keeps a full-fit camera fitted when merely refocusing", () => {
    expect(
      cameraFocusedOnBounds(
        { x: 0, y: 0, width: 200, height: 600 },
        { x: 86, y: 420, width: 28, height: 28 },
        { width: 200, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0, width: 200, height: 600 });
  });
});
