#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

if (!process.env.NETTLE_NETLIST_FIXTURE) process.exit(0);

const require = createRequire(import.meta.url);
const playwright = require.resolve("@playwright/test/cli");
const result = spawnSync(
  process.execPath,
  [playwright, "test", "e2e/netlist.spec.ts", "--workers=1"],
  { cwd: new URL("../web", import.meta.url), stdio: "inherit", env: process.env },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
