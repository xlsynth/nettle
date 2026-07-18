// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApiGraphSlice,
  GraphSliceRequest,
  SourceInventoryEntry,
  SourceResponse,
} from "../api/contracts";
import type { LoadedWorkspace } from "../api/normalize";
import type { WorkspaceProvider } from "../bundle/provider";
import type { ClassifiedSourceDiffHunk } from "../comparison";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import { TOP_MODULE_ID } from "../graph/constants";
import type { GraphNode, GraphSlice, ProjectSnapshot } from "../model/graph";
import { type ComparisonBundleInput, ComparisonWorkspaceView } from "./ComparisonWorkspaceView";

vi.mock("../graph/SchematicCanvas", () => ({
  SchematicCanvas: ({
    slice,
    comparison,
    busy,
    selectedId,
    onSelect,
    onOpenInstance,
    canGoUp,
    onGoUp,
    onGoTop,
    flattenDepth,
    onFlattenDepthChange,
    onFlattenInstance,
    onRestoreInstance,
    individuallyFlattened,
    onToggleInspector,
  }: {
    slice: GraphSlice;
    comparison: {
      policy: "conservative" | "aggressive";
      onPolicyChange: (policy: "conservative" | "aggressive") => void;
      entities: Record<string, { status: string } | undefined>;
      counts: Record<string, number>;
    };
    busy: boolean;
    selectedId: string;
    onSelect: (id: string) => void;
    onOpenInstance: (id: string) => void;
    canGoUp: boolean;
    onGoUp: () => void;
    onGoTop: () => void;
    flattenDepth: number;
    onFlattenDepthChange: (depth: number) => void;
    onFlattenInstance: (id: string) => void;
    onRestoreInstance: () => void;
    individuallyFlattened: boolean;
    onToggleInspector: () => void;
  }) => (
    <div
      data-testid="schematic"
      data-instance-path={slice.module.instancePath}
      data-top-status={comparison.entities[TOP_MODULE_ID]?.status}
      data-removed-count={comparison.counts.removed}
      data-added-count={comparison.counts.added}
      data-heuristic-count={comparison.counts.heuristic}
      data-busy={String(busy)}
      data-selected-id={selectedId}
      data-module-count={slice.nodes.filter((node) => node.kind === "module").length}
      data-group-count={slice.groups?.length ?? 0}
    >
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
      <button type="button" onClick={() => onSelect(TOP_MODULE_ID)}>
        Select top module
      </button>
      <button type="button" disabled={!canGoUp} onClick={onGoUp}>
        Go up
      </button>
      <button type="button" onClick={onGoTop}>
        Go top
      </button>
      <button type="button" onClick={() => onFlattenDepthChange(1)}>
        Flatten depth 1
      </button>
      <button type="button" onClick={() => onFlattenDepthChange(0)}>
        Flatten depth 0
      </button>
      <output data-testid="flatten-depth">{flattenDepth}</output>
      {slice.nodes.map((node) => (
        <span key={node.id}>
          <button type="button" onClick={() => onSelect(node.id)}>
            Select union {node.label}
          </button>
          {node.kind === "module" ? (
            <button type="button" onClick={() => onOpenInstance(node.id)}>
              Open union {node.label}
            </button>
          ) : null}
        </span>
      ))}
      {slice.nodes
        .filter((node) => node.kind === "module")
        .map((node) => (
          <button
            key={`flatten:${node.id}`}
            type="button"
            onClick={() => onFlattenInstance(node.id)}
          >
            Flatten union {node.label}
          </button>
        ))}
      {individuallyFlattened ? (
        <button type="button" onClick={onRestoreInstance}>
          Restore instance
        </button>
      ) : null}
      <button type="button" onClick={onToggleInspector}>
        Toggle inspector
      </button>
    </div>
  ),
}));

vi.mock("./DiffSourcePane", () => ({
  DiffSourcePane: ({
    reference,
    candidate,
    hunks,
    onShowHierarchy,
  }: {
    reference: { path: string };
    candidate: { path: string };
    hunks?: readonly ClassifiedSourceDiffHunk[];
    onShowHierarchy: () => void;
  }) => (
    <div>
      <output data-testid="selected-source-path">{candidate.path || reference.path}</output>
      <output data-testid="source-hunk-count">{hunks?.length ?? 0}</output>
      <output data-testid="source-only-hunk-count">
        {hunks?.filter((hunk) => hunk.sourceOnly).length ?? 0}
      </output>
      <button type="button" onClick={onShowHierarchy}>
        Hierarchy
      </button>
    </div>
  ),
}));

