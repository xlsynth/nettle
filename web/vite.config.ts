// SPDX-License-Identifier: Apache-2.0

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "NETTLE_PUBLIC_BASE");
  return {
    base: env.NETTLE_PUBLIC_BASE || "/",
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
