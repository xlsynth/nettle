// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphSlice } from "../model/graph";
import { InstanceHierarchy } from "./InstanceHierarchy";

const root: GraphSlice = {
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
      id: "u_child",
      kind: "module",
      label: "u_child",
      definitionName: "child",
      ports: [],
    },
  ],
  edges: [],
};

const child: GraphSlice = {
  snapshotId: "snapshot",
  module: {
    id: "child",
    name: "u_child",
    instancePath: "top.u_child",
    definitionName: "child",
    parameters: {},
  },
  nodes: [],
  edges: [],
};

describe("InstanceHierarchy", () => {
  it("loads an instance lazily and navigates to the resulting hierarchy stack", async () => {
    const loadChild = vi.fn().mockResolvedValue(child);
    const onNavigate = vi.fn();
    const view = render(
      <InstanceHierarchy
        root={root}
        activeInstancePath="top"
        loadChild={loadChild}
        onNavigate={onNavigate}
        onShowSource={vi.fn()}
      />,
    );

    expect(loadChild).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "u_child (child)" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith([root, child]));
    expect(loadChild).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("switches back to the source view", () => {
    const onShowSource = vi.fn();
    const view = render(
      <InstanceHierarchy
        root={root}
        activeInstancePath="top"
        loadChild={vi.fn()}
        onNavigate={vi.fn()}
        onShowSource={onShowSource}
      />,
    );

    fireEvent.click(view.getByRole("tab", { name: "Source" }));
    expect(onShowSource).toHaveBeenCalledOnce();
    view.unmount();
  });
});
