// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { GraphNode, GraphSlice } from "../model/graph";
import {
  changedComparisonEntitiesForSourceRange,
  classifySourceDiffHunks,
  comparisonHasSchematicSourceEvidence,
} from "./source-cross-probe";
import type { ComparisonSlice } from "./types";

const graph = (snapshotId: string, nodes: GraphNode[]): GraphSlice => ({
  snapshotId,
  module: {
    id: `${snapshotId}-top`,
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: {},
  },
  nodes,
  edges: [],
});

const referenceNode: GraphNode = {
  id: "old",
  kind: "operator",
  label: "old",
  ports: [],
  origins: [{ file: "rtl/top.sv", startLine: 10, startColumn: 1, endLine: 11 }],
};
const candidateNode: GraphNode = {
  id: "new",
  kind: "operator",
  label: "new",
  ports: [],
  origins: [{ file: "rtl/top.sv", startLine: 12, startColumn: 1, endLine: 13 }],
};
const comparison: ComparisonSlice = {
  reference: graph("reference", [referenceNode]),
  candidate: graph("candidate", [candidateNode]),
  union: graph("union", [{ ...candidateNode, id: "overlay" }]),
  nodes: [
    {
      id: "overlay",
      status: "modified",
      reference: referenceNode,
      candidate: candidateNode,
    },
  ],
  ports: [],
  edges: [],
  groups: [],
  policy: "conservative",
  heuristicMatchCount: 0,
};

