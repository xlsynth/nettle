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
  const boundedFactor = Math.max(minimumFactor, Math.min(factor, maximumFactor));
  return {
    width: camera.width * boundedFactor,
    height: camera.height * boundedFactor,
  };
}
