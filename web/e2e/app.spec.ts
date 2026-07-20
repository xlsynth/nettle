// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { expect, type Page, test } from "@playwright/test";

const fixture = "/tmp/nettle-browser-fixture.nettle";
const shiftRegisterFixture = "/tmp/nettle-shift-register-fixture.nettle";
const comparisonReferenceFixture = "/tmp/nettle-comparison-reference.nettle";
const comparisonCandidateFixture = "/tmp/nettle-comparison-candidate.nettle";
const generateXorFixture = process.env.NETTLE_GENERATE_XOR_FIXTURE;
const generateOrFixture = process.env.NETTLE_GENERATE_OR_FIXTURE;
const realComparisonReferenceFixture = process.env.NETTLE_COMPARISON_REFERENCE_FIXTURE;
const realComparisonCandidateFixture = process.env.NETTLE_COMPARISON_CANDIDATE_FIXTURE;
const structuralReferenceFixture = process.env.NETTLE_STRUCTURAL_REFERENCE_FIXTURE;
const structuralCandidateFixture = process.env.NETTLE_STRUCTURAL_CANDIDATE_FIXTURE;
const generateSourceLines = readFileSync(
  new URL("../../integration_tests/generate/rtl/top.sv", import.meta.url),
  "utf8",
).split(/\r?\n/);

const captureRuntimeErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

const sourceLine = (page: Page, contents: string) =>
  page.locator(".monaco-editor .view-line").filter({ hasText: contents });

const revealSourceLine = async (page: Page, contents: string) => {
  const lineNumber = generateSourceLines.findIndex((line) => line.includes(contents)) + 1;
  expect(lineNumber).toBeGreaterThan(0);
  const editor = page.getByRole("textbox", { name: "Editor content" });
  const line = sourceLine(page, contents);
  await editor.press("Control+Home");
  for (let currentLine = 1; currentLine < lineNumber; currentLine += 1) {
    await editor.press("ArrowDown");
  }
  await expect(line).toHaveCount(1);
  return line;
};

