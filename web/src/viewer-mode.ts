// SPDX-License-Identifier: Apache-2.0

export type ViewerMode = "demo" | "hosted";

const configuredMode = import.meta.env.NETTLE_PUBLIC_MODE ?? "hosted";

if (configuredMode !== "demo" && configuredMode !== "hosted") {
  throw new Error(`NETTLE_PUBLIC_MODE must be demo or hosted; got ${configuredMode}`);
}

export const viewerMode: ViewerMode = configuredMode;
