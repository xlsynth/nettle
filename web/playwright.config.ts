// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };

const localChromium = process.env.NETTLE_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/performance.spec.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:19090",
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
    command: "../node_modules/.bin/vite --host 127.0.0.1 --port 19090",
    cwd: ".",
    url: "http://127.0.0.1:19090",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