const inspectSchematicGeometry = async (page: Page) =>
  page.locator(".schematic-viewport").evaluate((element) => {
    const svg = element as SVGSVGElement;
    const problems: string[] = [];
    const finite = (...values: number[]) => values.every(Number.isFinite);
    const parseNumber = (value: string | undefined) =>
      value === undefined ? Number.NaN : Number.parseFloat(value);
    const nodes = Array.from(
      svg.querySelectorAll<SVGAElement>(".node-interaction:not(.diff-filtered)"),
    ).map((node) => {
      const bounds = {
        x: parseNumber(node.dataset.layoutX),
        y: parseNumber(node.dataset.layoutY),
        width: parseNumber(node.dataset.layoutWidth),
        height: parseNumber(node.dataset.layoutHeight),
      };
      const id = node.dataset.entityId ?? "<missing node id>";
      if (
        !finite(bounds.x, bounds.y, bounds.width, bounds.height) ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        problems.push(`${id}: invalid node bounds`);
      }
      return {
        id,
        bounds,
        changed:
          node.classList.contains("diff-added") ||
          node.classList.contains("diff-removed") ||
          node.classList.contains("diff-modified"),
      };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const viewBox = svg.viewBox.baseVal;
    for (const node of nodes) {
      const { x, y, width, height } = node.bounds;
      if (x < -0.5 || y < -0.5 || x + width > viewBox.width + 0.5 || y + height > viewBox.height + 0.5) {
        problems.push(`${node.id}: node falls outside the layout bounds`);
      }
    }
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex];
        const overlapWidth =
          Math.min(left.bounds.x + left.bounds.width, right.bounds.x + right.bounds.width) -
          Math.max(left.bounds.x, right.bounds.x);
        const overlapHeight =
          Math.min(left.bounds.y + left.bounds.height, right.bounds.y + right.bounds.height) -
          Math.max(left.bounds.y, right.bounds.y);
        if (overlapWidth > 0.5 && overlapHeight > 0.5) {
          problems.push(`${left.id} overlaps ${right.id}`);
        }
      }
    }
    const distanceToBounds = (
      point: DOMPoint,
      bounds: { x: number; y: number; width: number; height: number },
    ) => {
      const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
      const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
      return Math.hypot(dx, dy);
    };
    const connectedNodeIds = new Set<string>();
    const edges = Array.from(
      svg.querySelectorAll<SVGAElement>(".schematic-edge:not(.diff-filtered)"),
    );
    for (const edge of edges) {
      const id = edge.dataset.entityId ?? "<missing edge id>";
      const sourceId = edge.dataset.sourceNode;
      const targetId = edge.dataset.targetNode;
      const source = sourceId ? nodeById.get(sourceId) : undefined;
      const target = targetId ? nodeById.get(targetId) : undefined;
      const path = edge.querySelector<SVGPathElement>(".edge-line");
      if (!sourceId || !targetId || !source || !target || !path) {
        problems.push(`${id}: missing rendered endpoint identity or path`);
        continue;
      }
      const length = path.getTotalLength();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(length);
      if (!finite(length, start.x, start.y, end.x, end.y) || length <= 0) {
        problems.push(`${id}: invalid routed path geometry`);
        continue;
      }
      connectedNodeIds.add(sourceId);
      connectedNodeIds.add(targetId);
      // Removed and added lanes are shifted by 2.5 layout units, so keep this
      // endpoint tolerance larger than the decoration without pinning a route.
      if (distanceToBounds(start, source.bounds) > 8) {
        problems.push(`${id}: route does not start at ${sourceId}`);
      }
      if (distanceToBounds(end, target.bounds) > 8) {
        problems.push(`${id}: route does not end at ${targetId}`);
      }
    }
    const isolatedNodes = nodes.filter((node) => !connectedNodeIds.has(node.id));
    const disconnectedRect = svg.querySelector<SVGRectElement>(
      ".disconnected-comparison-region rect",
    );
    if (isolatedNodes.length > 0 && !disconnectedRect) {
      problems.push("isolated nodes are not labeled as having no visible connections");
    }
    if (disconnectedRect) {
      const region = {
        x: disconnectedRect.x.baseVal.value,
        y: disconnectedRect.y.baseVal.value,
        width: disconnectedRect.width.baseVal.value,
        height: disconnectedRect.height.baseVal.value,
      };
      for (const node of isolatedNodes) {
        const { x, y, width, height } = node.bounds;
        if (
          x < region.x - 0.5 ||
          y < region.y - 0.5 ||
          x + width > region.x + region.width + 0.5 ||
          y + height > region.y + region.height + 0.5
        ) {
          problems.push(`${node.id}: isolated node falls outside the disconnected region`);
        }
      }
    }
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      connectedChangedNodeCount: nodes.filter(
        (node) => node.changed && connectedNodeIds.has(node.id),
      ).length,
      isolatedNodeCount: isolatedNodes.length,
      problems,
    };
  });

