// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";

afterEach(cleanup);

describe("AppHeader", () => {
  it("dispatches each header action", () => {
    const onOpenProject = vi.fn();
    const onSearch = vi.fn();
    const onHelp = vi.fn();

    render(
      <AppHeader
        projectName="core.f"
        statusText="Bundle ready"
        dataMode="bundle"
        onOpenProject={onOpenProject}
        onSearch={onSearch}
        onHelp={onHelp}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search project" }));
    fireEvent.click(screen.getByRole("button", { name: "Help" }));

    expect(onSearch).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(screen.getByText("Bundle ready")).not.toBeNull();
    expect(screen.queryByText(/slang/i)).toBeNull();
  });
});
