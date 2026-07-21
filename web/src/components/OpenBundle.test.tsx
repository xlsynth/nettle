// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMOS } from "../demos";
import { BundleWelcome } from "./OpenBundle";

afterEach(cleanup);

describe("BundleWelcome", () => {
  it("offers exactly the two public integration demos", () => {
    const onOpenDemo = vi.fn();
    render(
      <BundleWelcome
        mode="static"
        loading={false}
        onSelect={vi.fn()}
        demos={DEMOS}
        onOpenDemo={onOpenDemo}
      />,
    );

    expect(screen.getByText("Static mode")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Bedrock CDC FIFO/ }));
    expect(onOpenDemo).toHaveBeenCalledWith(DEMOS[0]);

    fireEvent.click(screen.getByRole("button", { name: /Schematic diff/ }));
    expect(onOpenDemo).toHaveBeenCalledWith(DEMOS[1]);
    expect(screen.queryByText(/upload/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Compare two bundles/ })).toBeNull();
  });

  it("offers the compact hosted workflows without examples", () => {
    const onUploadBundle = vi.fn();
    const onUploadSources = vi.fn();
    const onCompare = vi.fn();
    render(
      <BundleWelcome
        mode="hosted"
        loading={false}
        onSelect={vi.fn()}
        onUploadBundle={onUploadBundle}
        onUploadSources={onUploadSources}
        onCompare={onCompare}
      />,
    );

    expect(screen.getByText("Hosted mode")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Upload a bundle/ }));
    fireEvent.click(screen.getByRole("button", { name: /Build from RTL sources/ }));
    fireEvent.click(screen.getByRole("button", { name: /Compare two bundles/ }));

    expect(onUploadBundle).toHaveBeenCalledOnce();
    expect(onUploadSources).toHaveBeenCalledOnce();
    expect(onCompare).toHaveBeenCalledOnce();
    expect(screen.queryByText("Try an example")).toBeNull();
  });
});