afterEach(cleanup);

const moduleNode = (id = "u_child", label = "u_child", definitionName = "child"): GraphNode => ({
  id,
  kind: "module",
  label,
  definitionName,
  ports: [],
  origins: [{ file: "rtl/top.sv", startLine: 3, startColumn: 1 }],
});

const operator = (id: string, line: number): GraphNode => ({
  id,
  kind: "operator",
  label: "Add",
  glyph: "+",
  ports: [
    { id: "in", name: "in", direction: "input", role: "data" },
    { id: "out", name: "out", direction: "output", role: "data" },
  ],
  origins: [{ file: "rtl/child.sv", startLine: line, startColumn: 1 }],
});

const graphSlice = (snapshotId: string, child = false): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-${child ? "child" : "top"}`,
    name: child ? "child" : "top",
    instancePath: child ? "child" : "top",
    definitionName: child ? "child" : "top",
    parameters: {},
  },
  nodes: child
    ? snapshotId === "reference"
      ? [operator("reference-left", 2), operator("reference-right", 3)]
      : [operator("candidate-left", 3), operator("candidate-right", 4)]
    : [
        moduleNode(),
        moduleNode(`${snapshotId}-duplicate-a`, "duplicate"),
        moduleNode(`${snapshotId}-duplicate-b`, "duplicate"),
        ...(snapshotId === "reference"
          ? [moduleNode("u-legacy", "u_legacy", "legacy_child")]
          : [moduleNode("u-new", "u_new", "new_child")]),
      ],
  edges: [],
});

const childApiSlice = (snapshotId: string): ApiGraphSlice => {
  const child = graphSlice(snapshotId, true);
  return {
    snapshotId: child.snapshotId,
    module: child.module,
    nodes: child.nodes.map((value) => ({
      id: value.id,
      kind: "operator",
      label: value.label,
      ports: value.ports,
      origins: value.origins?.map((origin) => ({
        ...origin,
        endLine: origin.endLine ?? origin.startLine,
      })),
    })),
    edges: [],
  };
};

const emptyApiSlice = (snapshotId: string, definitionName: string): ApiGraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-${definitionName}`,
    name: definitionName,
    instancePath: definitionName,
    definitionName,
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

const inventory = (snapshotId: string): SourceInventoryEntry[] => [
  {
    id: `${snapshotId}-display`,
    path: "rtl/00-display.sv",
    sha256: `${snapshotId}-display-digest`,
    size: 8,
  },
  {
    id: `${snapshotId}-child`,
    path: "rtl/child.sv",
    sha256: `${snapshotId}-child-digest`,
    size: 32,
  },
];

const sourceResponse = (snapshotId: string, fileId: string): SourceResponse => {
  const child = fileId.endsWith("-child");
  return {
    fileId,
    path: child ? "rtl/child.sv" : "rtl/00-display.sv",
    version: fileId,
    content: child
      ? snapshotId === "reference"
        ? "alpha\nleft\nright\nomega\n"
        : "alpha\ninserted\nleft\nright\nomega\n"
      : `${snapshotId}\n`,
    elaborationRanges: [],
  };
};

const bundle = (snapshotId: string) => {
  const top = graphSlice(snapshotId);
  const workspace: LoadedWorkspace = { project: project(snapshotId), slice: top };
  const getSource = vi.fn(async (fileId: string) => sourceResponse(snapshotId, fileId));
  const provider = {
    fileName: `${snapshotId}.nettle`,
    getProject: vi.fn(),
    getTree: vi.fn(),
    getSourceInventory: vi.fn(),
    getSource,
    getGraphSlice: vi.fn(async ({ moduleName }: { moduleName: string }) =>
      moduleName === "child" ? childApiSlice(snapshotId) : emptyApiSlice(snapshotId, moduleName),
    ),
  } satisfies WorkspaceProvider & { fileName: string };
  const input: ComparisonBundleInput = {
    provider,
    workspace,
    inventory: inventory(snapshotId),
    modules: [
      { id: top.module.id, name: "top", definitionName: "top" },
      { id: `${snapshotId}-child`, name: "child", definitionName: "child" },
    ],
  };
  return { getSource, input };
};