describe("comparison source cross-probing", () => {
  it("returns every changed object intersecting the selected range", () => {
    expect(
      changedComparisonEntitiesForSourceRange(comparison, "candidate", "rtl/top.sv", 12, 12),
    ).toEqual(["overlay"]);
    expect(
      changedComparisonEntitiesForSourceRange(comparison, "candidate", "rtl/top.sv", 20, 20),
    ).toEqual([]);
  });

  it("treats direct and same-file indirect hunks as graph-affecting", () => {
    expect(
      classifySourceDiffHunks(comparison, "rtl/top.sv", "rtl/top.sv", [
        {
          referenceStartLine: 10,
          referenceEndLine: 10,
          candidateStartLine: 12,
          candidateEndLine: 12,
        },
        {
          referenceStartLine: 30,
          referenceEndLine: 30,
          candidateStartLine: 31,
          candidateEndLine: 31,
        },
      ]).map(({ sourceOnly }) => sourceOnly),
    ).toEqual([false, false]);
  });

  it("does not call a declaration hunk source-only when the same file has schematic changes", () => {
    expect(
      classifySourceDiffHunks(comparison, "rtl/top.sv", "rtl/top.sv", [
        {
          referenceStartLine: 2,
          referenceEndLine: 2,
          candidateStartLine: 2,
          candidateEndLine: 2,
        },
      ])[0].sourceOnly,
    ).toBe(false);
  });

  it("treats changed module parameters as schematic evidence in a module source file", () => {
    const reference = graph("reference", [referenceNode]);
    const candidate = graph("candidate", [{ ...referenceNode }]);
    reference.files = [{ id: "top", path: "rtl/top.sv" }];
    candidate.files = [{ id: "top", path: "rtl/top.sv" }];
    reference.module.parameters = { MaxValue: 1, MaxChange: 1 };
    candidate.module.parameters = { MaxChange: 3, MaxValue: 31 };
    const parameterComparison: ComparisonSlice = {
      ...comparison,
      reference,
      candidate,
      nodes: [
        {
          id: "overlay",
          status: "unchanged",
          reference: referenceNode,
          candidate: candidate.nodes[0],
        },
      ],
    };

    expect(
      classifySourceDiffHunks(parameterComparison, "rtl/top.sv", "rtl/top.sv", [
        {
          referenceStartLine: 2,
          referenceEndLine: 3,
          candidateStartLine: 2,
          candidateEndLine: 3,
        },
      ])[0].sourceOnly,
    ).toBe(false);
  });

  it("keeps an unrelated changed bundled file source-only when module parameters differ", () => {
    const reference = graph("reference", []);
    const candidate = graph("candidate", []);
    reference.files = [{ id: "top", path: "rtl/top.sv" }];
    candidate.files = [{ id: "top", path: "rtl/top.sv" }];
    reference.module.parameters = { WIDTH: 8 };
    candidate.module.parameters = { WIDTH: 16 };
    const sourceOnlyComparison: ComparisonSlice = {
      ...comparison,
      reference,
      candidate,
      nodes: [],
    };

    expect(
      classifySourceDiffHunks(
        sourceOnlyComparison,
        "rtl/z_source_only.sv",
        "rtl/z_source_only.sv",
        [
          {
            referenceStartLine: 1,
            referenceEndLine: 1,
            candidateStartLine: 1,
            candidateEndLine: 1,
          },
        ],
        ["rtl/top.sv", "rtl/z_source_only.sv"],
        ["rtl/top.sv", "rtl/z_source_only.sv"],
      )[0].sourceOnly,
    ).toBe(true);
  });

  it("fails closed when a compiler-origin suffix names multiple bundled files", () => {
    const ambiguousReference = {
      ...referenceNode,
      origins: [{ file: "foo.sv", startLine: 10, startColumn: 1 }],
    };
    const ambiguousCandidate = {
      ...candidateNode,
      origins: [{ file: "foo.sv", startLine: 12, startColumn: 1 }],
    };
    const ambiguousComparison: ComparisonSlice = {
      ...comparison,
      reference: {
        ...graph("reference", [ambiguousReference]),
        files: [{ id: "reference-foo", path: "foo.sv" }],
      },
      candidate: {
        ...graph("candidate", [ambiguousCandidate]),
        files: [{ id: "candidate-foo", path: "foo.sv" }],
      },
      nodes: [
        {
          ...comparison.nodes[0],
          reference: ambiguousReference,
          candidate: ambiguousCandidate,
        },
      ],
    };
    ambiguousComparison.reference.module.parameters = { WIDTH: 8 };
    ambiguousComparison.candidate.module.parameters = { WIDTH: 16 };
    const paths = ["rtl/a/foo.sv", "rtl/b/foo.sv"];

    expect(
      changedComparisonEntitiesForSourceRange(
        ambiguousComparison,
        "candidate",
        "rtl/a/foo.sv",
        12,
        12,
        paths,
      ),
    ).toEqual([]);
    expect(
      classifySourceDiffHunks(
        ambiguousComparison,
        "rtl/a/foo.sv",
        "rtl/a/foo.sv",
        [
          {
            referenceStartLine: 10,
            referenceEndLine: 10,
            candidateStartLine: 12,
            candidateEndLine: 12,
          },
        ],
        paths,
        paths,
      )[0].sourceOnly,
    ).toBe(false);
    expect(
      comparisonHasSchematicSourceEvidence(
        ambiguousComparison,
        "rtl/a/foo.sv",
        "rtl/a/foo.sv",
        paths,
        paths,
      ),
    ).toBe("unknown");
  });

  it("keeps exact-path cross-probing when another bundled file shares the basename", () => {
    const exactCandidate = {
      ...candidateNode,
      origins: [{ file: "rtl/a/foo.sv", startLine: 12, startColumn: 1 }],
    };
    const exactComparison: ComparisonSlice = {
      ...comparison,
      candidate: graph("candidate", [exactCandidate]),
      nodes: [{ ...comparison.nodes[0], candidate: exactCandidate }],
    };

    expect(
      changedComparisonEntitiesForSourceRange(
        exactComparison,
        "candidate",
        "rtl/a/foo.sv",
        12,
        12,
        ["rtl/a/foo.sv", "rtl/b/foo.sv"],
      ),
    ).toEqual(["overlay"]);
  });

  it("fails closed when a relevant compiler origin cannot be resolved into the bundle", () => {
    const unresolvedCandidate = {
      ...candidateNode,
      origins: [{ file: "/tmp/elaboration/foo.sv", startLine: 12, startColumn: 1 }],
    };
    const unresolvedComparison: ComparisonSlice = {
      ...comparison,
      candidate: graph("candidate", [unresolvedCandidate]),
      nodes: [{ ...comparison.nodes[0], candidate: unresolvedCandidate }],
    };

    expect(
      comparisonHasSchematicSourceEvidence(
        unresolvedComparison,
        "rtl/foo.sv",
        "rtl/foo.sv",
        ["rtl/foo.sv"],
        ["rtl/foo.sv"],
      ),
    ).toBe("unknown");
    expect(
      classifySourceDiffHunks(
        unresolvedComparison,
        "rtl/foo.sv",
        "rtl/foo.sv",
        [
          {
            referenceStartLine: 12,
            referenceEndLine: 12,
            candidateStartLine: 12,
            candidateEndLine: 12,
          },
        ],
        ["rtl/foo.sv"],
        ["rtl/foo.sv"],
      )[0].sourceOnly,
    ).toBe(false);
  });
});
