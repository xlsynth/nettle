// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };

const localChromium = process.env.NETTLE_CHROMIUM_PATH;
const configuredBase = process.env.NETTLE_PUBLIC_BASE ?? "/nettle/";
const basePath = `/${configuredBase.replace(/^\/+|\/+$/g, "")}/`;
const server = `http://127.0.0.1:19091${basePath}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "pages.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: server,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: localChromium
      ? {
          executablePath: localChromium,
          args: ["--no-sandbox"],
        }
      : undefined,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 960 } },
    },
  ],
  webServer: {
    command: "../node_modules/.bin/vite preview --host 127.0.0.1 --port 19091",
    cwd: ".",
    url: server,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
