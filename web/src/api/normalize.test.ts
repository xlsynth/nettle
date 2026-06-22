// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ApiGraphSlice, ProjectResponse, TreeResponse } from "./contracts";
import {
  findSourceReference,
  normalizeGraphSlice,
  normalizeProject,
  pathsReferToSameFile,
} from "./normalize";

const graphResponse: ApiGraphSlice = {
  snapshotId: "snapshot-1",
  module: {
    id: "module-top",
    name: "top",
    instancePath: "top",
    definitionName: "top",
    parameters: { WIDTH: "00001000" },
  },
  nodes: [
    {
      id: "clk",
      kind: "input",
      label: "clk",
      ports: [{ id: "clk-out", name: "clk", direction: "output", width: 1 }],
      origins: [
        {
          file: "rtl\\top.sv",
          startLine: 4,
          startColumn: 3,
          endLine: 4,
          endColumn: 6,
        },
      ],
    },
    {
      id: "add",
      kind: "operator",
      label: "+",
      ports: [
        { id: "add-a", name: "A", direction: "input", role: "data", width: 8 },
        { id: "add-y", name: "Y", direction: "output", role: "data", width: 8 },
      ],
    },
    {
      id: "reg",
      kind: "register",
      label: "DFF",
      ports: [
        { id: "reg-clk", name: "CLK", direction: "input", role: "clock", width: 1 },
        { id: "reg-d", name: "D", direction: "unknown", role: "data", width: 8 },
      ],
    },
    {
      id: "child",
      kind: "moduleInstance",
      label: "u_child",
      definitionName: "child",
      ports: [],
    },
  ],
  edges: [
    {
      id: "clock-edge",
      sourceNode: "clk",
      sourcePort: "clk-out",
      targetNode: "reg",
      targetPort: "reg-clk",
      label: "clk",
      width: 1,
    },
  ],
  groups: [
    {
      id: "child",
      name: "u_child",
      definitionName: "child",
      parameters: { WIDTH: "00001000" },
      origins: [
        {
          file: "rtl\\top.sv",
          startLine: 9,
          startColumn: 3,
          endLine: 9,
          endColumn: 28,
        },
      ],
      childNodeIds: ["child/input", "child/output"],
    },
  ],
  files: [{ id: "file-top", path: "rtl/top.sv" }],
};

const treeResponse: TreeResponse = {
  root: "/repo",
  entries: [
    {
      name: "rtl",
      path: "rtl",
      kind: "directory",
      children: [
        {
          name: "top.sv",
          path: "rtl/top.sv",
          kind: "file",
          fileId: "tree-file-top",
        },
      ],
    },
  ],
};

const projectResponse: ProjectResponse = {
  schemaVersion: 1,
  status: "ready",
  snapshotId: "snapshot-1",
  projectRoot: "/repo",
  filelist: "/repo/project.f",
  top: "top",
  tops: ["top"],
  modules: [],
  diagnostics: [],
  tools: [{ name: "slang", path: "slang", version: "slang 11.0.0" }],
  elaboration: {
    parameters: [{ name: "WIDTH", value: "32" }],
    defines: [{ name: "SYNTHESIS" }],
    undefines: ["SIMULATION"],
  },
  effectiveElaboration: {
    parameters: [
      { name: "DEPTH", value: "4" },
      { name: "WIDTH", value: "32" },
    ],
    defines: [{ name: "SYNTHESIS" }, { name: "WIDTH", value: "8" }],
    undefines: ["SIMULATION"],
  },
  normalizedProject: {
    rootFilelist: "/repo/project.f",
    sources: [],
    includeDirectories: [],
    libraryDirectories: [],
    libraryFiles: [],
    defines: [
      {
        name: "WIDTH",
        value: "8",
        origin: { file: "/repo/project.f", line: 2, column: 1, token: "+define+WIDTH=8" },
      },
    ],
    undefines: [],
    parameters: [],
    top: "top",
    unknownArguments: [],
    arguments: [],
  },
};

describe("server DTO normalization", () => {
  it("adapts graph kinds, glyphs, roles, directions, and source paths", () => {
    const graph = normalizeGraphSlice(graphResponse);

    expect(graph.nodes.find((node) => node.id === "child")).toMatchObject({
      kind: "module",
      label: "u_child",
      definitionName: "child",
    });
    expect(graph.nodes.find((node) => node.id === "add")).toMatchObject({
      kind: "operator",
      label: "Add",
      glyph: "+",
    });
    expect(graph.nodes.find((node) => node.id === "reg")?.ports[1].direction).toBe("inout");
    expect(graph.edges[0].role).toBe("clock");
    expect(graph.nodes[0].origins?.[0].file).toBe("rtl/top.sv");
    expect(graph.groups).toEqual([
      expect.objectContaining({
        id: "child",
        name: "u_child",
        definitionName: "child",
        parameters: { WIDTH: "00001000" },
        childNodeIds: ["child/input", "child/output"],
        origins: [expect.objectContaining({ file: "rtl/top.sv" })],
      }),
    ]);
    expect(graph.files).toEqual([{ id: "file-top", path: "rtl/top.sv" }]);
  });

  it("normalizes project metadata and prefers graph source IDs", () => {
    const project = normalizeProject(projectResponse, treeResponse);
    const graph = normalizeGraphSlice(graphResponse);

    expect(project).toMatchObject({
      name: "project.f",
      snapshotId: "snapshot-1",
      bundleStatus: "Bundle ready",
      defines: [{ name: "WIDTH", value: "8", origin: "project.f:2:1" }],
      elaboration: {
        parameters: [{ name: "WIDTH", value: "32" }],
        defines: [{ name: "SYNTHESIS" }],
        undefines: ["SIMULATION"],
      },
      effectiveElaboration: {
        parameters: [
          { name: "DEPTH", value: "4" },
          { name: "WIDTH", value: "32" },
        ],
        defines: [{ name: "SYNTHESIS" }, { name: "WIDTH", value: "8" }],
        undefines: ["SIMULATION"],
      },
    });
    expect(project.files[0].children?.[0].fileId).toBe("tree-file-top");
    expect(findSourceReference("/repo/rtl/top.sv", graph, project.files)).toEqual({
      id: "file-top",
      path: "rtl/top.sv",
    });
    expect(pathsReferToSameFile("rtl\\top.sv", "/repo/rtl/top.sv")).toBe(true);
  });
});
