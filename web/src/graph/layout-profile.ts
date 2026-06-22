// SPDX-License-Identifier: Apache-2.0

import type { GraphSlice } from "../model/graph";

const AUTO_OVERVIEW_COMPLEXITY = 2_000;

export type LayoutProfile = "auto" | "fast" | "detailed" | "balanced" | "wide";
export type EffectiveLayoutProfile = Exclude<LayoutProfile, "auto">;

export interface LayoutProfileOption {
  value: LayoutProfile;
  label: string;
  description: string;
}

export const LAYOUT_PROFILE_OPTIONS: readonly LayoutProfileOption[] = [
  {
    value: "auto",
    label: "Auto",
    description:
      "Chooses a high-quality layout for normal graphs and fast draft mode for very large graphs. Pro: a safe default. Con: the layout style can change with graph size.",
  },
  {
    value: "fast",
    label: "Fast grouped grid",
    description:
      "Places related nodes on a simple grouped grid. Pro: effectively instant, even for huge graphs. Con: draft-quality routes can cross and overlap heavily.",
  },
  {
    value: "detailed",
    label: "Detailed layered flow",
    description:
      "Builds a thorough left-to-right layered layout. Pro: best topology and crossing quality. Con: can be slow and very tall on large graphs.",
  },
  {
    value: "balanced",
    label: "Balanced layered flow",
    description:
      "Wraps a high-quality layered flow toward a screen-like aspect ratio. Pro: more balanced dimensions. Con: wrapping adds bends and can still be slow.",
  },
  {
    value: "wide",
    label: "Wide layered flow",
    description:
      "Uses a quicker high-quality layered flow without wrapping. Pro: faster than detailed while preserving flow. Con: fewer crossing optimizations and potentially extreme width.",
  },
] as const;

export const effectiveLayoutProfile = (
  slice: GraphSlice,
  profile: LayoutProfile,
): EffectiveLayoutProfile =>
  profile === "auto"
    ? slice.nodes.length + slice.edges.length >= AUTO_OVERVIEW_COMPLEXITY
      ? "fast"
      : "detailed"
    : profile;