const openFixture = async (page: Page) => {
  await page.goto("/");
  await page.getByLabel("Open a .nettle bundle locally").setInputFiles(fixture);
  await expect(page.locator(".mode-badge.local")).toContainText("LOCAL");
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
  await expect(
    page.getByRole("heading", { name: "Open or share an elaborated design" }),
  ).toBeVisible();
  await expect(page.getByText(/This file stays in your browser/)).toBeVisible();
  await page.getByLabel("Open a .nettle bundle locally").setInputFiles(fixture);

  await expect(page.locator(".mode-badge.local")).toContainText("LOCAL");
  await expect(page.locator(".source-status")).toContainText("rtl/top.sv");
  await expect(page.locator(".monaco-editor")).toContainText("module top");
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);
  await expect(page.locator(".top-level-boundary")).toHaveCount(1);
  await expect(page.locator(".tree-row").filter({ hasText: "top.sv" })).toHaveCount(1);
  expect(apiRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

for (const generateCase of [
  {
    name: "XOR generate branch",
    fixture: generateXorFixture,
    activeStatement: "assign y[i] = a[i] ^ b[i];",
    inactiveStatement: "assign y[i] = a[i] | b[i];",
    selectedOperator: "Exclusive or",
  },
  {
    name: "OR generate branch",
    fixture: generateOrFixture,
    activeStatement: "assign y[i] = a[i] | b[i];",
    inactiveStatement: "assign y[i] = a[i] ^ b[i];",
    selectedOperator: "Or",
  },
] as const) {
  test(`renders and cross-probes the active ${generateCase.name}`, async ({ page }) => {
    test.skip(!generateCase.fixture, "real generate fixtures were not supplied");
    const runtimeErrors = captureRuntimeErrors(page);

    await page.goto("/");
    await page
      .getByLabel("Open a .nettle bundle locally")
      .setInputFiles(generateCase.fixture ?? "");
    await expect(page.getByText("Bundle ready")).toBeVisible();
    await expect(page.locator(".source-status")).toContainText("rtl/top.sv");

    for (const activeStatement of [generateCase.activeStatement]) {
      const activeLine = await revealSourceLine(page, activeStatement);
      await expect(activeLine.locator(".source-inactive-generate-inline")).toHaveCount(0);
    }
    for (const inactiveStatement of [
      generateCase.inactiveStatement,
      "assign optional_value = a[0];",
      "assign empty_value = a[j];",
    ]) {
      const inactiveLine = await revealSourceLine(page, inactiveStatement);
      await expect(inactiveLine.locator(".source-inactive-generate-inline")).not.toHaveCount(0);
    }

    const activeCaseLine = await revealSourceLine(page, "assign case_one_value = a[0];");
    await expect(activeCaseLine.locator(".source-inactive-generate-inline")).toHaveCount(0);
    for (const inactiveStatement of [
      "assign case_zero_value = a[0];",
      "assign case_default_value = b[0];",
    ]) {
      const inactiveCaseLine = await revealSourceLine(page, inactiveStatement);
      await expect(inactiveCaseLine.locator(".source-inactive-generate-inline")).not.toHaveCount(0);
    }

    const inactiveLine = await revealSourceLine(page, generateCase.inactiveStatement);
    const inactiveDecoration = inactiveLine.locator(".source-inactive-generate-inline");
    await expect(inactiveDecoration.first()).toHaveCSS("opacity", "0.42");
    await expect(inactiveDecoration.first()).toHaveCSS("filter", "grayscale(1)");

    const generateHeader = await revealSourceLine(page, "if (USE_XOR) begin : g_xor");
    await generateHeader.getByText("if", { exact: true }).click();
    const selected = page.locator(".node-interaction.selected");
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute(
      "aria-label",
      new RegExp(`Select operator ${generateCase.selectedOperator}`),
    );
    const sentinel = page.getByRole("link", { name: "Select input a", exact: true });
    await sentinel.click();
    const sentinelId = await sentinel.getAttribute("data-entity-id");
    expect(sentinelId).toBeTruthy();

    await inactiveLine.click();
    await expect(page.locator(".node-interaction.selected")).toHaveAttribute(
      "data-entity-id",
      sentinelId ?? "",
    );
    expect(runtimeErrors).toEqual([]);
  });
}

test("scopes generate activity to opposite parameterized child instances", async ({ page }) => {
  test.skip(!generateXorFixture, "real generate fixtures were not supplied");
  const runtimeErrors = captureRuntimeErrors(page);

  await page.goto("/");
  await page
    .getByLabel("Open a .nettle bundle locally")
    .setInputFiles(generateXorFixture ?? "");
  await expect(page.getByText("Bundle ready")).toBeVisible();

  const expectActivity = async (activeStatement: string, inactiveStatement: string) => {
    const activeLine = await revealSourceLine(page, activeStatement);
    await expect(activeLine.locator(".source-inactive-generate-inline")).toHaveCount(0);
    const inactiveLine = await revealSourceLine(page, inactiveStatement);
    await expect(
      inactiveLine.locator(".source-inactive-generate-inline"),
    ).not.toHaveCount(0);
  };

  await page.getByRole("link", { name: "Select module u_child_xor", exact: true }).dblclick();
  await expect(page.getByRole("button", { name: "Up one hierarchy level" })).toBeEnabled();
  await expectActivity("assign y = a ^ b;", "assign y = a | b;");

  await page.getByRole("button", { name: "Up one hierarchy level" }).click();
  await page.getByRole("link", { name: "Select module u_child_or", exact: true }).dblclick();
  await expectActivity("assign y = a | b;", "assign y = a ^ b;");
  expect(runtimeErrors).toEqual([]);
});

test("renders an inferred vector shift register as distinct pipeline stages", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.goto("/");
  await page.getByLabel("Open a .nettle bundle locally").setInputFiles(shiftRegisterFixture);

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
  await expect(page.locator(".mode-badge.local")).toContainText("LOCAL");
  await expect(page.getByRole("button", { name: "Open bundle" })).toContainText("startup.nettle");
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(1);
  expect(runtimeErrors).toEqual([]);
});

