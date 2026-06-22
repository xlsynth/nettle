// SPDX-License-Identifier: Apache-2.0

import type {
  ApiGraphEdge,
  ApiGraphGroup,
  ApiGraphNode,
  ApiGraphPort,
  ApiGraphSlice,
  ApiSourceFileRef,
  ApiSourceOrigin,
  ProjectResponse,
} from "../api/contracts";
import { RESOURCE_LIMITS } from "../generated/resource-limits";
import type { JsonValue } from "../model/graph";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const GRAPH_DECODE_LIMITS = {
  graphObjects: RESOURCE_LIMITS.bundle.protobuf.graphObjects,
  nodes: RESOURCE_LIMITS.bundle.protobuf.nodes,
  edges: RESOURCE_LIMITS.bundle.protobuf.edges,
  groups: RESOURCE_LIMITS.bundle.protobuf.groups,
  files: RESOURCE_LIMITS.bundle.protobuf.graphFiles,
  ports: RESOURCE_LIMITS.bundle.protobuf.ports,
  origins: RESOURCE_LIMITS.bundle.protobuf.origins,
  metadataEntries: RESOURCE_LIMITS.bundle.protobuf.metadataEntries,
  childNodeIds: RESOURCE_LIMITS.bundle.protobuf.nodes,
} as const;

export const DESIGN_INDEX_DECODE_LIMITS = {
  modules: RESOURCE_LIMITS.bundle.protobuf.modules,
  buildItems: RESOURCE_LIMITS.bundle.protobuf.buildItems,
} as const;

export const SOURCE_INDEX_DECODE_LIMITS = {
  sources: RESOURCE_LIMITS.bundle.protobuf.sources,
} as const;

export const DIAGNOSTICS_DECODE_LIMITS = {
  diagnostics: RESOURCE_LIMITS.bundle.protobuf.diagnostics,
} as const;

type GraphDecodeBudget = Record<
  | "objects"
  | "nodes"
  | "edges"
  | "groups"
  | "files"
  | "ports"
  | "origins"
  | "metadataEntries"
  | "childNodeIds",
  number
>;

const consumeGraphBudget = (
  budget: GraphDecodeBudget,
  key: keyof GraphDecodeBudget,
  maximum: number,
  description: string,
) => {
  const next = budget[key] + 1;
  if (next > maximum) throw new Error(`${description} exceeds the supported limit ${maximum}`);
  budget[key] = next;
};

const consumeCount = (current: number, maximum: number, description: string) => {
  const next = current + 1;
  if (next > maximum) throw new Error(`${description} exceeds the supported limit ${maximum}`);
  return next;
};

export interface BundleModuleSummary {
  id: string;
  name: string;
  definitionName: string;
  instancePath: string;
  nodeCount: number;
  edgeCount: number;
  entry: string;
}

export interface BundleNameValue {
  name: string;
  value?: string;
}

export interface BundleTool {
  name: string;
  path: string;
  version: string;
}

export interface BundleBuildMetadata {
  filelist: string;
  parameters: BundleNameValue[];
  defines: BundleNameValue[];
  undefines: string[];
  tools: BundleTool[];
}

export interface BundleDesignIndex {
  schemaMajor: number;
  schemaMinor: number;
  snapshotId: string;
  top: string;
  tops: string[];
  modules: BundleModuleSummary[];
  build?: BundleBuildMetadata;
}

export interface BundleSourceFile {
  id: string;
  path: string;
  entry: string;
  sha256: string;
  size: number;
}

export interface BundleDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  origin?: ApiSourceOrigin;
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done() {
    return this.offset === this.bytes.length;
  }

  tag(): [number, number] {
    const tag = this.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new Error("Protobuf field number 0 is invalid");
    return [field, wire];
  }

  uint32(wire: number) {
    this.expectWire(wire, 0);
    return this.varint();
  }

  uint64(wire: number) {
    this.expectWire(wire, 0);
    return this.varint();
  }

  string(wire: number) {
    const bytes = this.bytesField(wire);
    if (bytes.length > RESOURCE_LIMITS.bundle.protobuf.stringBytes) {
      throw new Error(
        `Protobuf string exceeds the supported limit ${RESOURCE_LIMITS.bundle.protobuf.stringBytes}`,
      );
    }
    return textDecoder.decode(bytes);
  }

  message<T>(wire: number, decode: (reader: ProtoReader) => T): T {
    return decode(new ProtoReader(this.bytesField(wire)));
  }

  skip(wire: number) {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.advance(8);
        return;
      case 2:
        this.advance(this.varint());
        return;
      case 5:
        this.advance(4);
        return;
      default:
        throw new Error(`Unsupported Protobuf wire type ${wire}`);
    }
  }

  private bytesField(wire: number) {
    this.expectWire(wire, 2);
    const length = this.varint();
    const start = this.offset;
    this.advance(length);
    return this.bytes.subarray(start, this.offset);
  }

  private varint() {
    let result = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error("Truncated Protobuf varint");
      const byte = this.bytes[this.offset++];
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw new Error("Protobuf integer exceeds safe range");
        return result;
      }
      multiplier *= 128;
    }
    throw new Error("Protobuf varint is too long");
  }

  private advance(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("Truncated Protobuf field");
    }
    this.offset += length;
  }

  private expectWire(actual: number, expected: number) {
    if (actual !== expected) {
      throw new Error(`Unexpected Protobuf wire type ${actual}; expected ${expected}`);
    }
  }
}

