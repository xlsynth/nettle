// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSlice } from "../model/graph";
import { HelpDialog, ProjectSearchDialog } from "./HeaderDialogs";

afterEach(cleanup);

const slice: GraphSlice = {
  snapshotId: "snapshot",
  module: {
    id: "top",
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: {},
  },
  nodes: [
    {
      id: "u-alu",
      kind: "module",
      label: "u_alu",
      definitionName: "alu",
      ports: [],
    },
  ],
  edges: [{ id: "sum-edge", sourceNode: "u-alu", targetNode: "u-alu", label: "sum" }],
};

describe("header dialogs", () => {
  it("searches repository files and selects a result", () => {
    const onSelectFile = vi.fn();
    const onClose = vi.fn();
    render(
      <ProjectSearchDialog
        open
        files={[
          {
            name: "rtl",
            path: "rtl",
            kind: "directory",
            children: [{ name: "top.sv", path: "rtl/top.sv", kind: "file", fileId: "file-top" }],
          },
        ]}
        slice={slice}
        onClose={onClose}
        onSelectFile={onSelectFile}
        onSelectEntity={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files and schematic" }), {
      target: { value: "top.sv" },
    });
    fireEvent.click(screen.getByRole("button", { name: /top\.sv/i }));

    expect(onSelectFile).toHaveBeenCalledWith("rtl/top.sv", "file-top");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("searches and selects a schematic object", () => {
    const onSelectEntity = vi.fn();
    render(
      <ProjectSearchDialog
        open
        files={[]}
        slice={slice}
        onClose={vi.fn()}
        onSelectFile={vi.fn()}
        onSelectEntity={onSelectEntity}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files and schematic" }), {
      target: { value: "u_alu" },
    });
    fireEvent.click(screen.getByRole("button", { name: /u_alu/i }));

    expect(onSelectEntity).toHaveBeenCalledWith("u-alu");
  });

  it("explains hierarchy and source interactions", () => {
    render(<HelpDialog open onClose={vi.fn()} />);
    expect(screen.getByText("Select and cross-probe")).toBeTruthy();
    expect(screen.getByText("Navigate hierarchy")).toBeTruthy();
    expect(screen.getByText(/Right-click it to flatten one instance/)).toBeTruthy();
  });
});
