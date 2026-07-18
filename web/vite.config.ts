// SPDX-License-Identifier: Apache-2.0

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "NETTLE_PUBLIC_");
  return {
    base: env.NETTLE_PUBLIC_BASE || "/",
    define: {
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
