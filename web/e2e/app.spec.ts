// SPDX-License-Identifier: Apache-2.0

import { expect, type Page, test } from "@playwright/test";

const fixture = "/tmp/nettle-browser-fixture.nettle";
const shiftRegisterFixture = "/tmp/nettle-shift-register-fixture.nettle";

const captureRuntimeErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

const openFixture = async (page: Page) => {
  await page.goto("/");
  await page.getByLabel("Choose a .nettle bundle").setInputFiles(fixture);
  await expect(page.getByText("LOCAL")).toBeVisible();
  await expect(page.getByText("Bundle ready")).toBeVisible();
  await expect(page.getByText(/slang .*ready/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open bundle" })).toContainText(
    "nettle-browser-fixture.nettle",
  );
};

test("opens a Rust-produced bundle entirely in the browser", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Nettle/);
  await expect(page.getByRole("heading", { name: "Open an elaborated design" })).toBeVisible();
  await expect(page.getByText("never uploaded")).toBeVisible();
  await page.getByLabel("Choose a .nettle bundle").setInputFiles(fixture);

  await expect(page.getByText("LOCAL")).toBeVisible();
  await expect(page.locator(".source-status")).toContainText("rtl/top.sv");
  await expect(page.locator(".monaco-editor")).toContainText("module top");
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);
  await expect(page.locator(".top-level-boundary")).toHaveCount(1);
  await expect(page.locator(".tree-row").filter({ hasText: "top.sv" })).toHaveCount(1);
  expect(apiRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("renders an inferred vector shift register as distinct pipeline stages", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.goto("/");
  await page.getByLabel("Choose a .nettle bundle").setInputFiles(shiftRegisterFixture);

  await expect(page.getByText("Bundle ready")).toBeVisible();
  await expect(page.locator(".schematic-node.kind-register")).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Select register DFF" })).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Select net pipe" })).toHaveCount(4);
  await expect(page.locator(".schematic-edge .edge-line.bus")).toHaveCount(0);
  await expect(page.locator(".canvas-state.error")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("automatically opens a bundle supplied by the viewer host", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.route("**/startup.nettle", (route) =>
    route.fulfill({
      path: fixture,
      contentType: "application/octet-stream",
      headers: { "cache-control": "no-store" },
    }),
  );

  await page.goto("/");
  await expect(page.getByText("LOCAL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open bundle" })).toContainText("startup.nettle");
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);
  expect(runtimeErrors).toEqual([]);
});

test("navigates and flattens lazily decoded modules", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await openFixture(page);

  await page.getByRole("button", { name: "Labels" }).click();
  const labels = page.getByRole("menu", { name: "Label visibility" });
  await labels.getByRole("checkbox", { name: "Signal types" }).check();
  await labels.getByRole("checkbox", { name: "Total bitwidth" }).check();
  await expect(page.locator(".bus-width-annotation text").first()).toHaveText("8");
  await page.getByRole("button", { name: "Labels" }).click();

  await page.locator(".schematic-node.kind-module").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Flatten selected instance" }).click();
  await expect(page.locator(".transparent-group")).toHaveCount(1);
  await expect(page.locator(".transparent-group")).toContainText("u_child");
  await page.getByRole("button", { name: "Restore instance" }).click();
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);

  await page.getByLabel("Flatten instance depth").selectOption("1");
  await expect(page.locator(".transparent-group")).toHaveCount(1);
  await page.getByLabel("Schematic layout profile").click();
  await page.getByRole("menuitemradio", { name: /Balanced layered flow/ }).click();
  await expect(page.getByLabel("Schematic layout profile")).toContainText("Balanced");
  await expect(page.locator(".transparent-group")).toHaveCount(1);
  await expect(page.locator(".schematic-node")).toHaveCount(4);
  await expect(page.locator(".canvas-state.error")).toHaveCount(0);
  const groupBox = await page.locator(".transparent-group .group-boundary").boundingBox();
  expect(groupBox).not.toBeNull();
  const inputPins = page.locator(".node-layer .kind-input .node-shape");
  const outputPins = page.locator(".node-layer .kind-output .node-shape");
  const inputBoxes = await Promise.all(
    Array.from({ length: await inputPins.count() }, (_, index) => inputPins.nth(index).boundingBox()),
  );
  const outputBoxes = await Promise.all(
    Array.from({ length: await outputPins.count() }, (_, index) =>
      outputPins.nth(index).boundingBox(),
    ),
  );
  const insideGroup = (box: NonNullable<(typeof inputBoxes)[number]>) =>
    groupBox && box.x >= groupBox.x - 2 && box.x + box.width <= groupBox.x + groupBox.width + 2;
  const childInputBox = inputBoxes.find((box) => box && insideGroup(box));
  const childOutputBox = outputBoxes.find((box) => box && insideGroup(box));
  expect(childInputBox).toBeDefined();
  expect(childOutputBox).toBeDefined();
  if (groupBox && childInputBox && childOutputBox) {
    expect(Math.abs(childInputBox.x - groupBox.x)).toBeLessThan(2);
    expect(
      Math.abs(childOutputBox.x + childOutputBox.width - (groupBox.x + groupBox.width)),
    ).toBeLessThan(2);
  }
  await page.getByLabel("Flatten render mode").click();
  const groupedMode = page.getByRole("menuitemradio", { name: /Grouped/ });
  await groupedMode.hover();
  await expect(groupedMode.getByRole("tooltip")).toContainText("non-overlapping region");
  const flatMode = page.getByRole("menuitemradio", { name: /Flat/ });
  await flatMode.hover();
  await expect(flatMode.getByRole("tooltip")).toContainText("one flat graph");
  await flatMode.click();
  await expect(page.getByLabel("Flatten render mode")).toContainText("Flat");
  await expect(page.locator(".transparent-group")).toHaveCount(0);
  await expect(page.locator(".schematic-node")).toHaveCount(2);
  await page.getByLabel("Flatten render mode").click();
  await page.getByRole("menuitemradio", { name: /Grouped/ }).click();
  await expect(page.locator(".transparent-group")).toHaveCount(1);
  await expect(page.locator(".schematic-node")).toHaveCount(4);
  await page.getByLabel("Flatten instance depth").selectOption("0");

  await page.locator(".schematic-node.kind-module").dblclick();
  await expect(page.getByRole("button", { name: "Up one hierarchy level" })).toBeEnabled();
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(0);
  await page.getByRole("button", { name: "Up one hierarchy level" }).click();
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);
  expect(runtimeErrors).toEqual([]);
});

