// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader, LandingHeader } from "./AppHeader";

afterEach(cleanup);

describe("AppHeader", () => {
  it("renders a brand-only landing header", () => {
    render(<LandingHeader />);

    expect(screen.getByRole("img", { name: "Nettle logo" })).toBeTruthy();
    expect(screen.getByText("NETTLE")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("dispatches each header action", () => {
    const onCloseDesign = vi.fn();
    const onSearch = vi.fn();
    const onHelp = vi.fn();

    render(
      <AppHeader
        projectName="core.f"
        statusText="Bundle ready"
        dataMode="bundle"
        onCloseDesign={onCloseDesign}
        onSearch={onSearch}
        onHelp={onHelp}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close design" }));
    fireEvent.click(screen.getByRole("button", { name: "Search project" }));
    fireEvent.click(screen.getByRole("button", { name: "Help" }));

    expect(onCloseDesign).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByText("core.f").closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open bundle" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare Nettle bundles" })).toBeNull();
    expect(screen.getByText("Bundle ready")).not.toBeNull();
    expect(screen.queryByText(/slang/i)).toBeNull();
  });

  it("shows comparison policy and source-change count", () => {
    render(
      <AppHeader
        projectName="before.nettle → after.nettle"
        statusText="7 schematic changes"
        dataMode="comparison"
        comparison={{
          referenceName: "before.nettle",
          candidateName: "after.nettle",
          policy: "aggressive",
          sourceChanges: 3,
          heuristicMatches: 2,
        }}
        onCloseDesign={vi.fn()}
        onSearch={vi.fn()}
        onHelp={vi.fn()}
      />,
    );

    expect(screen.getByText("before.nettle → after.nettle")).toBeTruthy();
    expect(screen.getByText(/aggressive · 3 source changes · 2 ≈/)).toBeTruthy();
    expect(screen.getByText("7 schematic changes")).toBeTruthy();
  });
});