const forEachField = (reader: ProtoReader, visit: (field: number, wire: number) => void) => {
  while (!reader.done) {
    const [field, wire] = reader.tag();
    visit(field, wire);
  }
};

const decodeJsonEntry = (reader: ProtoReader): [string, JsonValue] => {
  let key = "";
  let json = "null";
  forEachField(reader, (field, wire) => {
    if (field === 1) key = reader.string(wire);
    else if (field === 2) json = reader.string(wire);
    else reader.skip(wire);
  });
  if (!key) throw new Error("Protobuf JSON metadata key is empty");
  return [key, JSON.parse(json) as JsonValue];
};

const decodeOrigin = (reader: ProtoReader): ApiSourceOrigin => {
  const origin: ApiSourceOrigin = { file: "", startLine: 0, startColumn: 0, endLine: 0 };
  forEachField(reader, (field, wire) => {
    if (field === 1) origin.file = reader.string(wire);
    else if (field === 2) origin.startLine = reader.uint32(wire);
    else if (field === 3) origin.startColumn = reader.uint32(wire);
    else if (field === 4) origin.endLine = reader.uint32(wire);
    else if (field === 5) origin.endColumn = reader.uint32(wire);
    else reader.skip(wire);
  });
  return origin;
};

const portDirections: ApiGraphPort["direction"][] = ["unknown", "input", "output", "inout"];
const nodeKinds: ApiGraphNode["kind"][] = [
  "unknown",
  "input",
  "output",
  "inout",
  "operator",
  "mux",
  "register",
  "latch",
  "memory",
  "moduleInstance",
  "constant",
  "primitive",
];

const decodePort = (reader: ProtoReader): ApiGraphPort => {
  const port: ApiGraphPort = { id: "", name: "", direction: "unknown" };
  forEachField(reader, (field, wire) => {
    if (field === 1) port.id = reader.string(wire);
    else if (field === 2) port.name = reader.string(wire);
    else if (field === 3) port.direction = portDirections[reader.uint32(wire)] ?? "unknown";
    else if (field === 4) port.index = reader.uint32(wire);
    else if (field === 5) port.role = reader.string(wire);
    else if (field === 6) port.width = reader.uint32(wire);
    else reader.skip(wire);
  });
  return port;
};

const decodeNode = (reader: ProtoReader, budget: GraphDecodeBudget): ApiGraphNode => {
  const node: ApiGraphNode = { id: "", kind: "unknown", label: "", ports: [] };
  const parameters: Record<string, JsonValue> = {};
  const attributes: Record<string, JsonValue> = {};
  const origins: ApiSourceOrigin[] = [];
  forEachField(reader, (field, wire) => {
    if (field === 1) node.id = reader.string(wire);
    else if (field === 2) node.kind = nodeKinds[reader.uint32(wire)] ?? "unknown";
    else if (field === 3) node.label = reader.string(wire);
    else if (field === 4) node.definitionName = reader.string(wire);
    else if (field === 5) {
      consumeGraphBudget(
        budget,
        "metadataEntries",
        GRAPH_DECODE_LIMITS.metadataEntries,
        "Graph metadata entry count",
      );
      const [key, value] = reader.message(wire, decodeJsonEntry);
      parameters[key] = value;
    } else if (field === 6) {
      consumeGraphBudget(
        budget,
        "metadataEntries",
        GRAPH_DECODE_LIMITS.metadataEntries,
        "Graph metadata entry count",
      );
      const [key, value] = reader.message(wire, decodeJsonEntry);
      attributes[key] = value;
    } else if (field === 7) {
      consumeGraphBudget(budget, "ports", GRAPH_DECODE_LIMITS.ports, "Graph port count");
      node.ports.push(reader.message(wire, decodePort));
    } else if (field === 8) {
      consumeGraphBudget(budget, "origins", GRAPH_DECODE_LIMITS.origins, "Graph origin count");
      origins.push(reader.message(wire, decodeOrigin));
    } else reader.skip(wire);
  });
  if (Object.keys(parameters).length) node.parameters = parameters;
  if (Object.keys(attributes).length) node.attributes = attributes;
  if (origins.length) node.origins = origins;
  return node;
};

