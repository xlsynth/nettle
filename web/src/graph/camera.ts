// SPDX-License-Identifier: Apache-2.0

export interface CameraViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CameraPoint {
  x: number;
  y: number;
}

export interface CameraTransform {
  scale: number;
  x: number;
  y: number;
}

export interface CameraDelta {
  x: number;
  y: number;
}

export interface CameraBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Returns the smallest rectangle containing every supplied world-space bound. */
export function unionCameraBounds(bounds: readonly CameraBounds[]): CameraBounds | undefined {
  if (bounds.length === 0) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const bound of bounds) {
    left = Math.min(left, bound.x);
    top = Math.min(top, bound.y);
    right = Math.max(right, bound.x + Math.max(0, bound.width));
    bottom = Math.max(bottom, bound.y + Math.max(0, bound.height));
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Pads a target rectangle and clamps the resulting fit camera to the layout world. */
export function cameraViewBoxForBounds(
  target: CameraBounds,
  world: Pick<CameraViewBox, "width" | "height">,
  padding = 24,
): CameraViewBox {
  const worldWidth = Math.max(1, world.width);
  const worldHeight = Math.max(1, world.height);
  const safePadding = Math.max(0, padding);
  const left = Math.max(0, Math.min(worldWidth - 1, target.x - safePadding));
  const top = Math.max(0, Math.min(worldHeight - 1, target.y - safePadding));
  const right = Math.max(
    left + 1,
    Math.min(worldWidth, target.x + Math.max(0, target.width) + safePadding),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(worldHeight, target.y + Math.max(0, target.height) + safePadding),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function cameraTransform(camera: CameraViewBox, viewport: ViewportSize): CameraTransform {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const scale = Math.min(width / camera.width, height / camera.height);
  return {
    scale,
    x: (width - camera.width * scale) / 2 - camera.x * scale,
    y: (height - camera.height * scale) / 2 - camera.y * scale,
  };
}

/** Returns a resized camera whose world point under `anchor` does not move on screen. */
export function resizeCameraAt(
  camera: CameraViewBox,
  size: Pick<CameraViewBox, "width" | "height">,
  viewport: ViewportSize,
  anchor: CameraPoint,
): CameraViewBox {
  const before = cameraTransform(camera, viewport);
  const worldX = (anchor.x - before.x) / before.scale;
  const worldY = (anchor.y - before.y) / before.scale;
  const nextScale = Math.min(viewport.width / size.width, viewport.height / size.height);
  const letterboxX = (viewport.width - size.width * nextScale) / 2;
  const letterboxY = (viewport.height - size.height * nextScale) / 2;

  return {
    x: worldX - (anchor.x - letterboxX) / nextScale,
    y: worldY - (anchor.y - letterboxY) / nextScale,
    width: size.width,
    height: size.height,
  };
}

/** Moves a camera by a screen-space drag while respecting SVG `meet` letterboxing. */
export function panCameraByScreenDelta(
  camera: CameraViewBox,
  viewport: ViewportSize,
  delta: CameraDelta,
): CameraViewBox {
  const { scale } = cameraTransform(camera, viewport);
  return {
    ...camera,
    x: camera.x - delta.x / scale,
    y: camera.y - delta.y / scale,
  };
}

/** Converts browser wheel units into a bounded, smooth multiplicative zoom step. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const pixelDelta =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * viewportHeight : deltaY;
  return Math.exp(Math.max(-0.32, Math.min(0.32, pixelDelta * 0.0015)));
}

/** Applies zoom limits without changing the camera aspect ratio. */
export function constrainedCameraSize(
  camera: CameraViewBox,
  factor: number,
  limits: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number },
): Pick<CameraViewBox, "width" | "height"> {
  const minimumFactor = Math.max(limits.minWidth / camera.width, limits.minHeight / camera.height);
  const maximumFactor = Math.min(limits.maxWidth / camera.width, limits.maxHeight / camera.height);
  // A camera can already sit outside newly supplied limits after a layout
  // change. Never make a zoom-in command zoom out (or vice versa) merely to
  // force such a camera back inside those limits.
  const boundedFactor =
    factor < 1
      ? Math.min(1, Math.max(factor, Math.min(1, minimumFactor)))
      : factor > 1
        ? Math.max(1, Math.min(factor, Math.max(1, maximumFactor)))
        : 1;
  return {
    width: camera.width * boundedFactor,
    height: camera.height * boundedFactor,
  };
}

const centeredAxis = (center: number, size: number, worldSize: number) =>
  size >= worldSize
    ? (worldSize - size) / 2
    : Math.max(0, Math.min(center - size / 2, worldSize - size));

/**
 * Centers a camera on an entity without panning a full-fit world offscreen.
 * Change navigation may request a bounded zoom; policy-driven refocusing
 * keeps the current zoom and only recenters it.
 */
export function cameraFocusedOnBounds(
  camera: CameraViewBox,
  target: CameraBounds,
  world: Pick<CameraViewBox, "width" | "height">,
  zoomToTarget = false,
): CameraViewBox {
  const targetFactor = zoomToTarget
    ? Math.min(
        1,
        Math.max(
          0.3,
          (Math.max(1, target.width) * 4) / camera.width,
          (Math.max(1, target.height) * 4) / camera.height,
        ),
      )
    : 1;
  const width = camera.width * targetFactor;
  const height = camera.height * targetFactor;
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  return {
    x: centeredAxis(centerX, width, world.width),
    y: centeredAxis(centerY, height, world.height),
    width,
    height,
  };
}
