// SPDX-License-Identifier: Apache-2.0

export type NodeKind =
  | "operator"
  | "module"
  | "register"
  | "latch"
  | "mux"
  | "memory"
  | "constant"
  | "input"
  | "output"
  | "inout"
  | "primitive"
  | "unknown";

export type PortDirection = "input" | "output" | "inout";

export interface SourceOrigin {
  file: string;
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
  role?: string;
  quality?: "exact" | "inherited" | "macro" | "synthetic";
}

export interface SourceElaborationRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  active: boolean;
}

export interface GraphPort {
  id: string;
  name: string;
  direction: PortDirection;
  index?: number;
  role?: "data" | "clock" | "reset" | "enable" | "select";
  width?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  glyph?: string;
  definitionName?: string;
  parameters?: Record<string, JsonValue>;
  ports: GraphPort[];
  origins?: SourceOrigin[];
  transparent?: boolean;
  metadata?: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  sourceNode: string;
  sourcePort?: string;
  targetNode: string;
  targetPort?: string;
  label?: string;
  width?: number;
  signalType?: string;
  role?: "data" | "clock" | "reset" | "control";
  origins?: SourceOrigin[];
}

export interface GraphGroup {
  id: string;
  name: string;
  definitionName: string;
  parameters: Record<string, JsonValue>;
  origins?: SourceOrigin[];
  childNodeIds: string[];
}

export interface ModuleContext {
  id: string;
  name: string;
  instancePath: string;
  definitionName: string;
  parameters: Record<string, JsonValue>;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SourceFileRef {
  id: string;
  path: string;
}

export interface GraphSlice {
  snapshotId: string;
  module: ModuleContext;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
  files?: SourceFileRef[];
}

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  fileId?: string;
  children?: FileTreeEntry[];
}

export interface ProjectSnapshot {
  name: string;
  projectRoot: string;
  filelist: string;
  yosysJson: string;
  slangAstJson: string;
  bundleStatus: string;
  snapshotId: string;
  files: FileTreeEntry[];
  defines: Array<{ name: string; value?: string; origin: string }>;
  elaboration: {
    parameters: Array<{ name: string; value: string }>;
    defines: Array<{ name: string; value?: string }>;
    undefines: string[];
  };
  effectiveElaboration: {
    parameters: Array<{ name: string; value: string }>;
    defines: Array<{ name: string; value?: string }>;
    undefines: string[];
  };
  inputMode?: "fixture" | "cachedArtifacts" | "externalCompilers" | "bundle";
  tools: Array<{ name: string; path: string; version: string }>;
}
