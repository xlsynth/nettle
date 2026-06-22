// SPDX-License-Identifier: Apache-2.0

import { expect, type Page, test } from "@playwright/test";
import { makeLayeredBenchmarkSlice } from "../src/graph/benchmark-fixture";

test.describe.configure({ mode: "serial" });

interface BrowserMeasurements {
  nodeCount: number;
  edgeCount: number;
  layoutMs: number;
  graphToDomMs: number;
  coldPageMs: number;
  selectionMs: number;
  zoomMs: number;
  heapMiB?: number;
}

async function mockBenchmarkApi(page: Page, nodeCount: number) {
  const slice = makeLayeredBenchmarkSlice(nodeCount);
  const graph = {
    ...slice,
    files: [{ id: "benchmark-source", path: "rtl/benchmark.sv" }],
  };
  let graphFulfilledAt = 0;

  await page.route(/\/api\/v1\//, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/v1/project") {
      return route.fulfill({
        json: {
          schemaVersion: 1,
          status: "ready",
          snapshotId: slice.snapshotId,
          projectRoot: "/benchmark",
          filelist: "/benchmark/project.f",
          top: slice.module.name,
          tops: [slice.module.name],
          modules: [
            {
              id: slice.module.id,
              name: slice.module.name,
              definitionName: slice.module.definitionName,
              instancePath: slice.module.instancePath,
              nodeCount: slice.nodes.length,
              edgeCount: slice.edges.length,
            },
          ],
          diagnostics: [],
          tools: [{ name: "slang", path: "/bin/slang", version: "slang 11.0.0" }],
        },
      });
    }
    if (pathname === "/api/v1/tree") {
      return route.fulfill({
        json: {
          root: "/benchmark",
          entries: [
            {
              name: "rtl",
              path: "rtl",
              kind: "directory",
              children: [
                {
                  name: "benchmark.sv",
                  path: "rtl/benchmark.sv",
                  kind: "file",
                  fileId: "benchmark-source",
                },
              ],
            },
          ],
        },
      });
    }
    if (pathname === "/api/v1/source/benchmark-source") {
      return route.fulfill({
        json: {
          fileId: "benchmark-source",
          path: "rtl/benchmark.sv",
          version: "benchmark-v1",
          content: "module benchmark; // synthetic layout and mount benchmark\nendmodule\n",
        },
      });
    }
    if (pathname === "/api/v1/graph/slice") {
      graphFulfilledAt = performance.now();
      return route.fulfill({ json: graph });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });

  return {
    slice,
    graphFulfilledAt: () => graphFulfilledAt,
  };
}

for (const nodeCount of [500, 2_000, 5_000]) {
  test(`mounts and interacts with ${nodeCount.toLocaleString()} visible nodes`, async ({ page }) => {
    test.setTimeout(120_000);
    const fixture = await mockBenchmarkApi(page, nodeCount);
    const navigationStartedAt = performance.now();
    await page.goto("/");
    await expect(page.locator(".schematic-node")).toHaveCount(nodeCount, { timeout: 90_000 });
    await expect(page.locator(".schematic-edge")).toHaveCount(fixture.slice.edges.length);
    const coldPageMs = performance.now() - navigationStartedAt;
    const graphToDomMs = performance.now() - fixture.graphFulfilledAt();

    const status = await page.locator(".canvas-status").innerText();
    const layoutMs = Number(status.match(/layout\s+([\d,]+)\s+ms/)?.[1].replaceAll(",", ""));
    expect(layoutMs).toBeGreaterThan(0);

    const selection = await page.locator(".node-interaction").first().evaluate(async (element) => {
      const startedAt = performance.now();
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return {
        elapsedMs: performance.now() - startedAt,
        selected: Boolean(element.querySelector(".node-shape.selected")),
      };
    });
    expect(selection.selected).toBe(true);

    const transientZoom = await page.locator(".schematic-svg").evaluate(async (element) => {
      const startedAt = performance.now();
      element.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const elapsedMs = performance.now() - startedAt;
      const nodeRect = document.querySelector(".node-interaction")?.getBoundingClientRect();
      return {
        elapsedMs,
        nodeRect: nodeRect
          ? { x: nodeRect.x, y: nodeRect.y, width: nodeRect.width, height: nodeRect.height }
          : null,
        readout: document.querySelector(".zoom-readout")?.textContent,
        stageTransform: (document.querySelector(".schematic-stage") as HTMLElement | null)?.style
          .transform,
      };
    });
    expect(transientZoom.nodeRect).not.toBeNull();
    expect(transientZoom.readout).not.toBe("100%");
    expect(transientZoom.stageTransform).not.toContain("scale(1)");

    await page.waitForTimeout(250);
    const settledZoom = await page.locator(".schematic-stage").evaluate((stage) => {
      const nodeRect = document.querySelector(".node-interaction")?.getBoundingClientRect();
      return {
        nodeRect: nodeRect
          ? { x: nodeRect.x, y: nodeRect.y, width: nodeRect.width, height: nodeRect.height }
          : null,
        stageTransform: (stage as HTMLElement).style.transform,
      };
    });
    expect(settledZoom.stageTransform).toBe("none");
    expect(settledZoom.nodeRect).not.toBeNull();
    expect(Math.abs((settledZoom.nodeRect?.x ?? 0) - (transientZoom.nodeRect?.x ?? 0))).toBeLessThan(
      1,
    );
    expect(Math.abs((settledZoom.nodeRect?.y ?? 0) - (transientZoom.nodeRect?.y ?? 0))).toBeLessThan(
      1,
    );

    const heapBytes = await page.evaluate(
      () =>
        (
          performance as Performance & {
            memory?: { usedJSHeapSize: number };
          }
        ).memory?.usedJSHeapSize,
    );
    const measurements: BrowserMeasurements = {
      nodeCount,
      edgeCount: fixture.slice.edges.length,
      layoutMs,
      graphToDomMs,
      coldPageMs,
      selectionMs: selection.elapsedMs,
      zoomMs: transientZoom.elapsedMs,
      heapMiB: heapBytes === undefined ? undefined : heapBytes / 1024 / 1024,
    };
    console.log(`NETTLE_BROWSER_BENCHMARK ${JSON.stringify(measurements)}`);
  });
}
