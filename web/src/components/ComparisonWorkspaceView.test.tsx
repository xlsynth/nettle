// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiGraphSlice } from "../api/contracts";
import type { LoadedWorkspace } from "../api/normalize";
import type { WorkspaceProvider } from "../bundle/provider";
import type { GraphSlice, ProjectSnapshot } from "../model/graph";
import {
  type ComparisonBundleInput,
  ComparisonWorkspaceView,
  compatibilityWarnings,
} from "./ComparisonWorkspaceView";

afterEach(cleanup);

const slice = (snapshotId: string, name: string): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-${name}`,
    name,
    instancePath: name,
    definitionName: name,
    parameters: {},
  },
  nodes: [],
  edges: [],
});

const apiSlice = (snapshotId: string, name: string): ApiGraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-${name}`,
    name,
    instancePath: name,
    definitionName: name,
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

const bundle = (snapshotId: string, name: string): ComparisonBundleInput => {
  const workspace: LoadedWorkspace = {
    project: project(snapshotId),
    slice: slice(snapshotId, name),
  };
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
    modules: [{ id: workspace.slice.module.id, name, definitionName: name }],
  };
};

describe("comparison workspace module pairing", () => {
  it("keeps hosted-reference visibility and local-candidate privacy explicit", () => {
    render(
      <ComparisonWorkspaceView
        reference={bundle("reference", "top")}
        candidate={bundle("candidate", "top")}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
        hostedReference={{
          token: "a".repeat(64),
          status: {
            state: "ready",
            admittedAtMs: 1,
            completedAtMs: 2,
            serverTimeMs: 3,
          },
        }}
      />,
    );

    expect(screen.getByText("Reference is from a shareable session")).toBeTruthy();
    expect(screen.getByText(/Candidate stays in this browser and is not uploaded/)).toBeTruthy();
    expect(screen.getByText(/creates no new shareable URL/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download reference" })).toBeTruthy();
  });

  it("keeps close-design navigation available while hosted module pairing is required", () => {
    const reference = bundle("reference", "reference_top");
    const candidate = bundle("candidate", "candidate_top");
    const onCloseDesign = vi.fn();

    render(
      <ComparisonWorkspaceView
        reference={reference}
        candidate={candidate}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={onCloseDesign}
        hostedReference={{
          token: "a".repeat(64),
          status: {
            state: "ready",
            admittedAtMs: 1,
            completedAtMs: 2,
            serverTimeMs: 3,
          },
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Choose modules to compare" })).toBeTruthy();
    expect(document.querySelector(".hosted-viewer-banner")).toBeTruthy();
    expect(document.querySelector(".bundle-welcome.module-pair-gate.hosted-session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close design" }));
    expect(onCloseDesign).toHaveBeenCalledOnce();
  });

  it("compares compatibility metadata canonically instead of warning on ordering", () => {
    const reference = bundle("reference", "top");
    const candidate = bundle("candidate", "top");
    const boundaries = [
      {
        id: "input-a",
        kind: "input" as const,
        label: "a",
        ports: [{ id: "a", name: "A", direction: "output" as const, width: 8 }],
      },
      {
        id: "input-b",
        kind: "input" as const,
        label: "b",
        ports: [{ id: "b", name: "B", direction: "output" as const, width: 8 }],
      },
    ];
    reference.workspace.slice.nodes = boundaries;
    candidate.workspace.slice.nodes = [...boundaries].reverse();
    reference.workspace.project.effectiveElaboration = {
      parameters: [
        { name: "WIDTH", value: "8" },
        { name: "DEPTH", value: "4" },
      ],
      defines: [{ name: "SYNTHESIS" }, { name: "MODE", value: "fast" }],
      undefines: ["SIMULATION", "DEBUG"],
    };
    candidate.workspace.project.effectiveElaboration = {
      parameters: [...reference.workspace.project.effectiveElaboration.parameters].reverse(),
      defines: [...reference.workspace.project.effectiveElaboration.defines].reverse(),
      undefines: [...reference.workspace.project.effectiveElaboration.undefines].reverse(),
    };
    reference.workspace.project.tools = [
      { name: "slang", path: "slang", version: "1" },
      { name: "yosys", path: "yosys", version: "2" },
    ];
    candidate.workspace.project.tools = [...reference.workspace.project.tools].reverse();

    expect(compatibilityWarnings(reference, candidate)).toEqual([]);
    candidate.workspace.slice.module.parameters = { WIDTH: 16 };
    expect(compatibilityWarnings(reference, candidate)).toContain("Top parameters differ");
  });

  it("does not run graph comparison before different tops are explicitly paired", () => {
    render(
      <ComparisonWorkspaceView
        reference={bundle("reference", "reference_top")}
        candidate={bundle("candidate", "candidate_top")}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Choose modules to compare" })).toBeTruthy();
    expect((screen.getByLabelText("Reference module") as HTMLSelectElement).value).toBe(
      "reference_top",
    );
    expect((screen.getByLabelText("Candidate module") as HTMLSelectElement).value).toBe(
      "candidate_top",
    );
    expect(
      (screen.getByRole("button", { name: "Compare selected modules" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(document.querySelector(".schematic-canvas")).toBeNull();
  });

  it("restores a valid explicit module pair from a shareable route", async () => {
    const reference = bundle("reference", "reference_top");
    const candidate = bundle("candidate", "candidate_top");
    reference.modules.push({
      id: "reference-selected",
      name: "reference_selected",
      definitionName: "reference_selected",
    });
    candidate.modules.push({
      id: "candidate-selected",
      name: "candidate_selected",
      definitionName: "candidate_selected",
    });
    vi.mocked(reference.provider.getGraphSlice).mockResolvedValue(
      apiSlice("reference", "reference_selected"),
    );
    vi.mocked(candidate.provider.getGraphSlice).mockResolvedValue(
      apiSlice("candidate", "candidate_selected"),
    );
    const onModulePairChange = vi.fn();

    render(
      <ComparisonWorkspaceView
        reference={reference}
        candidate={candidate}
        initialPolicy="conservative"
        initialModulePair={{
          referenceModule: "reference_selected",
          candidateModule: "candidate_selected",
        }}
        onModulePairChange={onModulePairChange}
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(onModulePairChange).toHaveBeenCalledWith({
        referenceModule: "reference_selected",
        candidateModule: "candidate_selected",
      }),
    );
    expect(reference.provider.getGraphSlice).toHaveBeenCalledWith(
      {
        snapshotId: "reference",
        moduleName: "reference_selected",
      },
      expect.any(AbortSignal),
    );
    expect(candidate.provider.getGraphSlice).toHaveBeenCalledWith(
      {
        snapshotId: "candidate",
        moduleName: "candidate_selected",
      },
      expect.any(AbortSignal),
    );
  });

  it("restores non-default modules even when the bundle tops already match", async () => {
    const reference = bundle("reference", "top");
    const candidate = bundle("candidate", "top");
    reference.modules.push({
      id: "reference-selected",
      name: "reference_selected",
      definitionName: "reference_selected",
    });
    candidate.modules.push({
      id: "candidate-selected",
      name: "candidate_selected",
      definitionName: "candidate_selected",
    });
    vi.mocked(reference.provider.getGraphSlice).mockResolvedValue(
      apiSlice("reference", "reference_selected"),
    );
    vi.mocked(candidate.provider.getGraphSlice).mockResolvedValue(
      apiSlice("candidate", "candidate_selected"),
    );
    const onModulePairChange = vi.fn();

    render(
      <ComparisonWorkspaceView
        reference={reference}
        candidate={candidate}
        initialPolicy="conservative"
        initialModulePair={{
          referenceModule: "reference_selected",
          candidateModule: "candidate_selected",
        }}
        onModulePairChange={onModulePairChange}
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(onModulePairChange).toHaveBeenCalledWith({
        referenceModule: "reference_selected",
        candidateModule: "candidate_selected",
      }),
    );
    expect(reference.provider.getGraphSlice).toHaveBeenCalledOnce();
    expect(candidate.provider.getGraphSlice).toHaveBeenCalledOnce();
  });

  it("falls back to the chooser when a shared module pair is stale", async () => {
    const reference = bundle("reference", "top");
    const candidate = bundle("candidate", "top");
    vi.mocked(reference.provider.getGraphSlice).mockImplementation(async ({ moduleName }) => {
      if (!moduleName) throw new Error("reference module name is required");
      return apiSlice("reference", moduleName);
    });
    vi.mocked(candidate.provider.getGraphSlice).mockImplementation(async ({ moduleName }) => {
      if (!moduleName) throw new Error("candidate module name is required");
      return apiSlice("candidate", moduleName);
    });
    const onModulePairChange = vi.fn();

    render(
      <ComparisonWorkspaceView
        reference={reference}
        candidate={candidate}
        initialPolicy="conservative"
        initialModulePair={{
          referenceModule: "removed_reference_module",
          candidateModule: "removed_candidate_module",
        }}
        onModulePairChange={onModulePairChange}
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Choose modules to compare" })).toBeTruthy();
    expect(screen.queryByText(/bundle tops differ/i)).toBeNull();
    expect(screen.getByText(/Confirm an explicit module pair/)).toBeTruthy();
    expect((screen.getByLabelText("Reference module") as HTMLSelectElement).value).toBe("top");
    expect((screen.getByLabelText("Candidate module") as HTMLSelectElement).value).toBe("top");
    expect(reference.provider.getGraphSlice).not.toHaveBeenCalled();
    expect(candidate.provider.getGraphSlice).not.toHaveBeenCalled();
    expect(onModulePairChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Compare selected modules" }));
    await waitFor(() =>
      expect(onModulePairChange).toHaveBeenCalledWith({
        referenceModule: "top",
        candidateModule: "top",
      }),
    );
  });

  it("preserves the valid side when only one shared module selection is stale", () => {
    const reference = bundle("reference", "top");
    const candidate = bundle("candidate", "top");
    reference.modules.push({
      id: "reference-selected",
      name: "reference_selected",
      definitionName: "reference_selected",
    });

    render(
      <ComparisonWorkspaceView
        reference={reference}
        candidate={candidate}
        initialPolicy="conservative"
        initialModulePair={{
          referenceModule: "reference_selected",
          candidateModule: "removed_candidate_module",
        }}
        onModulePairChange={vi.fn()}
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Choose modules to compare" })).toBeTruthy();
    expect((screen.getByLabelText("Reference module") as HTMLSelectElement).value).toBe(
      "reference_selected",
    );
    expect((screen.getByLabelText("Candidate module") as HTMLSelectElement).value).toBe("top");
    expect(reference.provider.getGraphSlice).not.toHaveBeenCalled();
    expect(candidate.provider.getGraphSlice).not.toHaveBeenCalled();
  });

  it("makes clear that header schematic counts describe the visible slice", async () => {
    render(
      <ComparisonWorkspaceView
        reference={bundle("reference", "top")}
        candidate={bundle("candidate", "top")}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    expect(await screen.findByText("0 current-slice schematic changes")).toBeTruthy();
  });

  it("uses reference build configuration in the reference snapshot inspector", async () => {
    const reference = bundle("reference", "top");
    const candidate = bundle("candidate", "top");
    reference.workspace.slice.module.parameters = { WIDTH: 8 };
    candidate.workspace.slice.module.parameters = { WIDTH: 16 };
    reference.workspace.project.effectiveElaboration.defines = [
      { name: "REFERENCE_BUILD", value: "1" },
    ];
    candidate.workspace.project.effectiveElaboration.defines = [
      { name: "CANDIDATE_BUILD", value: "1" },
    ];

    render(
      <ComparisonWorkspaceView
        reference={reference}
        candidate={candidate}
        initialPolicy="conservative"
        statusDetail="comparison"
        setStatusDetail={vi.fn()}
        onCloseDesign={vi.fn()}
      />,
    );

    const viewButton = await screen.findByRole("button", {
      name: /Schematic comparison view:/,
    });
    fireEvent.click(viewButton);
    fireEvent.click(screen.getByRole("radio", { name: "Reference snapshot" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle inspector" }));

    expect(await screen.findByText("REFERENCE_BUILD")).toBeTruthy();
    expect(screen.queryByText("CANDIDATE_BUILD")).toBeNull();
    expect(screen.getAllByText("8")).not.toHaveLength(0);
  });
});
