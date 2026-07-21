// SPDX-License-Identifier: Apache-2.0

export interface DemoBundle {
  name: string;
  route: string;
}

export type Demo =
  | {
      id: "bedrock-cdc-fifo";
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

/** Public, deterministic bundles generated from manifest-pinned integration fixtures. */
export const DEMOS: readonly Demo[] = [
  {
    id: "bedrock-cdc-fifo",
    title: "Bedrock CDC FIFO",
    description: "Explore the RTL CDC FIFO used by Nettle's browser regression.",
    kind: "bundle",
    bundle: {
      name: "br_cdc_fifo_flops.nettle",
      route: "/demos/br_cdc_fifo_flops.nettle",
    },
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
