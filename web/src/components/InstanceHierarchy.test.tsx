// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphSlice } from "../model/graph";
import { type DescendantChangeStatus, InstanceHierarchy } from "./InstanceHierarchy";

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

afterEach(cleanup);

describe("InstanceHierarchy", () => {
  it("loads an instance lazily and navigates to the resulting hierarchy stack", async () => {
    const childWithGrandchild: GraphSlice = {
      ...child,
      nodes: [
        {
          id: "u_grandchild",
          kind: "module",
          label: "u_grandchild",
          definitionName: "grandchild",
          ports: [],
        },
      ],
    };
    const loadChild = vi.fn().mockResolvedValue(childWithGrandchild);
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
    expect(view.container.querySelector(".hierarchy-diff-badge")).toBeNull();
    expect(
      view.getAllByRole("treeitem").every((row) => row.getAttribute("aria-label") === null),
    ).toBe(true);
    expect(
      view.getByRole("button", { name: "u_child (child)" }).getAttribute("aria-describedby"),
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "u_child (child)" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith([root, childWithGrandchild]));
    expect(loadChild).toHaveBeenCalledOnce();
    expect(view.getByRole("button", { name: "u_grandchild (grandchild)" })).toBeTruthy();
    view.unmount();
  });

  it("adds non-color status badges and accessible descriptions in comparison mode", () => {
    const view = render(
      <InstanceHierarchy
        root={root}
        activeInstancePath="top"
        loadChild={vi.fn()}
        onNavigate={vi.fn()}
        onShowSource={vi.fn()}
        diffStatusFor={(_parent, instance) => (instance ? "removed" : "modified")}
      />,
    );

    const rootRow = view.getByRole("treeitem", { name: "top (top), Modified" });
    const childRow = view.getByRole("treeitem", {
      name: "u_child (child), Missing from candidate",
    });
    expect(rootRow.classList.contains("diff-status-modified")).toBe(true);
    expect(childRow.classList.contains("diff-status-removed")).toBe(true);
    expect(rootRow.querySelector(".hierarchy-diff-badge")?.textContent).toContain("M");
    expect(childRow.querySelector(".hierarchy-diff-badge")?.textContent).toContain("D");

    const childButton = view.getByRole("button", { name: "u_child (child)" });
    const descriptionId = childButton.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId as string)?.textContent).toContain(
      "Missing from candidate",
    );
    view.unmount();
  });

  it("labels descendant changes separately while preserving the instance status and path", async () => {
    const descendantChangesFor = vi.fn().mockResolvedValue("contains");
    const view = render(
      <InstanceHierarchy
        root={root}
        activeInstancePath="top"
        loadChild={vi.fn()}
        onNavigate={vi.fn()}
        onShowSource={vi.fn()}
        diffStatusFor={() => "unchanged"}
        descendantChangesFor={descendantChangesFor}
      />,
    );

    const childRow = await view.findByRole("treeitem", {
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
    expect(view.getByRole("button", { name: "u_child (child)" }).title).toBe("top.u_child");
    expect(descendantChangesFor).toHaveBeenCalledWith(root, root.nodes[0], expect.any(AbortSignal));
    view.unmount();
  });

  it("exposes an unknown descendant status instead of silently treating it as unchanged", async () => {
    const view = render(
      <InstanceHierarchy
        root={root}
        activeInstancePath="top"
        loadChild={vi.fn()}
        onNavigate={vi.fn()}
        onShowSource={vi.fn()}
        diffStatusFor={() => "unchanged"}
        descendantChangesFor={vi.fn().mockResolvedValue("unknown")}
      />,
    );

    const childRow = await view.findByRole("treeitem", {
      name: "u_child (child), Unchanged, Change status unknown",
    });
    expect(childRow.classList.contains("descendant-change-unknown")).toBe(true);
    const badge = childRow.querySelector<HTMLElement>(
      ".hierarchy-diff-badge.change-status-unknown",
    );
    expect(badge?.textContent).toContain("?");
    expect(badge?.title).toBe("Descendant change status unknown for top.u_child");
    view.unmount();
  });

  it("aborts descendant inspection when its hierarchy row unmounts", async () => {
    let signal: AbortSignal | undefined;
    const view = render(
      <InstanceHierarchy
        root={root}
        activeInstancePath="top"
        loadChild={vi.fn()}
        onNavigate={vi.fn()}
        onShowSource={vi.fn()}
        descendantChangesFor={vi.fn((_parent, _instance, requestSignal) => {
          signal = requestSignal;
          return new Promise<DescendantChangeStatus>(() => undefined);
        })}
      />,
    );

    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
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
