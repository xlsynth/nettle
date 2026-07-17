// SPDX-License-Identifier: Apache-2.0

export interface DemoBundle {
  name: string;
  route: string;
}

export type Demo =
  | {
      id: "smoke";
      title: string;
      description: string;
      kind: "bundle";
      bundle: DemoBundle;
    }
  | {
      id: "schematic-diff";
      title: string;
      description: string;
      kind: "comparison";
      reference: DemoBundle;
      candidate: DemoBundle;
    };

/** Public, deterministic bundles generated from Nettle-owned integration fixtures. */
export const DEMOS: readonly Demo[] = [
  {
    id: "smoke",
    title: "Hierarchy smoke test",
    description: "Open a small elaborated design with a child module and source cross-probing.",
    kind: "bundle",
    bundle: { name: "smoke.nettle", route: "/demos/smoke.nettle" },
  },
  {
    id: "schematic-diff",
    title: "Schematic diff",
    description: "Compare the reference and candidate integration designs side by side.",
    kind: "comparison",
    reference: {
      name: "schematic-reference.nettle",
      route: "/demos/schematic-reference.nettle",
    },
    candidate: {
      name: "schematic-candidate.nettle",
      route: "/demos/schematic-candidate.nettle",
    },
  },
];
