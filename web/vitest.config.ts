// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "import.meta.env.NETTLE_ENABLE_AZURE_BUNDLES": JSON.stringify("true"),
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**"],
    environment: "node",
  },
});
