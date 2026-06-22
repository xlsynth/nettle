#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const glibc = process.report?.getReport().header.glibcVersionRuntime;
const [major = 0, minor = 0] = (glibc ?? "0.0").split(".").map(Number);
const oldGlibc = process.platform === "linux" && (major < 2 || (major === 2 && minor < 29));

let command;
let args;
if (process.env.BIOME_BINARY) {
  command = process.env.BIOME_BINARY;
  args = process.argv.slice(2);
} else if (oldGlibc && process.arch === "x64") {
  command = require.resolve("@biomejs/cli-linux-x64-musl/biome");
  args = process.argv.slice(2);
} else {
  command = process.execPath;
  args = [require.resolve("@biomejs/biome/bin/biome"), ...process.argv.slice(2)];
}

const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
