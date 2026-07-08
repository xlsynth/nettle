// SPDX-License-Identifier: Apache-2.0

export type StartupMatchingPolicy = "conservative" | "aggressive";

export interface StartupBundleDescriptor {
  name: string;
  route: string;
}

export interface ComparisonStartupDescriptor {
  reference: StartupBundleDescriptor;
  candidate: StartupBundleDescriptor;
  matching: StartupMatchingPolicy;
}

const startupBundle = (value: unknown, side: string): StartupBundleDescriptor => {
  if (!value || typeof value !== "object") {
    throw new Error(`Comparison startup ${side} descriptor is missing`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.toLowerCase().endsWith(".nettle")) {
    throw new Error(`Comparison startup ${side} name is invalid`);
  }
  if (
    typeof record.route !== "string" ||
    !record.route.startsWith("/") ||
    record.route.startsWith("//") ||
    record.route.includes("\\") ||
    record.route.includes("\0")
  ) {
    throw new Error(`Comparison startup ${side} route is invalid`);
  }
  return { name: record.name, route: record.route };
};

export const decodeComparisonStartup = (value: unknown): ComparisonStartupDescriptor => {
  if (!value || typeof value !== "object") {
    throw new Error("Comparison startup descriptor is invalid");
  }
  const record = value as Record<string, unknown>;
  const matching = record.matching;
  if (matching !== "conservative" && matching !== "aggressive") {
    throw new Error("Comparison startup matching policy is invalid");
  }
  return {
    reference: startupBundle(record.reference, "reference"),
    candidate: startupBundle(record.candidate, "candidate"),
    matching,
  };
};

export const startupFile = async (
  descriptor: StartupBundleDescriptor,
  signal?: AbortSignal,
): Promise<File> => {
  const response = await fetch(descriptor.route, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`startup bundle request failed (${response.status})`);
  }
  if (response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("startup bundle route returned HTML");
  }
  return new File([await response.blob()], descriptor.name, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
};