const decodeEdge = (reader: ProtoReader, budget: GraphDecodeBudget): ApiGraphEdge => {
  const edge: ApiGraphEdge = { id: "", sourceNode: "", targetNode: "" };
  const origins: ApiSourceOrigin[] = [];
  forEachField(reader, (field, wire) => {
    if (field === 1) edge.id = reader.string(wire);
    else if (field === 2) edge.sourceNode = reader.string(wire);
    else if (field === 3) edge.sourcePort = reader.string(wire);
    else if (field === 4) edge.targetNode = reader.string(wire);
    else if (field === 5) edge.targetPort = reader.string(wire);
    else if (field === 6) edge.label = reader.string(wire);
    else if (field === 7) edge.width = reader.uint32(wire);
    else if (field === 8) edge.signalType = reader.string(wire);
    else if (field === 9) {
      consumeGraphBudget(budget, "origins", GRAPH_DECODE_LIMITS.origins, "Graph origin count");
      origins.push(reader.message(wire, decodeOrigin));
    } else reader.skip(wire);
  });
  if (origins.length) edge.origins = origins;
  return edge;
};

const decodeModule = (reader: ProtoReader, budget: GraphDecodeBudget): ApiGraphSlice["module"] => {
  const module: ApiGraphSlice["module"] = {
    id: "",
    name: "",
    instancePath: "",
    definitionName: "",
  };
  const parameters: Record<string, JsonValue> = {};
  const attributes: Record<string, JsonValue> = {};
  forEachField(reader, (field, wire) => {
    if (field === 1) module.id = reader.string(wire);
    else if (field === 2) module.name = reader.string(wire);
    else if (field === 3) module.instancePath = reader.string(wire);
    else if (field === 4) module.definitionName = reader.string(wire);
    else if (field === 5) {
      consumeGraphBudget(
        budget,
        "metadataEntries",
        GRAPH_DECODE_LIMITS.metadataEntries,
        "Graph metadata entry count",
      );
      const [key, value] = reader.message(wire, decodeJsonEntry);
      parameters[key] = value;
    } else if (field === 6) {
      consumeGraphBudget(
        budget,
        "metadataEntries",
        GRAPH_DECODE_LIMITS.metadataEntries,
        "Graph metadata entry count",
      );
      const [key, value] = reader.message(wire, decodeJsonEntry);
      attributes[key] = value;
    } else reader.skip(wire);
  });
  if (Object.keys(parameters).length) module.parameters = parameters;
  if (Object.keys(attributes).length) module.attributes = attributes;
  return module;
};

const decodeGroup = (reader: ProtoReader, budget: GraphDecodeBudget): ApiGraphGroup => {
  const group: ApiGraphGroup = {
    id: "",
    name: "",
    definitionName: "",
    childNodeIds: [],
  };
  const parameters: Record<string, JsonValue> = {};
  const origins: ApiSourceOrigin[] = [];
  forEachField(reader, (field, wire) => {
    if (field === 1) group.id = reader.string(wire);
    else if (field === 2) group.name = reader.string(wire);
    else if (field === 3) group.definitionName = reader.string(wire);
    else if (field === 4) {
      consumeGraphBudget(
        budget,
        "metadataEntries",
        GRAPH_DECODE_LIMITS.metadataEntries,
        "Graph metadata entry count",
      );
      const [key, value] = reader.message(wire, decodeJsonEntry);
      parameters[key] = value;
    } else if (field === 5) {
      consumeGraphBudget(budget, "origins", GRAPH_DECODE_LIMITS.origins, "Graph origin count");
      origins.push(reader.message(wire, decodeOrigin));
    } else if (field === 6) {
      consumeGraphBudget(
        budget,
        "childNodeIds",
        GRAPH_DECODE_LIMITS.childNodeIds,
        "Graph group child node ID count",
      );
      group.childNodeIds.push(reader.string(wire));
    } else reader.skip(wire);
  });
  if (Object.keys(parameters).length) group.parameters = parameters;
  if (origins.length) group.origins = origins;
  return group;
};

