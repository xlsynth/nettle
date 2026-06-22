// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: "performance.spec.ts",
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
});