test("switches the left pane between source and instance hierarchy", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await openFixture(page);

  await page.getByRole("tab", { name: "Hierarchy" }).click();
  const hierarchy = page.getByRole("tree", { name: "Design instances" });
  await expect(hierarchy.getByRole("button", { name: "top (top)" })).toBeVisible();
  await hierarchy.getByRole("button", { name: "u_child (child)" }).click();
  await expect(page.getByRole("button", { name: "Up one hierarchy level" })).toBeEnabled();
  await expect(page.locator(".source-status")).toContainText("top.u_child");

  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.getByRole("region", { name: "Read-only source" })).toBeVisible();
  await expect(page.locator(".monaco-editor")).toContainText("module child");
  expect(runtimeErrors).toEqual([]);
});

test("resizes the source pane and keeps schematic controls in view", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.setViewportSize({ width: 1180, height: 760 });
  await openFixture(page);

  const divider = page.getByRole("separator", { name: "Resize source and schematic panes" });
  const sourcePane = page.locator(".source-pane");
  const before = await sourcePane.boundingBox();
  const dividerBox = await divider.boundingBox();
  expect(before).not.toBeNull();
  expect(dividerBox).not.toBeNull();
  if (!before || !dividerBox) return;

  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 80, dividerBox.y + 120);
  await page.mouse.up();

  await expect.poll(async () => (await sourcePane.boundingBox())?.width).toBeGreaterThan(
    before.width + 60,
  );
  const draggedWidth = (await sourcePane.boundingBox())?.width ?? 0;
  await divider.focus();
  await divider.press("ArrowLeft");
  await expect.poll(async () => (await sourcePane.boundingBox())?.width).toBeLessThan(draggedWidth);

  const schematicBox = await page.locator(".schematic-panel").boundingBox();
  const toolbarBox = await page.locator(".schematic-toolbar").boundingBox();
  expect(schematicBox).not.toBeNull();
  expect(toolbarBox?.height).toBeGreaterThan(45);
  if (!schematicBox) return;
  const controls = page.locator(
    ".schematic-toolbar button:visible, .schematic-toolbar select:visible",
  );
  for (let index = 0; index < (await controls.count()); index += 1) {
    const controlBox = await controls.nth(index).boundingBox();
    expect(controlBox?.x).toBeGreaterThanOrEqual(schematicBox.x);
    expect((controlBox?.x ?? 0) + (controlBox?.width ?? 0)).toBeLessThanOrEqual(
      schematicBox.x + schematicBox.width,
    );
  }
  expect(runtimeErrors).toEqual([]);
});

test("rejects an invalid replacement without discarding the active bundle", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await openFixture(page);

  await page.getByRole("button", { name: "Open bundle" }).click();
  await page
    .getByRole("dialog", { name: "Open Nettle bundle" })
    .getByLabel("Choose a .nettle bundle")
    .setInputFiles({
      name: "broken.nettle",
      mimeType: "application/zip",
      buffer: Buffer.from("not a zip archive"),
    });
  await expect(
    page.getByRole("dialog", { name: "Open Nettle bundle" }).getByRole("alert"),
  ).toContainText("end-of-central-directory");
  await page.getByRole("button", { name: "Close open bundle dialog" }).click();
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);
  expect(runtimeErrors).toEqual([]);
});
