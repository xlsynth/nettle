// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree";
import { CompareBundlesDialog } from "./OpenBundle";

afterEach(cleanup);

describe("comparison bundle picker", () => {
  it("collects both bundles and the selected matching policy", () => {
    const onCompare = vi.fn();
    const reference = new File(["reference"], "reference.nettle", { type: "application/zip" });
    const candidate = new File(["candidate"], "candidate.nettle", { type: "application/zip" });

    render(<CompareBundlesDialog open loading={false} onCompare={onCompare} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Choose reference .nettle bundle file"), {
      target: { files: [reference] },
    });
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [candidate] },
    });
    fireEvent.change(screen.getByLabelText(/Matching policy/), {
      target: { value: "aggressive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare bundles" }));

    expect(onCompare).toHaveBeenCalledWith(reference, candidate, "aggressive");
    expect(screen.getByText(/marks them with ≈/)).toBeTruthy();
  });

  it("swaps the reference and candidate slots", () => {
    const onCompare = vi.fn();
    const reference = new File(["reference"], "reference.nettle", {
      type: "application/zip",
    });
    const candidate = new File(["candidate"], "candidate.nettle", {
      type: "application/zip",
    });

    render(<CompareBundlesDialog open loading={false} onCompare={onCompare} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Choose reference .nettle bundle file"), {
      target: { files: [reference] },
    });
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [candidate] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Swap reference and candidate bundles" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare bundles" }));

    expect(onCompare).toHaveBeenCalledWith(candidate, reference, "conservative");
  });

  it("discloses which comparison side already has a shareable URL", () => {
    const hosted = new File(["hosted"], "design.nettle", {
      type: "application/zip",
    });

    render(
      <CompareBundlesDialog
        open
        loading={false}
        initialReference={hosted}
        hostedFiles={[hosted]}
        onCompare={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Reference already has a shareable URL/)).toBeTruthy();
    expect(screen.getByText(/Any local bundle stays in this browser/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Swap reference and candidate bundles" }));
    expect(screen.getByText(/Candidate already has a shareable URL/)).toBeTruthy();
  });

  it("contains dropped files instead of dispatching them to an enclosing workspace", () => {
    const enclosingDrop = vi.fn();
    const reference = new File(["reference"], "reference.nettle", {
      type: "application/zip",
    });

    render(
      <div role="application" aria-label="Workspace drop target" onDrop={enclosingDrop}>
        <CompareBundlesDialog open loading={false} onCompare={vi.fn()} onClose={vi.fn()} />
      </div>,
    );

    fireEvent.drop(screen.getByRole("button", { name: "Choose reference .nettle bundle" }), {
      dataTransfer: { files: [reference] },
    });

    expect(enclosingDrop).not.toHaveBeenCalled();
    expect(screen.getByText("reference.nettle")).toBeTruthy();
  });

  it("traps keyboard focus, closes with Escape, and restores the trigger", async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open comparison
          </button>
          <CompareBundlesDialog
            open={open}
            loading={false}
            onCompare={vi.fn()}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }

    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open comparison" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Choose reference .nettle bundle" }),
    );

    const close = screen.getByRole("button", { name: "Close compare bundles dialog" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    cancel.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Compare Nettle bundles" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("removes hidden file inputs from the tab order and disables them while loading", () => {
    render(<CompareBundlesDialog open loading onCompare={vi.fn()} onClose={vi.fn()} />);

    for (const label of [
      "Choose reference .nettle bundle file",
      "Choose candidate .nettle bundle file",
    ]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.disabled).toBe(true);
      expect(input.tabIndex).toBe(-1);
    }
  });
});

describe("comparison file tree", () => {
  it("shows compact accessible source status badges", () => {
    render(
      <FileTree
        entries={[
          { name: "changed.sv", path: "rtl/changed.sv", kind: "file", fileId: "changed" },
          { name: "new.sv", path: "rtl/new.sv", kind: "file", fileId: "new" },
        ]}
        selectedPath="rtl/changed.sv"
        statusByPath={{ "rtl/changed.sv": "modified", "rtl/new.sv": "added" }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTitle("Modified").textContent).toContain("M");
    expect(screen.getByTitle("Added in candidate").textContent).toContain("A");
    expect(screen.getByText("Modified", { selector: ".visually-hidden" })).toBeTruthy();
  });
});
