// SPDX-License-Identifier: Apache-2.0

import { expect, type Page, test } from "@playwright/test";

const netlistFixture = process.env.NETTLE_NETLIST_FIXTURE;

const captureRuntimeErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test("opens and lays out the synthesized Bedrock CDC FIFO netlist", async ({ page }) => {
  test.skip(!netlistFixture, "NETTLE_NETLIST_FIXTURE was not supplied");
  const runtimeErrors = captureRuntimeErrors(page);

  await page.goto("/");
  await page.getByLabel("Choose a .nettle bundle").setInputFiles(netlistFixture ?? "");
  await expect(page.getByText("Bundle ready")).toBeVisible();
  await expect(page.locator(".source-status")).toContainText("br_cdc_fifo_flops_synth.v", {
    timeout: 30_000,
  });
  await expect(page.locator(".schematic-node")).toHaveCount(767, { timeout: 30_000 });
  await expect(page.locator(".schematic-node.kind-register")).toHaveCount(154);
  await expect(page.locator(".schematic-edge")).toHaveCount(1_454);
  expect(runtimeErrors).toEqual([]);
});
