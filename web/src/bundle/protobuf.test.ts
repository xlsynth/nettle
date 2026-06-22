// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ApiGraphSlice } from "../api/contracts";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import {
  DESIGN_INDEX_DECODE_LIMITS,
  DIAGNOSTICS_DECODE_LIMITS,
  decodeDesignIndex,
  decodeDiagnostics,
  decodeGraphSlice,
  decodeSourceIndex,
  GRAPH_DECODE_LIMITS,
  SOURCE_INDEX_DECODE_LIMITS,
  validateGraphReferences,
} from "./protobuf";

const varint = (input: number) => {
  const bytes: number[] = [];
  let value = input;
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
};

const message = (field: number, payload: Uint8Array) => {
  const tag = varint((field << 3) | 2);
  const length = varint(payload.length);
  const bytes = new Uint8Array(tag.length + length.length + payload.length);
  bytes.set(tag);
  bytes.set(length, tag.length);
  bytes.set(payload, tag.length + length.length);
  return bytes;
};

const repeatedEmptyMessages = (field: number, count: number) => {
  const tag = (field << 3) | 2;
  const bytes = new Uint8Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    bytes[index * 2] = tag;
    bytes[index * 2 + 1] = 0;
  }
  return bytes;
};

const graphSlice = (): ApiGraphSlice => ({
  snapshotId: "snapshot",
  module: { id: "module", name: "top", instancePath: "top", definitionName: "top" },
  nodes: [
    {
      id: "node",
      kind: "operator",
      label: "node",
      ports: [{ id: "port", name: "port", direction: "input" }],
    },
  ],
  edges: [],
});

describe("incremental GraphSlice resource limits", () => {
  it("rejects nested ports while decoding a graph node", () => {
    const node = repeatedEmptyMessages(7, GRAPH_DECODE_LIMITS.ports + 1);
    expect(() => decodeGraphSlice(message(3, node))).toThrow(
      "Graph port count exceeds the supported limit",
    );
  });

  it("preserves ordinary small graphs", () => {
    const node = repeatedEmptyMessages(7, 1);
    expect(decodeGraphSlice(message(3, node)).nodes[0].ports).toHaveLength(1);
  });

  it("rejects group child node IDs while decoding", () => {
    const group = repeatedEmptyMessages(6, GRAPH_DECODE_LIMITS.childNodeIds + 1);
    expect(() => decodeGraphSlice(message(5, group))).toThrow(
      "Graph group child node ID count exceeds the supported limit",
    );
  });
});

describe("GraphSlice reference validation", () => {
  it("rejects duplicate graph identities", () => {
    const slice = graphSlice();
    slice.nodes.push(structuredClone(slice.nodes[0]));
    expect(() => validateGraphReferences(slice)).toThrow("Duplicate graph node ID");
  });

  it("rejects dangling edge endpoints", () => {
    const slice = graphSlice();
    slice.edges.push({ id: "edge", sourceNode: "node", sourcePort: "missing", targetNode: "node" });
    expect(() => validateGraphReferences(slice)).toThrow("references missing source port");
  });

  it("rejects dangling and duplicate group children", () => {
    const missing = graphSlice();
    missing.groups = [
      { id: "group", name: "g", definitionName: "child", childNodeIds: ["missing"] },
    ];
    expect(() => validateGraphReferences(missing)).toThrow("references missing child");

    const duplicate = graphSlice();
    duplicate.groups = [
      { id: "group", name: "g", definitionName: "child", childNodeIds: ["node", "node"] },
    ];
    expect(() => validateGraphReferences(duplicate)).toThrow("has duplicate child");
  });
});

describe("incremental DesignIndex resource limits", () => {
  it("rejects module summaries while decoding", () => {
    const bytes = repeatedEmptyMessages(6, DESIGN_INDEX_DECODE_LIMITS.modules + 1);
    expect(() => decodeDesignIndex(bytes)).toThrow("Module count exceeds the supported limit");
  });

  it("preserves ordinary module summaries", () => {
    expect(decodeDesignIndex(repeatedEmptyMessages(6, 2)).modules).toHaveLength(2);
  });

  it("rejects top names while decoding", () => {
    const bytes = repeatedEmptyMessages(5, DESIGN_INDEX_DECODE_LIMITS.modules + 1);
    expect(() => decodeDesignIndex(bytes)).toThrow("Top module count exceeds the supported limit");
  });
});

describe("incremental SourceIndex resource limits", () => {
  it("rejects source records while decoding", () => {
    const bytes = repeatedEmptyMessages(1, SOURCE_INDEX_DECODE_LIMITS.sources + 1);
    expect(() => decodeSourceIndex(bytes)).toThrow("Source count exceeds the supported limit");
  });

  it("preserves ordinary source records", () => {
    expect(decodeSourceIndex(repeatedEmptyMessages(1, 2))).toHaveLength(2);
  });

  it("rejects strings larger than the shared bundle limit", () => {
    const oversizedPath = new Uint8Array(RESOURCE_LIMITS.bundle.protobuf.stringBytes + 1);
    const source = message(2, oversizedPath);
    expect(() => decodeSourceIndex(message(1, source))).toThrow(
      "Protobuf string exceeds the supported limit",
    );
  });
});

describe("incremental diagnostics resource limits", () => {
  it("rejects diagnostic records while decoding", () => {
    const bytes = repeatedEmptyMessages(1, DIAGNOSTICS_DECODE_LIMITS.diagnostics + 1);
    expect(() => decodeDiagnostics(bytes)).toThrow("Diagnostic count exceeds the supported limit");
  });

  it("preserves ordinary diagnostics", () => {
    expect(decodeDiagnostics(repeatedEmptyMessages(1, 2))).toHaveLength(2);
  });
});
