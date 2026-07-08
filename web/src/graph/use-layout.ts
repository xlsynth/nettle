// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { GraphSlice } from "../model/graph";
import type { LayoutProfile } from "./layout-profile";
import type { FlattenRenderMode, LayoutResult } from "./layout-types";

export interface LayoutState {
  layout: LayoutResult | null;
  loading: boolean;
  error: string | null;
}

interface StoredLayoutState extends LayoutState {
  slice: GraphSlice;
  profile: LayoutProfile;
  flattenRenderMode: FlattenRenderMode;
  separateConnectedComponents: boolean;
}

export const useLayout = (
  slice: GraphSlice,
  profile: LayoutProfile = "auto",
  flattenRenderMode: FlattenRenderMode = "grouped",
  separateConnectedComponents = false,
): LayoutState => {
  const generation = useRef(0);
  const [state, setState] = useState<StoredLayoutState>({
    slice,
    profile,
    flattenRenderMode,
    separateConnectedComponents,
    layout: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const current = ++generation.current;
    setState({
      slice,
      profile,
      flattenRenderMode,
      separateConnectedComponents,
      layout: null,
      loading: true,
      error: null,
    });
    let active = true;
    const controller = new AbortController();
    void import("./elk-layout")
      .then(({ runElkLayout }) =>
        runElkLayout(
          slice,
          profile,
          flattenRenderMode,
          controller.signal,
          separateConnectedComponents,
        ),
      )
      .then((layout) => {
        if (active && current === generation.current) {
          setState({
            slice,
            profile,
            flattenRenderMode,
            separateConnectedComponents,
            layout,
            loading: false,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (active && current === generation.current) {
          setState({
            layout: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            slice,
            profile,
            flattenRenderMode,
            separateConnectedComponents,
          });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [flattenRenderMode, profile, separateConnectedComponents, slice]);

  // Effects run after render. Hide a result from the previous input synchronously so
  // stale geometry can never dispatch events against the new graph semantics.
  if (
    state.slice !== slice ||
    state.profile !== profile ||
    state.flattenRenderMode !== flattenRenderMode ||
    state.separateConnectedComponents !== separateConnectedComponents
  ) {
    return { layout: null, loading: true, error: null };
  }
  return state;
};
