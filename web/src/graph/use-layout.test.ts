// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoSlice } from "../data/demo";
import type { LayoutProfile } from "./layout-profile";
import type { FlattenRenderMode } from "./layout-types";
import { useLayout } from "./use-layout";

describe("useLayout", () => {
  it("completes layout when effects are restarted by Strict Mode", async () => {
    const { result } = renderHook(() => useLayout(demoSlice), { reactStrictMode: true });

    await waitFor(() => expect(result.current.layout).not.toBeNull());
    expect(result.current).toMatchObject({ loading: false, error: null });
  });

  it("never exposes geometry computed for a previous slice", async () => {
    const replacement = {
      ...demoSlice,
      snapshotId: "replacement-snapshot",
      module: { ...demoSlice.module, id: "replacement-module", name: "replacement" },
    };
    const { result, rerender } = renderHook(({ slice }) => useLayout(slice), {
      initialProps: { slice: demoSlice },
    });

    await waitFor(() => expect(result.current.layout).not.toBeNull());
    const previousLayout = result.current.layout;

    rerender({ slice: replacement });
    expect(result.current).toMatchObject({ layout: null, loading: true, error: null });

    await waitFor(() => expect(result.current.layout).not.toBeNull());
    expect(result.current.layout).not.toBe(previousLayout);
  });

  it("never exposes geometry computed for a previous layout profile", async () => {
    const { result, rerender } = renderHook(({ profile }) => useLayout(demoSlice, profile), {
      initialProps: { profile: "detailed" as LayoutProfile },
    });

    await waitFor(() => expect(result.current.layout).not.toBeNull());
    const detailedLayout = result.current.layout;
    rerender({ profile: "fast" });
    expect(result.current).toMatchObject({ layout: null, loading: true, error: null });
    await waitFor(() => expect(result.current.layout).not.toBeNull());
    expect(result.current.layout).not.toBe(detailedLayout);
  });

  it("never exposes geometry computed for a previous flatten render mode", async () => {
    const { result, rerender } = renderHook(({ mode }) => useLayout(demoSlice, "detailed", mode), {
      initialProps: { mode: "grouped" as FlattenRenderMode },
    });

    await waitFor(() => expect(result.current.layout).not.toBeNull());
    const groupedLayout = result.current.layout;
    rerender({ mode: "flat" });
    expect(result.current).toMatchObject({ layout: null, loading: true, error: null });
    await waitFor(() => expect(result.current.layout).not.toBeNull());
    expect(result.current.layout).not.toBe(groupedLayout);
  });
});
