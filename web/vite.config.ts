// SPDX-License-Identifier: Apache-2.0

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", ["NETTLE_", "ENABLE_"]);
  const allowedHosts = environment.NETTLE_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return {
    define: {
      "import.meta.env.ENABLE_AZURE_BUNDLES": JSON.stringify(
        mode === "test" || environment.ENABLE_AZURE_BUNDLES === "true" ? "true" : "false",
      ),
    },
    plugins: [react()],
    server: {
      ...(allowedHosts?.length ? { allowedHosts } : {}),
      port: 8090,
      proxy: {
        "/api": environment.NETTLE_API_PROXY_TARGET ?? "http://127.0.0.1:8080",
      },
      strictPort: true,
    },
    worker: {
      format: "es",
    },
  };
});
