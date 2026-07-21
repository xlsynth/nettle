// SPDX-License-Identifier: Apache-2.0

import { expect, type Page, test } from "@playwright/test";

const captureRuntimeErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test("opens both public examples beneath the Pages base path", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);

  await page.goto("./");
  await expect(page.getByText("Static mode", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Bedrock CDC FIFO/ }).click();
  await expect(page.locator(".mode-badge.local")).toContainText("LOCAL", { timeout: 30_000 });

  await page.goto("./");
  await page.getByRole("button", { name: /Schematic diff/ }).click();
  await expect(page.locator(".mode-badge.diff").getByText("DIFF", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(runtimeErrors).toEqual([]);
});
