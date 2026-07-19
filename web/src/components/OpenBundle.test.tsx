// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEMOS } from "../demos";
import { BundleWelcome } from "./OpenBundle";

describe("BundleWelcome", () => {
  it("offers the public integration demos without opening a file picker", () => {
    const onOpenDemo = vi.fn();
    render(
      <BundleWelcome loading={false} onSelect={vi.fn()} demos={DEMOS} onOpenDemo={onOpenDemo} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Hierarchy smoke test/ }));
    expect(onOpenDemo).toHaveBeenCalledWith(DEMOS[0]);

    fireEvent.click(screen.getByRole("button", { name: /Generate-aware datapath/ }));
    expect(onOpenDemo).toHaveBeenCalledWith(DEMOS[1]);
  });
});
