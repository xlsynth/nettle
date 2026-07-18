// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const gitSha = () => {
  const configured = process.env.NETTLE_BUILD_GIT_SHA;
  return configured?.trim()
    ? configured
    : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
};

const buildDateUtc = () => {
  if (process.env.NETTLE_BUILD_DATE_UTC) return process.env.NETTLE_BUILD_DATE_UTC;
  if (process.env.SOURCE_DATE_EPOCH) {
    const seconds = Number.parseInt(process.env.SOURCE_DATE_EPOCH, 10);
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw new Error(`Invalid SOURCE_DATE_EPOCH: ${process.env.SOURCE_DATE_EPOCH}`);
    }
    return new Date(seconds * 1_000).toISOString().replace(".000Z", "Z");
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
};

const buildSuffix = () => {
  const configured = process.env.NETTLE_BUILD_STATE;
  if (configured !== undefined) {
    if (configured === "dirty") return " (dirty)";
    if (configured === "dev") return " (dev branch)";
    if (configured === "clean") return "";
    throw new Error(`NETTLE_BUILD_STATE must be clean, dev, or dirty; got ${configured}`);
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    encoding: "utf8",
  });
  if (dirty) return " (dirty)";
  const containingRefs = execFileSync(
    "git",
    [
      "for-each-ref",
      "--contains",
      "HEAD",
      "--format=%(refname)",
      "refs/heads/main",
      "refs/remotes",
    ],
    { encoding: "utf8" },
  );
  return containingRefs
    .split("\n")
    .some((reference) => reference === "refs/heads/main" || reference.endsWith("/main"))
    ? ""
    : " (dev branch)";
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "NETTLE_PUBLIC_");
  return {
    base: env.NETTLE_PUBLIC_BASE || "/",
    define: {
      "import.meta.env.NETTLE_BUILD_DATE_UTC": JSON.stringify(buildDateUtc()),
      "import.meta.env.NETTLE_BUILD_GIT_SHA": JSON.stringify(gitSha()),
      "import.meta.env.NETTLE_BUILD_SUFFIX": JSON.stringify(buildSuffix()),
      "import.meta.env.NETTLE_PUBLIC_DEMOS": JSON.stringify(env.NETTLE_PUBLIC_DEMOS === "true"),
    },
    plugins: [react()],
    server: {
      port: 8090,
      strictPort: true,
    },
    worker: {
      format: "es",
    },
  };
});
