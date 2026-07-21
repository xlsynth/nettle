// SPDX-License-Identifier: Apache-2.0

export type ViewerMode = "static" | "hosted";

const configuredMode = import.meta.env.NETTLE_PUBLIC_MODE ?? "hosted";

if (configuredMode !== "static" && configuredMode !== "hosted") {
  throw new Error(`NETTLE_PUBLIC_MODE must be static or hosted; got ${configuredMode}`);
}

export const viewerMode: ViewerMode = configuredMode;
