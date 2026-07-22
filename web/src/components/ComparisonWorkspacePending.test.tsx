// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedWorkspace } from "../api/normalize";
import type { WorkspaceProvider } from "../bundle/provider";
import { compareGraphSlices } from "../comparison";
import type { CompareGraphOptions, ComparisonSlice } from "../comparison/types";
import type { GraphSlice, ProjectSnapshot } from "../model/graph";
import { type ComparisonBundleInput, ComparisonWorkspaceView } from "./ComparisonWorkspaceView";

interface DeferredComparison {
  resolve: (comparison: ComparisonSlice) => void;
  reject: (error: Error) => void;
}

const matcherHarness = vi.hoisted(() => ({
  pending: [] as DeferredComparison[],
  compare: vi.fn(),
}));

vi.mock("../comparison", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../comparison")>();
  matcherHarness.compare.mockImplementation(
    () =>
      new Promise<ComparisonSlice>((resolve, reject) => {
        matcherHarness.pending.push({ resolve, reject });
      }),
  );
  return { ...actual, compareGraphSlicesInWorker: matcherHarness.compare };
});

vi.mock("../graph/SchematicCanvas", () => ({
  SchematicCanvas: ({
    slice,
    busy,
    comparison,
  }: {
    slice: GraphSlice;
    busy?: boolean;
    comparison: {
      policy: "conservative" | "aggressive";
      onPolicyChange: (policy: "conservative" | "aggressive") => void;
    };
  }) => (
    <div data-testid="schematic" data-snapshot={slice.snapshotId} data-busy={String(busy)}>
      <select
        aria-label="Schematic matching policy"
        value={comparison.policy}
        onChange={(event) =>
          comparison.onPolicyChange(event.target.value as "conservative" | "aggressive")
        }
      >
        <option value="conservative">Conservative</option>
        <option value="aggressive">Aggressive</option>
      </select>
    </div>
  ),
}));

vi.mock("./DiffSourcePane", () => ({
  DiffSourcePane: () => <div data-testid="source-diff" />,
}));

afterEach(() => {
  cleanup();
  matcherHarness.pending = [];
  matcherHarness.compare.mockClear();
});

const graph = (snapshotId: string): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-top`,
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: {},
  },
  nodes: [],
  edges: [],
});

const project = (snapshotId: string): ProjectSnapshot => ({
  name: snapshotId,
  projectRoot: "",
  filelist: "fixture.f",
  yosysJson: "",
  slangAstJson: "",
  bundleStatus: "Bundle ready",
  snapshotId,
  files: [],
  defines: [],
  elaboration: { parameters: [], defines: [], undefines: [] },
  effectiveElaboration: { parameters: [], defines: [], undefines: [] },
  tools: [],
});

const bundle = (snapshotId: string): ComparisonBundleInput => {
  const slice = graph(snapshotId);
  const workspace: LoadedWorkspace = { project: project(snapshotId), slice };
  const provider = {
    fileName: `${snapshotId}.nettle`,
    getProject: vi.fn(),
    getTree: vi.fn(),
    getSourceInventory: vi.fn(),
    getSource: vi.fn(),
    getGraphSlice: vi.fn(),
  } satisfies WorkspaceProvider & { fileName: string };
  return {
    provider,
    workspace,
    inventory: [],
    modules: [{ id: slice.module.id, name: "top", definitionName: "top" }],
  };
};

const completePendingComparison = (index: number) => {
  const [reference, candidate, options] = matcherHarness.compare.mock.calls[index] as [
    GraphSlice,
    GraphSlice,
    CompareGraphOptions,
  ];
  matcherHarness.pending[index].resolve(compareGraphSlices(reference, candidate, options));
};

describe("comparison matching transitions", () => {
  it("never presents stale correspondence under the newly selected policy", async () => {
    render(
      <ComparisonWorkspaceView
        reference={bundle("reference")}
        candidate={bundle("candidate")}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    await waitFor(() => expect(matcherHarness.compare).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("schematic").getAttribute("data-busy")).toBe("true");
    completePendingComparison(0);
    await waitFor(() =>
      expect(screen.getByTestId("schematic").getAttribute("data-busy")).toBe("false"),
    );
    const completedSnapshot = screen.getByTestId("schematic").getAttribute("data-snapshot");

    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "aggressive" },
    });
    await waitFor(() => expect(matcherHarness.compare).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("schematic").getAttribute("data-snapshot")).not.toBe(
      completedSnapshot,
    );
    expect(screen.getByTestId("schematic").getAttribute("data-busy")).toBe("true");

    matcherHarness.pending[1].reject(new Error("matcher failed"));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByTestId("schematic").getAttribute("data-snapshot")).not.toBe(
      completedSnapshot,
    );
    expect(screen.getByTestId("schematic").getAttribute("data-busy")).toBe("true");
  });
});