const decodeFileRef = (reader: ProtoReader): ApiSourceFileRef => {
  const file = { id: "", path: "" };
  forEachField(reader, (field, wire) => {
    if (field === 1) file.id = reader.string(wire);
    else if (field === 2) file.path = reader.string(wire);
    else reader.skip(wire);
  });
  return file;
};

export const validateGraphReferences = (slice: ApiGraphSlice) => {
  const nodes = new Map<string, Set<string>>();
  for (const node of slice.nodes) {
    const ports = new Set<string>();
    for (const port of node.ports) {
      if (ports.has(port.id))
        throw new Error(`Duplicate graph port ID ${port.id} on node ${node.id}`);
      ports.add(port.id);
    }
    if (nodes.has(node.id)) throw new Error(`Duplicate graph node ID ${node.id}`);
    nodes.set(node.id, ports);
  }

  const edgeIds = new Set<string>();
  for (const edge of slice.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate graph edge ID ${edge.id}`);
    edgeIds.add(edge.id);
    for (const [side, nodeId, portId] of [
      ["source", edge.sourceNode, edge.sourcePort],
      ["target", edge.targetNode, edge.targetPort],
    ] as const) {
      const ports = nodes.get(nodeId);
      if (!ports)
        throw new Error(`Graph edge ${edge.id} references missing ${side} node ${nodeId}`);
      if (portId !== undefined && !ports.has(portId)) {
        throw new Error(`Graph edge ${edge.id} references missing ${side} port ${portId}`);
      }
    }
  }

  const groupIds = new Set<string>();
  for (const group of slice.groups ?? []) {
    if (groupIds.has(group.id)) throw new Error(`Duplicate graph group ID ${group.id}`);
    groupIds.add(group.id);
    const children = new Set<string>();
    for (const child of group.childNodeIds) {
      if (!nodes.has(child))
        throw new Error(`Graph group ${group.id} references missing child ${child}`);
      if (children.has(child))
        throw new Error(`Graph group ${group.id} has duplicate child ${child}`);
      children.add(child);
    }
  }

  const fileIds = new Set<string>();
  const filePaths = new Set<string>();
  for (const file of slice.files ?? []) {
    if (fileIds.has(file.id) || filePaths.has(file.path)) {
      throw new Error(`Duplicate graph source reference ${file.path}`);
    }
    fileIds.add(file.id);
    filePaths.add(file.path);
  }
  for (const origin of [
    ...slice.nodes.flatMap((node) => node.origins ?? []),
    ...slice.edges.flatMap((edge) => edge.origins ?? []),
    ...(slice.groups ?? []).flatMap((group) => group.origins ?? []),
  ]) {
    if (!filePaths.has(origin.file)) {
      throw new Error(`Graph origin references unlisted source path ${origin.file}`);
    }
  }
};

export const decodeGraphSlice = (bytes: Uint8Array): ApiGraphSlice => {
  const slice: ApiGraphSlice = {
    snapshotId: "",
    module: { id: "", name: "", instancePath: "", definitionName: "" },
    nodes: [],
    edges: [],
  };
  const groups: ApiGraphGroup[] = [];
  const files: ApiSourceFileRef[] = [];
  const budget: GraphDecodeBudget = {
    objects: 0,
    nodes: 0,
    edges: 0,
    groups: 0,
    files: 0,
    ports: 0,
    origins: 0,
    metadataEntries: 0,
    childNodeIds: 0,
  };
  const reader = new ProtoReader(bytes);
  forEachField(reader, (field, wire) => {
    if (field === 1) slice.snapshotId = reader.string(wire);
    else if (field === 2)
      slice.module = reader.message(wire, (value) => decodeModule(value, budget));
    else if (field === 3) {
      consumeGraphBudget(budget, "nodes", GRAPH_DECODE_LIMITS.nodes, "Graph node count");
      consumeGraphBudget(budget, "objects", GRAPH_DECODE_LIMITS.graphObjects, "Graph object count");
      slice.nodes.push(reader.message(wire, (value) => decodeNode(value, budget)));
    } else if (field === 4) {
      consumeGraphBudget(budget, "edges", GRAPH_DECODE_LIMITS.edges, "Graph edge count");
      consumeGraphBudget(budget, "objects", GRAPH_DECODE_LIMITS.graphObjects, "Graph object count");
      slice.edges.push(reader.message(wire, (value) => decodeEdge(value, budget)));
    } else if (field === 5) {
      consumeGraphBudget(budget, "groups", GRAPH_DECODE_LIMITS.groups, "Graph group count");
      consumeGraphBudget(budget, "objects", GRAPH_DECODE_LIMITS.graphObjects, "Graph object count");
      groups.push(reader.message(wire, (value) => decodeGroup(value, budget)));
    } else if (field === 6) {
      consumeGraphBudget(budget, "files", GRAPH_DECODE_LIMITS.files, "Graph file count");
      files.push(reader.message(wire, decodeFileRef));
    } else reader.skip(wire);
  });
  if (groups.length) slice.groups = groups;
  if (files.length) slice.files = files;
  validateGraphReferences(slice);
  return slice;
};

const decodeModuleSummary = (reader: ProtoReader): BundleModuleSummary => {
  const module: BundleModuleSummary = {
    id: "",
    name: "",
    definitionName: "",
    instancePath: "",
    nodeCount: 0,
    edgeCount: 0,
    entry: "",
  };
  forEachField(reader, (field, wire) => {
    if (field === 1) module.id = reader.string(wire);
    else if (field === 2) module.name = reader.string(wire);
    else if (field === 3) module.definitionName = reader.string(wire);
    else if (field === 4) module.instancePath = reader.string(wire);
    else if (field === 5) module.nodeCount = reader.uint64(wire);
    else if (field === 6) module.edgeCount = reader.uint64(wire);
    else if (field === 7) module.entry = reader.string(wire);
    else reader.skip(wire);
  });
  return module;
};

const decodeNameValue = (reader: ProtoReader): BundleNameValue => {
  const value: BundleNameValue = { name: "" };
  forEachField(reader, (field, wire) => {
    if (field === 1) value.name = reader.string(wire);
    else if (field === 2) value.value = reader.string(wire);
    else reader.skip(wire);
  });
  return value;
};

const decodeTool = (reader: ProtoReader): BundleTool => {
  const tool: BundleTool = { name: "", path: "", version: "" };
  forEachField(reader, (field, wire) => {
    if (field === 1) tool.name = reader.string(wire);
    else if (field === 2) tool.path = reader.string(wire);
    else if (field === 3) tool.version = reader.string(wire);
    else reader.skip(wire);
  });
  return tool;
};

const decodeBuild = (reader: ProtoReader, budget: { buildItems: number }): BundleBuildMetadata => {
  const build: BundleBuildMetadata = {
    filelist: "",
    parameters: [],
    defines: [],
    undefines: [],
    tools: [],
  };
  forEachField(reader, (field, wire) => {
    if (field === 1) build.filelist = reader.string(wire);
    else if (field === 2) {
      budget.buildItems = consumeCount(
        budget.buildItems,
        DESIGN_INDEX_DECODE_LIMITS.buildItems,
        "Build metadata item count",
      );
      build.parameters.push(reader.message(wire, decodeNameValue));
    } else if (field === 3) {
      budget.buildItems = consumeCount(
        budget.buildItems,
        DESIGN_INDEX_DECODE_LIMITS.buildItems,
        "Build metadata item count",
      );
      build.defines.push(reader.message(wire, decodeNameValue));
    } else if (field === 4) {
      budget.buildItems = consumeCount(
        budget.buildItems,
        DESIGN_INDEX_DECODE_LIMITS.buildItems,
        "Build metadata item count",
      );
      build.undefines.push(reader.string(wire));
    } else if (field === 5) {
      budget.buildItems = consumeCount(
        budget.buildItems,
        DESIGN_INDEX_DECODE_LIMITS.buildItems,
        "Build metadata item count",
      );
      build.tools.push(reader.message(wire, decodeTool));
    } else reader.skip(wire);
  });
  return build;
};

export const decodeDesignIndex = (bytes: Uint8Array): BundleDesignIndex => {
  const index: BundleDesignIndex = {
    schemaMajor: 0,
    schemaMinor: 0,
    snapshotId: "",
    top: "",
    tops: [],
    modules: [],
  };
  const budget = { modules: 0, tops: 0, buildItems: 0 };
  const reader = new ProtoReader(bytes);
  forEachField(reader, (field, wire) => {
    if (field === 1) index.schemaMajor = reader.uint32(wire);
    else if (field === 2) index.schemaMinor = reader.uint32(wire);
    else if (field === 3) index.snapshotId = reader.string(wire);
    else if (field === 4) index.top = reader.string(wire);
    else if (field === 5) {
      budget.tops = consumeCount(
        budget.tops,
        DESIGN_INDEX_DECODE_LIMITS.modules,
        "Top module count",
      );
      index.tops.push(reader.string(wire));
    } else if (field === 6) {
      budget.modules = consumeCount(
        budget.modules,
        DESIGN_INDEX_DECODE_LIMITS.modules,
        "Module count",
      );
      index.modules.push(reader.message(wire, decodeModuleSummary));
    } else if (field === 7) {
      index.build = reader.message(wire, (value) => decodeBuild(value, budget));
    } else reader.skip(wire);
  });
  return index;
};

const decodeSourceFile = (reader: ProtoReader): BundleSourceFile => {
  const file: BundleSourceFile = { id: "", path: "", entry: "", sha256: "", size: 0 };
  forEachField(reader, (field, wire) => {
    if (field === 1) file.id = reader.string(wire);
    else if (field === 2) file.path = reader.string(wire);
    else if (field === 3) file.entry = reader.string(wire);
    else if (field === 4) file.sha256 = reader.string(wire);
    else if (field === 5) file.size = reader.uint64(wire);
    else reader.skip(wire);
  });
  return file;
};

export const decodeSourceIndex = (bytes: Uint8Array): BundleSourceFile[] => {
  const files: BundleSourceFile[] = [];
  const reader = new ProtoReader(bytes);
  forEachField(reader, (field, wire) => {
    if (field === 1) {
      if (files.length >= SOURCE_INDEX_DECODE_LIMITS.sources) {
        throw new Error(
          `Source count exceeds the supported limit ${SOURCE_INDEX_DECODE_LIMITS.sources}`,
        );
      }
      files.push(reader.message(wire, decodeSourceFile));
    } else reader.skip(wire);
  });
  return files;
};

const decodeDiagnostic = (reader: ProtoReader): BundleDiagnostic => {
  const diagnostic: BundleDiagnostic = { severity: "info", message: "" };
  forEachField(reader, (field, wire) => {
    if (field === 1) {
      diagnostic.severity = (["info", "warning", "error"] as const)[reader.uint32(wire)] ?? "info";
    } else if (field === 2) diagnostic.message = reader.string(wire);
    else if (field === 3) diagnostic.origin = reader.message(wire, decodeOrigin);
    else reader.skip(wire);
  });
  return diagnostic;
};

export const decodeDiagnostics = (bytes: Uint8Array): BundleDiagnostic[] => {
  const diagnostics: BundleDiagnostic[] = [];
  const reader = new ProtoReader(bytes);
  forEachField(reader, (field, wire) => {
    if (field === 1) {
      if (diagnostics.length >= DIAGNOSTICS_DECODE_LIMITS.diagnostics) {
        throw new Error(
          `Diagnostic count exceeds the supported limit ${DIAGNOSTICS_DECODE_LIMITS.diagnostics}`,
        );
      }
      diagnostics.push(reader.message(wire, decodeDiagnostic));
    } else reader.skip(wire);
  });
  return diagnostics;
};

export const projectResponseFromBundle = (
  index: BundleDesignIndex,
  diagnostics: BundleDiagnostic[],
): ProjectResponse => ({
  schemaVersion: index.schemaMajor,
  status: diagnostics.some((item) => item.severity === "error") ? "errors" : "ready",
  snapshotId: index.snapshotId,
  projectRoot: "",
  filelist: index.build?.filelist,
  top: index.top,
  tops: index.tops,
  modules: index.modules.map((module) => ({
    id: module.id,
    name: module.name,
    definitionName: module.definitionName,
    instancePath: module.instancePath,
    nodeCount: module.nodeCount,
    edgeCount: module.edgeCount,
  })),
  diagnostics,
  inputMode: "bundle",
  tools: index.build?.tools ?? [],
  elaboration: {
    parameters:
      index.build?.parameters.flatMap(({ name, value }) =>
        value === undefined ? [] : [{ name, value }],
      ) ?? [],
    defines: index.build?.defines ?? [],
    undefines: index.build?.undefines ?? [],
  },
  effectiveElaboration: {
    parameters:
      index.build?.parameters.flatMap(({ name, value }) =>
        value === undefined ? [] : [{ name, value }],
      ) ?? [],
    defines: index.build?.defines ?? [],
    undefines: index.build?.undefines ?? [],
  },
});