test("automatically opens a comparison supplied by the viewer host", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.route("**/startup-comparison.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        reference: {
          name: "hosted-reference.nettle",
          route: "/startup-reference.nettle",
        },
        candidate: {
          name: "hosted-candidate.nettle",
          route: "/startup-candidate.nettle",
        },
        matching: "aggressive",
      }),
    }),
  );
  await page.route("**/startup-reference.nettle", (route) =>
    route.fulfill({
      path: comparisonReferenceFixture,
      contentType: "application/octet-stream",
      headers: { "cache-control": "no-store" },
    }),
  );
  await page.route("**/startup-candidate.nettle", (route) =>
    route.fulfill({
      path: comparisonCandidateFixture,
      contentType: "application/octet-stream",
      headers: { "cache-control": "no-store" },
    }),
  );

  await page.goto("/");

  await expect(page.locator(".mode-badge.diff").getByText("DIFF", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open bundle" })).toContainText(
    "hosted-reference.nettle → hosted-candidate.nettle",
  );
  await expect(page.getByLabel("Schematic matching policy")).toHaveValue("aggressive");
  await expect(page.locator(".node-interaction.diff-heuristic")).not.toHaveCount(0);
  await expect(page.getByRole("region", { name: "Read-only source diff" })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("compares two bundles with source and schematic diff controls", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Compare two bundles" }).click();
  const dialog = page.getByRole("dialog", { name: "Compare Nettle bundles" });
  await dialog.getByLabel("Choose reference .nettle bundle file").setInputFiles(
    comparisonReferenceFixture,
  );
  await dialog.getByLabel("Choose candidate .nettle bundle file").setInputFiles(
    comparisonCandidateFixture,
  );
  await dialog.getByRole("button", { name: "Compare bundles", exact: true }).click();

  await expect(page.locator(".mode-badge.diff").getByText("DIFF", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Schematic matching policy")).toHaveValue("conservative");
  await expect(page.getByRole("region", { name: "Read-only source diff" })).toBeVisible();
  await expect(page.locator(".node-interaction.diff-modified")).not.toHaveCount(0);
  await expect(page.locator(".diff-count.modified")).not.toHaveText("±0");
  await expect(page.locator(".node-interaction.diff-modified .node-shape").first()).toHaveCSS(
    "stroke",
    "rgb(154, 103, 0)",
  );
  await expect(
    page.locator(".top-level-layer.diff-modified .top-level-boundary"),
  ).toHaveCSS("fill", "rgba(255, 244, 184, 0.12)");
  await expect(page.getByTitle("Unchanged")).not.toHaveCount(0);
  await expect(page.getByTitle("Missing from candidate")).not.toHaveCount(0);
  await expect(page.getByTitle("Added in candidate")).not.toHaveCount(0);

  const viewMenu = page.getByRole("button", { name: /Schematic comparison view:/ });
  await expect(viewMenu).toContainText("Diff overlay");
  await expect(page.getByRole("button", { name: "Changes", exact: true })).toHaveCount(0);
  await viewMenu.click();
  await page.getByRole("radio", { name: "Candidate snapshot" }).click();
  await expect(viewMenu).toContainText("Candidate snapshot");
  await expect(page.locator(".node-interaction.diff-modified")).toHaveCount(0);
  await expect(page.locator(".node-interaction.diff-filtered")).not.toHaveCount(0);
  await expect(page.getByRole("link", { name: /Select module u_new/ })).toHaveClass(
    /diff-unchanged/,
  );
  await viewMenu.click();
  await page.getByRole("radio", { name: "Reference snapshot" }).click();
  await expect(viewMenu).toContainText("Reference snapshot");
  await expect(page.locator(".node-interaction.diff-filtered")).not.toHaveCount(0);
  await expect(page.getByRole("link", { name: /Select module u_legacy/ })).toHaveClass(
    /diff-unchanged/,
  );
  await viewMenu.click();
  await page.getByRole("radio", { name: "Diff overlay" }).click();
  await expect(viewMenu).toContainText("Diff overlay");
  await expect(page.locator(".node-interaction.diff-modified")).not.toHaveCount(0);

  await page.getByRole("link", { name: "Select operator Add, Unchanged" }).click();
  await expect(page.locator(".node-shape.selected")).toHaveCount(1);
  await page.getByRole("link", { name: /Select top-level module top, Modified/ }).click();
  await expect(page.locator(".top-level-module.selected")).toHaveCount(1);
  await expect(page.locator(".node-shape.selected")).toHaveCount(0);

  await page.getByTitle("rtl/z_source_only.sv").click();
  await expect(page.getByText("1 source-only hunk", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Hierarchy" }).click();
  await page.getByRole("button", { name: "u_new (new_child)" }).click();
  await expect(
    page.getByRole("link", { name: "Select output one-sided-data-o, Added in candidate" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Source" }).click();
  await page.getByTitle("rtl/top.sv").click();
  await page
    .getByRole("link", { name: "Select output one-sided-data-o, Added in candidate" })
    .click();
  await expect(
    page.getByRole("button", { name: "new_child.sv Added in candidate", exact: true }),
  ).toHaveClass(/selected/);
  await expect(page.getByRole("region", { name: "Read-only source diff" })).toContainText(
    "module new_child",
  );
  await page.getByRole("button", { name: "Jump to top module" }).click();

  const legacyChild = page.getByRole("link", { name: /Select module u_legacy/ });
  await legacyChild.dblclick();
  await expect(page.locator(".node-interaction.diff-removed")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Up one hierarchy level" }).click();
  await expect(page.getByRole("link", { name: /Select module u_legacy/ })).toBeVisible();
  await page.getByRole("link", { name: /Select module u_legacy/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Flatten selected instance" }).click();
  await expect(page.locator(".group-layer .diff-removed .transparent-group")).toHaveCount(1);
  await page.getByRole("button", { name: "Restore instance" }).click();

  await page.getByRole("link", { name: /Select module u_child/ }).dblclick();
  await expect(page.getByRole("button", { name: "Up one hierarchy level" })).toBeEnabled();
  await expect(page.locator(".schematic-node.kind-module")).toHaveCount(0);
  await page.getByRole("button", { name: "Up one hierarchy level" }).click();
  await expect(page.getByRole("link", { name: /Select module u_child/ })).toBeVisible();
  await page.getByRole("link", { name: /Select module u_child/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Flatten selected instance" }).click();
  await expect(page.locator(".transparent-group")).toHaveCount(1);
  await page.getByRole("button", { name: "Restore instance" }).click();
  await expect(page.getByRole("link", { name: /Select module u_child/ })).toBeVisible();

  await page.getByLabel("Flatten instance depth").selectOption("1");
  await expect(page.locator(".transparent-group")).toHaveCount(3);
  await expect(page.locator(".group-layer .diff-removed .transparent-group")).toHaveCount(1);
  await expect(page.locator(".group-layer .diff-added .transparent-group")).toHaveCount(1);
  await page.getByLabel("Schematic matching policy").selectOption("aggressive");
  await expect(page.locator(".node-interaction.diff-heuristic")).not.toHaveCount(0);
  await page.getByLabel("Schematic matching policy").selectOption("conservative");
  await expect(page.locator(".transparent-group")).toHaveCount(3);
  await page.getByLabel("Flatten instance depth").selectOption("0");
  await expect(page.getByRole("link", { name: /Select module u_child/ })).toBeVisible();

  await page.getByLabel("Schematic matching policy").selectOption("aggressive");
  await expect(page.getByLabel("Schematic matching policy")).toHaveValue("aggressive");
  await expect(page.locator(".node-interaction.diff-heuristic")).not.toHaveCount(0);
  await page.locator(".node-interaction.diff-heuristic").first().click();
  await page.getByLabel("Schematic matching policy").selectOption("conservative");
  await expect(page.getByLabel("Schematic matching policy")).toHaveValue("conservative");
  await expect(page.locator(".node-shape.selected")).toHaveCount(1);
  await expect(page.locator(".node-interaction.diff-heuristic")).toHaveCount(0);
  await page.getByLabel("Schematic matching policy").selectOption("aggressive");
  await expect(page.locator(".node-interaction.diff-heuristic")).not.toHaveCount(0);
  await page.getByRole("button", { name: /Schematic comparison view:/ }).click();
  await page.getByRole("radio", { name: "Changes only" }).click();
  await expect(page.getByRole("button", { name: /Schematic comparison view:/ })).toContainText(
    "Changes only",
  );
  await expect(page.locator(".node-interaction.diff-unchanged.diff-filtered")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Next schematic change" }).click();
  await expect(page.locator(".node-shape.selected, .schematic-edge.active")).not.toHaveCount(0);

  const nodeCount = await page.locator(".node-interaction").count();
  await page.getByRole("button", { name: "Compare Nettle bundles" }).click();
  const replacement = page.getByRole("dialog", { name: "Compare Nettle bundles" });
  await replacement.getByLabel("Choose candidate .nettle bundle file").setInputFiles({
    name: "corrupt-candidate.nettle",
    mimeType: "application/zip",
    buffer: Buffer.from("not a bundle"),
  });
  await replacement.getByRole("button", { name: "Compare bundles", exact: true }).click();
  await expect(replacement.getByRole("alert")).toBeVisible();
  await replacement.getByRole("button", { name: "Close compare bundles dialog" }).click();
  await expect(page.locator(".mode-badge.diff")).toBeVisible();
  await expect(page.locator(".node-interaction")).toHaveCount(nodeCount);
  expect(runtimeErrors).toEqual([]);
});

test("lays out a real elaborated schematic diff with coherent geometry", async ({ page }) => {
  test.skip(
    !realComparisonReferenceFixture || !realComparisonCandidateFixture,
    "real comparison bundles were not supplied by the integration runner",
  );
  const runtimeErrors = captureRuntimeErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Compare two bundles" }).click();
  const dialog = page.getByRole("dialog", { name: "Compare Nettle bundles" });
  await dialog
    .getByLabel("Choose reference .nettle bundle file")
    .setInputFiles(realComparisonReferenceFixture ?? "");
  await dialog
    .getByLabel("Choose candidate .nettle bundle file")
    .setInputFiles(realComparisonCandidateFixture ?? "");
  await dialog.getByRole("button", { name: "Compare bundles", exact: true }).click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".mode-badge.diff").getByText("DIFF", { exact: true })).toBeVisible();
  await expect(page.locator(".node-interaction")).not.toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".schematic-edge")).not.toHaveCount(0, { timeout: 30_000 });
  const conservativeGeometry = await inspectSchematicGeometry(page);
  expect(conservativeGeometry.nodeCount).toBeGreaterThan(10);
  expect(conservativeGeometry.edgeCount).toBeGreaterThan(5);
  expect(conservativeGeometry.connectedChangedNodeCount).toBeGreaterThan(0);
  expect(conservativeGeometry.problems).toEqual([]);

  await page.getByLabel("Schematic matching policy").selectOption("aggressive");
  await expect(page.locator(".node-interaction.diff-heuristic")).not.toHaveCount(0);
  const aggressiveGeometry = await inspectSchematicGeometry(page);
  expect(aggressiveGeometry.nodeCount).toBeGreaterThan(10);
  expect(aggressiveGeometry.edgeCount).toBeGreaterThan(5);
  expect(aggressiveGeometry.connectedChangedNodeCount).toBeGreaterThan(0);
  expect(aggressiveGeometry.problems).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("renders compiled RTL interface, instance, connectivity, and structure mutations", async ({
  page,
}) => {
  test.skip(
    !structuralReferenceFixture || !structuralCandidateFixture,
    "structural comparison bundles were not supplied by the integration runner",
  );
  const runtimeErrors = captureRuntimeErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Compare two bundles" }).click();
  const dialog = page.getByRole("dialog", { name: "Compare Nettle bundles" });
  await dialog
    .getByLabel("Choose reference .nettle bundle file")
    .setInputFiles(structuralReferenceFixture ?? "");
  await dialog
    .getByLabel("Choose candidate .nettle bundle file")
    .setInputFiles(structuralCandidateFixture ?? "");
  await dialog.getByRole("button", { name: "Compare bundles", exact: true }).click();

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Select input enable_i, Added in candidate" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Select output legacy_o, Missing from candidate" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Select output status_o, Added in candidate" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Select module u_removed, Missing from candidate" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Select module u_added, Added in candidate" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Select module u_keep, Unchanged" })).toBeVisible();
  await expect(
    page.locator(".node-interaction.diff-removed").filter({
      has: page.locator(".schematic-node.kind-operator"),
    }),
  ).not.toHaveCount(0);
  await expect(
    page.locator(".node-interaction.diff-added").filter({
      has: page.locator(".schematic-node.kind-operator"),
    }),
  ).not.toHaveCount(0);
  await expect(page.locator(".schematic-edge.diff-removed")).not.toHaveCount(0);
  await expect(page.locator(".schematic-edge.diff-added")).not.toHaveCount(0);

  const conservativeGeometry = await inspectSchematicGeometry(page);
  expect(conservativeGeometry.connectedChangedNodeCount).toBeGreaterThan(0);
  expect(conservativeGeometry.problems).toEqual([]);

  await page.getByLabel("Schematic matching policy").selectOption("aggressive");
  await expect(page.locator(".node-interaction.diff-heuristic")).not.toHaveCount(0);
  const aggressiveGeometry = await inspectSchematicGeometry(page);
  expect(aggressiveGeometry.connectedChangedNodeCount).toBeGreaterThan(0);
  expect(aggressiveGeometry.problems).toEqual([]);
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

  await page.setViewportSize({ width: 480, height: 800 });
  await expect(page.locator(".file-tree")).toBeHidden();
  await expect(divider).toBeHidden();
  const narrowSourceBox = await sourcePane.boundingBox();
  const narrowSchematicBox = await page.locator(".schematic-panel").boundingBox();
  expect(narrowSourceBox).not.toBeNull();
  expect(narrowSchematicBox).not.toBeNull();
  if (narrowSourceBox && narrowSchematicBox) {
    expect(Math.abs(narrowSourceBox.x - narrowSchematicBox.x)).toBeLessThan(2);
    expect(narrowSchematicBox.y).toBeGreaterThanOrEqual(
      narrowSourceBox.y + narrowSourceBox.height - 2,
    );
  }
  const narrowControls = page.locator(
    ".schematic-toolbar button:visible, .schematic-toolbar select:visible",
  );
  for (let index = 0; index < (await narrowControls.count()); index += 1) {
    const controlBox = await narrowControls.nth(index).boundingBox();
    expect(controlBox?.x).toBeGreaterThanOrEqual(narrowSchematicBox?.x ?? 0);
    expect((controlBox?.x ?? 0) + (controlBox?.width ?? 0)).toBeLessThanOrEqual(
      (narrowSchematicBox?.x ?? 0) + (narrowSchematicBox?.width ?? 480),
    );
  }
  await page.getByRole("button", { name: "Toggle inspector" }).click();
  const narrowInspector = await page.getByRole("complementary", { name: "Selection inspector" }).boundingBox();
  expect(narrowInspector?.width).toBeLessThanOrEqual(480);
  expect(narrowInspector?.x).toBeGreaterThanOrEqual(0);
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