const makeDuplicateInstancesHeuristic = (
  reference: ReturnType<typeof bundle>,
  candidate: ReturnType<typeof bundle>,
) => {
  for (const node of reference.input.workspace.slice.nodes.filter((value) =>
    value.id.includes("duplicate"),
  )) {
    node.origins = [{ file: "rtl/child.sv", startLine: 2, startColumn: 1 }];
  }
  for (const node of candidate.input.workspace.slice.nodes.filter((value) =>
    value.id.includes("duplicate"),
  )) {
    node.origins = [{ file: "rtl/child.sv", startLine: 3, startColumn: 1 }];
  }
};

describe("comparison instance hierarchy", () => {
  it("does not label a top-selected source hunk source-only when a reachable child changes", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    reference.input.inventory[0].sha256 = "display-unchanged";
    candidate.input.inventory[0].sha256 = "display-unchanged";
    const candidateGetGraphSlice = vi.fn(
      async ({ moduleName }: GraphSliceRequest): Promise<ApiGraphSlice> => {
        if (moduleName !== "child") return emptyApiSlice("candidate", moduleName ?? "missing");
        const child = childApiSlice("candidate");
        child.nodes[0].label = "−";
        return child;
      },
    );
    candidate.input.provider.getGraphSlice = candidateGetGraphSlice;

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("selected-source-path").textContent).toBe("rtl/child.sv"),
    );
    await waitFor(() => expect(screen.getByTestId("source-hunk-count").textContent).toBe("1"));
    await waitFor(() =>
      expect(candidateGetGraphSlice).toHaveBeenCalledWith(
        expect.objectContaining({ moduleName: "child" }),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.getByTestId("source-only-hunk-count").textContent).toBe("0");

    const childLoadsBeforePolicyChange = candidateGetGraphSlice.mock.calls.filter(
      ([request]) => request.moduleName === "child",
    ).length;
    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "aggressive" },
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Schematic matching policy") as HTMLSelectElement).value).toBe(
        "aggressive",
      ),
    );
    expect(
      candidateGetGraphSlice.mock.calls.filter(([request]) => request.moduleName === "child"),
    ).toHaveLength(childLoadsBeforePolicyChange);
  });

  it("keeps a formatting-only reachable child edit source-only after line-based IDs shift", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    reference.input.workspace.slice.nodes = reference.input.workspace.slice.nodes.filter(
      ({ id }) => id === "u_child",
    );
    candidate.input.workspace.slice.nodes = candidate.input.workspace.slice.nodes.filter(
      ({ id }) => id === "u_child",
    );

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTitle("rtl/child.sv"));
    await waitFor(() =>
      expect(screen.getByTestId("selected-source-path").textContent).toBe("rtl/child.sv"),
    );
    await waitFor(() => expect(screen.getByTestId("source-hunk-count").textContent).toBe("1"));
    await waitFor(() => expect(screen.getByTestId("source-only-hunk-count").textContent).toBe("1"));
  });

  it("labels a changed source outside the reachable graph hierarchy source-only", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    for (let index = 0; index < reference.input.inventory.length; index += 1) {
      reference.input.inventory[index].sha256 = `unchanged-${index}`;
      candidate.input.inventory[index].sha256 = `unchanged-${index}`;
    }
    reference.input.inventory.push({
      id: "reference-notes",
      path: "rtl/notes.sv",
      sha256: "reference-notes",
      size: 19,
    });
    candidate.input.inventory.push({
      id: "candidate-notes",
      path: "rtl/notes.sv",
      sha256: "candidate-notes",
      size: 19,
    });
    reference.getSource.mockImplementation(async (fileId: string) =>
      fileId === "reference-notes"
        ? {
            fileId,
            path: "rtl/notes.sv",
            version: fileId,
            content: "// old documentation\n",
            elaborationRanges: [],
          }
        : sourceResponse("reference", fileId),
    );
    candidate.getSource.mockImplementation(async (fileId: string) =>
      fileId === "candidate-notes"
        ? {
            fileId,
            path: "rtl/notes.sv",
            version: fileId,
            content: "// new documentation\n",
            elaborationRanges: [],
          }
        : sourceResponse("candidate", fileId),
    );

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("selected-source-path").textContent).toBe("rtl/notes.sv"),
    );
    await waitFor(() => expect(screen.getByTestId("source-hunk-count").textContent).toBe("1"));
    await waitFor(() => expect(screen.getByTestId("source-only-hunk-count").textContent).toBe("1"));
  });

  it("shows unchanged, removed, added, and modified instance statuses", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    const referenceChild = reference.input.workspace.slice.nodes.find(
      (node) => node.id === "u_child",
    );
    const candidateChild = candidate.input.workspace.slice.nodes.find(
      (node) => node.id === "u_child",
    );
    if (!referenceChild || !candidateChild) throw new Error("Missing hierarchy fixture child");
    referenceChild.parameters = { WIDTH: 8 };
    candidateChild.parameters = { WIDTH: 16 };

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    const unchanged = await screen.findByRole("treeitem", { name: "top (top), Unchanged" });
    const modified = await screen.findByRole("treeitem", {
      name: "u_child (child), Modified",
    });
    const removed = await screen.findByRole("treeitem", {
      name: "u_legacy (legacy_child), Missing from candidate",
    });
    const added = await screen.findByRole("treeitem", {
      name: "u_new (new_child), Added in candidate",
    });

    expect(unchanged.querySelector(".hierarchy-diff-badge")?.textContent).toContain("=");
    expect(modified.querySelector(".hierarchy-diff-badge")?.textContent).toContain("M");
    expect(removed.querySelector(".hierarchy-diff-badge")?.textContent).toContain("D");
    expect(added.querySelector(".hierarchy-diff-badge")?.textContent).toContain("A");
    expect(modified.classList.contains("diff-status-modified")).toBe(true);
    expect(removed.classList.contains("diff-status-removed")).toBe(true);
    expect(added.classList.contains("diff-status-added")).toBe(true);
  });

  it("marks an unchanged instance as containing changes when its child logic changed", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    reference.input.workspace.slice.nodes = reference.input.workspace.slice.nodes.filter(
      ({ id }) => id === "u_child",
    );
    candidate.input.workspace.slice.nodes = candidate.input.workspace.slice.nodes.filter(
      ({ id }) => id === "u_child",
    );
    const candidateGetGraphSlice = vi.fn(
      async ({ moduleName }: GraphSliceRequest): Promise<ApiGraphSlice> => {
        if (moduleName !== "child") return emptyApiSlice("candidate", moduleName ?? "missing");
        const child = childApiSlice("candidate");
        child.nodes[0].label = "Subtract";
        return child;
      },
    );
    candidate.input.provider.getGraphSlice = candidateGetGraphSlice;

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    const childRow = await screen.findByRole("treeitem", {
      name: "u_child (child), Unchanged, Contains changes",
    });
    expect(childRow.classList.contains("diff-status-unchanged")).toBe(true);
    expect(childRow.classList.contains("contains-descendant-changes")).toBe(true);
    expect(childRow.querySelector(".hierarchy-diff-badge.unchanged")?.textContent).toContain("=");
    expect(childRow.querySelector(".hierarchy-diff-badge.contains-changes")?.textContent).toContain(
      "C",
    );
    expect(
      childRow.querySelector<HTMLElement>(".hierarchy-diff-badge.contains-changes")?.title,
    ).toBe("Contains changes in top.u_child");
    expect(screen.getByRole("button", { name: "u_child (child)" }).title).toBe("top.u_child");
    expect(candidateGetGraphSlice).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: "child" }),
      expect.any(AbortSignal),
    );
  });

  it("shares one descendant traversal across many top-level instances", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    const instanceCount = 40;
    reference.input.workspace.slice.nodes = Array.from({ length: instanceCount }, (_, index) =>
      moduleNode(`shared-child-${index}`, `u_child_${index}`),
    );
    candidate.input.workspace.slice.nodes = Array.from({ length: instanceCount }, (_, index) =>
      moduleNode(`shared-child-${index}`, `u_child_${index}`),
    );
    for (let index = 0; index < reference.input.inventory.length; index += 1) {
      const digest = `unchanged-${index}`;
      reference.input.inventory[index].sha256 = digest;
      candidate.input.inventory[index].sha256 = digest;
    }
    const referenceGetGraphSlice = vi.mocked(reference.input.provider.getGraphSlice);
    const candidateGetGraphSlice = vi.fn(
      async ({ moduleName }: GraphSliceRequest): Promise<ApiGraphSlice> => {
        if (moduleName !== "child") return emptyApiSlice("candidate", moduleName ?? "missing");
        const child = childApiSlice("candidate");
        child.nodes[0].label = "Subtract";
        return child;
      },
    );
    candidate.input.provider.getGraphSlice = candidateGetGraphSlice;

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("treeitem", {
          name: /u_child_\d+ \(child\), Unchanged, Contains changes/,
        }),
      ).toHaveLength(instanceCount),
    );
    expect(
      referenceGetGraphSlice.mock.calls.filter(([request]) => request.moduleName === "child"),
    ).toHaveLength(1);
    expect(
      candidateGetGraphSlice.mock.calls.filter(([request]) => request.moduleName === "child"),
    ).toHaveLength(1);
  });

  it("marks descendant status unknown when the shared traversal exhausts its module budget", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    reference.input.workspace.slice.nodes = [moduleNode()];
    candidate.input.workspace.slice.nodes = [moduleNode()];
    for (let index = 0; index < reference.input.inventory.length; index += 1) {
      const digest = `unchanged-${index}`;
      reference.input.inventory[index].sha256 = digest;
      candidate.input.inventory[index].sha256 = digest;
    }
    const comparisonLimits = RESOURCE_LIMITS.browser.comparison as unknown as {
      sourceEvidenceModulePairs: number;
    };
    const originalModulePairLimit = comparisonLimits.sourceEvidenceModulePairs;
    comparisonLimits.sourceEvidenceModulePairs = 0;

    try {
      render(
        <ComparisonWorkspaceView
          reference={reference.input}
          candidate={candidate.input}
          initialPolicy="conservative"
          statusDetail="comparison"
          setStatusDetail={vi.fn()}
          onOpenBundle={vi.fn()}
          onCompareBundles={vi.fn()}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
      const childRow = await screen.findByRole("treeitem", {
        name: "u_child (child), Unchanged, Change status unknown",
      });
      expect(childRow.classList.contains("descendant-change-unknown")).toBe(true);
      expect(
        childRow.querySelector(".hierarchy-diff-badge.change-status-unknown")?.textContent,
      ).toContain("?");
      expect(reference.input.provider.getGraphSlice).not.toHaveBeenCalled();
      expect(candidate.input.provider.getGraphSlice).not.toHaveBeenCalled();
    } finally {
      comparisonLimits.sourceEvidenceModulePairs = originalModulePairLimit;
    }
  });

  it("restores the current instance path in status details after hierarchy and flatten resets", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    reference.input.workspace.slice.nodes = reference.input.workspace.slice.nodes.filter(
      ({ id }) => id === "u_child",
    );
    candidate.input.workspace.slice.nodes = candidate.input.workspace.slice.nodes.filter(
      ({ id }) => id === "u_child",
    );
    const setStatusDetail = vi.fn();
    const topStatus = "reference.nettle → candidate.nettle · top";

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={setStatusDetail}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open union u_child" }));
    await waitFor(() =>
      expect(screen.getByTestId("schematic").getAttribute("data-instance-path")).toBe(
        "top.u_child",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Go up" }));
    await waitFor(() => expect(setStatusDetail).toHaveBeenLastCalledWith(topStatus));

    fireEvent.click(await screen.findByRole("button", { name: "Open union u_child" }));
    await waitFor(() =>
      expect(screen.getByTestId("schematic").getAttribute("data-instance-path")).toBe(
        "top.u_child",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Go top" }));
    await waitFor(() => expect(setStatusDetail).toHaveBeenLastCalledWith(topStatus));

    fireEvent.click(await screen.findByRole("button", { name: "Flatten union u_child" }));
    await screen.findByRole("button", { name: "Restore instance" });
    fireEvent.click(screen.getByRole("button", { name: "Restore instance" }));
    await waitFor(() => expect(setStatusDetail).toHaveBeenLastCalledWith(topStatus));

    fireEvent.click(screen.getByRole("button", { name: "Flatten depth 1" }));
    await waitFor(() => expect(screen.getByTestId("flatten-depth").textContent).toBe("1"));
    fireEvent.click(screen.getByRole("button", { name: "Flatten depth 0" }));
    await waitFor(() => expect(setStatusDetail).toHaveBeenLastCalledWith(topStatus));
  });

  it("reveals the candidate origin when selecting a candidate-only schematic object", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    candidate.input.inventory.push({
      id: "candidate-new-child",
      path: "rtl/new_child.sv",
      sha256: "candidate-new-child-digest",
      size: 30,
    });
    candidate.input.workspace.slice.nodes.push({
      id: "candidate-only-output",
      kind: "output",
      label: "candidate-only-output",
      ports: [
        {
          id: "candidate-only-output-port",
          name: "candidate-only-output",
          direction: "input",
          role: "data",
        },
      ],
      origins: [{ file: "rtl/new_child.sv", startLine: 1, startColumn: 1 }],
    });
    candidate.getSource.mockImplementation(async (fileId: string) =>
      fileId === "candidate-new-child"
        ? {
            fileId,
            path: "rtl/new_child.sv",
            version: fileId,
            content: "module new_child(); endmodule\n",
            elaborationRanges: [],
          }
        : sourceResponse("candidate", fileId),
    );

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    expect((await screen.findByTestId("selected-source-path")).textContent).toBe(
      "rtl/00-display.sv",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select union candidate-only-output" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("selected-source-path").textContent).toBe("rtl/new_child.sv"),
    );
  });

  it("does not load a selected source whose inventory size exceeds the diff ceiling", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    reference.input.inventory[0].size = RESOURCE_LIMITS.native.builder.sourceBytes + 1;
    candidate.input.inventory[0].size = RESOURCE_LIMITS.native.builder.sourceBytes + 1;

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("selected-source-path").textContent).toBe("rtl/00-display.sv"),
    );
    expect(reference.getSource).not.toHaveBeenCalledWith("reference-display", expect.anything());
    expect(candidate.getSource).not.toHaveBeenCalledWith("candidate-display", expect.anything());
  });

  it("reveals a candidate-only source after descending into its module", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    candidate.input.inventory.push({
      id: "candidate-new-child",
      path: "rtl/new_child.sv",
      sha256: "candidate-new-child-digest",
      size: 30,
    });
    candidate.input.provider.getGraphSlice = vi.fn(
      async ({ moduleName }): Promise<ApiGraphSlice> => {
        if (moduleName !== "new_child") return emptyApiSlice("candidate", moduleName);
        return {
          snapshotId: "candidate",
          module: {
            id: "candidate-new-child-module",
            name: "new_child",
            instancePath: "new_child",
            definitionName: "new_child",
            parameters: {},
          },
          nodes: [
            {
              id: "candidate-only-child-output",
              kind: "output",
              label: "candidate-only-child-output",
              ports: [
                {
                  id: "candidate-only-child-output-port",
                  name: "candidate-only-child-output",
                  direction: "input",
                  role: "data",
                },
              ],
              origins: [
                {
                  file: "rtl/new_child.sv",
                  startLine: 1,
                  startColumn: 1,
                  endLine: 1,
                },
              ],
            },
          ],
          edges: [],
        };
      },
    );
    candidate.getSource.mockImplementation(async (fileId: string) =>
      fileId === "candidate-new-child"
        ? {
            fileId,
            path: "rtl/new_child.sv",
            version: fileId,
            content: "module new_child(); endmodule\n",
            elaborationRanges: [],
          }
        : sourceResponse("candidate", fileId),
    );

    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    fireEvent.click(await screen.findByRole("button", { name: "u_new (new_child)" }));
    await waitFor(() =>
      expect(screen.getByTestId("schematic").getAttribute("data-instance-path")).toBe("top.u_new"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Select union candidate-only-child-output" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("selected-source-path").textContent).toBe("rtl/new_child.sv"),
    );
  });

  it("loads and caches source mappings while inspecting and previewing a child", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    const instance = await screen.findByRole("button", { name: "u_child (child)" });
    await waitFor(() => {
      expect(reference.getSource).toHaveBeenCalledWith("reference-child", expect.any(AbortSignal));
      expect(candidate.getSource).toHaveBeenCalledWith("candidate-child", expect.any(AbortSignal));
    });
    expect(reference.getSource.mock.calls.filter(([id]) => id === "reference-child")).toHaveLength(
      1,
    );
    expect(candidate.getSource.mock.calls.filter(([id]) => id === "candidate-child")).toHaveLength(
      1,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand u_child" }));
    await screen.findByRole("button", { name: "Collapse u_child" });

    fireEvent.click(instance);
    await waitFor(() =>
      expect(instance.closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true"),
    );
    expect(reference.getSource.mock.calls.filter(([id]) => id === "reference-child")).toHaveLength(
      1,
    );
    expect(candidate.getSource.mock.calls.filter(([id]) => id === "candidate-child")).toHaveLength(
      1,
    );
  });

  it("recomputes ancestor correspondence when policy changes while descended", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    makeDuplicateInstancesHeuristic(reference, candidate);
    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="aggressive"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "duplicate (child)" })).toHaveLength(2),
    );
    expect(screen.getByTestId("schematic").getAttribute("data-heuristic-count")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "u_child (child)" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "u_child (child)" })
          .closest('[role="treeitem"]')
          ?.getAttribute("aria-selected"),
      ).toBe("true"),
    );

    fireEvent.change(await screen.findByLabelText("Schematic matching policy"), {
      target: { value: "conservative" },
    });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "duplicate (child)" })).toHaveLength(4),
    );
  });

  it("turns a descended heuristic instance into a one-sided child under conservative matching", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    makeDuplicateInstancesHeuristic(reference, candidate);
    const setStatusDetail = vi.fn();
    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="aggressive"
        statusDetail="comparison"
        setStatusDetail={setStatusDetail}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    const duplicates = await screen.findAllByRole("button", { name: "duplicate (child)" });
    expect(duplicates).toHaveLength(2);
    expect(screen.getByTestId("schematic").getAttribute("data-heuristic-count")).toBe("2");
    fireEvent.click(duplicates[0]);
    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-instance-path")).toBe("top.duplicate");
      expect(schematic.getAttribute("data-top-status")).toBe("unchanged");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });

    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "conservative" },
    });
    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-top-status")).toBe("added");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });
    expect(setStatusDetail).toHaveBeenCalledWith(
      expect.stringContaining("reopened the visible hierarchy on the candidate side"),
    );

    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "aggressive" },
    });
    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-top-status")).toBe("unchanged");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });
  });

  it("re-resolves a selected heuristic flatten target across matching policies", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    makeDuplicateInstancesHeuristic(reference, candidate);
    const setStatusDetail = vi.fn();
    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="aggressive"
        statusDetail="comparison"
        setStatusDetail={setStatusDetail}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    const flattenTargets = await screen.findAllByRole("button", {
      name: "Flatten union duplicate",
    });
    expect(flattenTargets).toHaveLength(2);
    expect(screen.getByTestId("schematic").getAttribute("data-heuristic-count")).toBe("2");
    fireEvent.click(flattenTargets[0]);
    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-group-count")).toBe("1");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });

    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "conservative" },
    });
    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-group-count")).toBe("1");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });
    expect(setStatusDetail).toHaveBeenCalledWith(
      expect.stringContaining("flattened the selected instance on the candidate side"),
    );

    fireEvent.change(screen.getByLabelText("Schematic matching policy"), {
      target: { value: "aggressive" },
    });
    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-group-count")).toBe("1");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });
  });

  it("keeps a removed module at one hierarchy segment and marks its top as removed", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    fireEvent.click(await screen.findByRole("button", { name: "u_legacy (legacy_child)" }));

    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-instance-path")).toBe("top.u_legacy");
      expect(schematic.getAttribute("data-top-status")).toBe("removed");
      expect(schematic.getAttribute("data-removed-count")).toBe("1");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Select top module" }));
    await waitFor(() =>
      expect(screen.getByTestId("schematic").getAttribute("data-selected-id")).toBe(TOP_MODULE_ID),
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle inspector" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Selection inspector").textContent).toContain(
        "Missing from candidate",
      ),
    );
  });

  it("marks the top of an added one-sided module as added", async () => {
    const reference = bundle("reference");
    const candidate = bundle("candidate");
    render(
      <ComparisonWorkspaceView
        reference={reference.input}
        candidate={candidate.input}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onOpenBundle={vi.fn()}
        onCompareBundles={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Hierarchy" }));
    fireEvent.click(await screen.findByRole("button", { name: "u_new (new_child)" }));

    await waitFor(() => {
      const schematic = screen.getByTestId("schematic");
      expect(schematic.getAttribute("data-instance-path")).toBe("top.u_new");
      expect(schematic.getAttribute("data-top-status")).toBe("added");
      expect(schematic.getAttribute("data-added-count")).toBe("1");
      expect(schematic.getAttribute("data-busy")).toBe("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Select top module" }));
    await waitFor(() =>
      expect(screen.getByTestId("schematic").getAttribute("data-selected-id")).toBe(TOP_MODULE_ID),
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle inspector" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Selection inspector").textContent).toContain(
        "Added in candidate",
      ),
    );
  });
});
