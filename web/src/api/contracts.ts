// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "../model/graph";

export interface ApiSourceOrigin {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn?: number;
}

export interface ApiSourceElaborationRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  active: boolean;
}

export type ApiNodeKind =
  | "input"
  | "output"
  | "inout"
  | "operator"
  | "mux"
  | "register"
  | "latch"
  | "memory"
  | "moduleInstance"
  | "constant"
  | "primitive"
  | "unknown";

export type ApiPortDirection = "input" | "output" | "inout" | "unknown";

export interface ApiGraphPort {
  id: string;
  name: string;
  direction: ApiPortDirection;
  index?: number;
  role?: string;
  width?: number;
}

export interface ApiGraphNode {
  id: string;
  kind: ApiNodeKind;
  label: string;
  definitionName?: string;
  parameters?: Record<string, JsonValue>;
  attributes?: Record<string, JsonValue>;
  ports: ApiGraphPort[];
  origins?: ApiSourceOrigin[];
}

export interface ApiGraphEdge {
  id: string;
  sourceNode: string;
  sourcePort?: string;
  targetNode: string;
  targetPort?: string;
  label?: string;
  width?: number;
  signalType?: string;
  origins?: ApiSourceOrigin[];
}

export interface ApiGraphGroup {
  id: string;
  name: string;
  definitionName: string;
  parameters?: Record<string, JsonValue>;
  origins?: ApiSourceOrigin[];
  childNodeIds: string[];
}

export interface ApiSourceFileRef {
  id: string;
  path: string;
}

export interface ApiGraphSlice {
  snapshotId: string;
  module: {
    id: string;
    name: string;
    instancePath: string;
    definitionName: string;
    parameters?: Record<string, JsonValue>;
    attributes?: Record<string, JsonValue>;
  };
  nodes: ApiGraphNode[];
  edges: ApiGraphEdge[];
  groups?: ApiGraphGroup[];
  files?: ApiSourceFileRef[];
}

export interface GraphSliceRequest {
  snapshotId?: string;
  moduleId?: string;
  moduleName?: string;
  instancePath?: string;
  transparentInstanceIds?: string[];
  flattenDepth?: number;
  budget?: number;
}

export interface TokenOrigin {
  file: string;
  line: number;
  column: number;
  token: string;
}

export interface NormalizedProject {
  rootFilelist: string;
  sources: Array<{ path: string; origin: TokenOrigin }>;
  includeDirectories: Array<{ path: string; origin: TokenOrigin }>;
  libraryDirectories: Array<{ path: string; origin: TokenOrigin }>;
  libraryFiles: Array<{ path: string; origin: TokenOrigin }>;
  defines: Array<{ name: string; value?: string; origin: TokenOrigin }>;
  undefines: Array<{ name: string; origin: TokenOrigin }>;
  parameters: Array<{ name: string; value: string; origin: TokenOrigin }>;
  language?: string;
  top?: string;
  unknownArguments: Array<{ kind: string; value: string; origin: TokenOrigin }>;
  arguments: Array<{ kind: string; value: string; origin: TokenOrigin }>;
}

export interface ProjectResponse {
  schemaVersion: number;
  status: string;
  snapshotId: string;
  projectRoot: string;
  filelist?: string;
  top: string;
  tops: string[];
  modules: Array<{
    id: string;
    name: string;
    definitionName: string;
    instancePath: string;
    nodeCount: number;
    edgeCount: number;
  }>;
  diagnostics: Array<{
    severity: "info" | "warning" | "error";
    message: string;
    origin?: ApiSourceOrigin;
  }>;
  inputMode?: "fixture" | "cachedArtifacts" | "externalCompilers" | "bundle";
  yosysJson?: string;
  slangAstJson?: string;
  tools?: Array<{ name: string; path: string; version: string }>;
  normalizedProject?: NormalizedProject;
  elaboration?: {
    parameters: Array<{ name: string; value: string }>;
    defines: Array<{ name: string; value?: string }>;
    undefines: string[];
  };
  effectiveElaboration?: {
    parameters: Array<{ name: string; value: string }>;
    defines: Array<{ name: string; value?: string }>;
    undefines: string[];
  };
}

export interface LoadProjectRequest {
  filelist?: string;
  yosysJson?: string;
  slangAstJson?: string;
  projectRoot?: string;
  top: string;
  parameters?: Array<{ name: string; value: string }>;
  defines?: Array<{ name: string; value?: string }>;
  undefines?: string[];
}

export interface ApiTreeEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  fileId?: string;
  children?: ApiTreeEntry[];
}

export interface TreeResponse {
  root: string;
  entries: ApiTreeEntry[];
}

export interface SourceResponse {
  fileId: string;
  path: string;
  version: string;
  content: string;
  elaborationRanges: ApiSourceElaborationRange[];
}

/** Metadata available without loading a bundled source file's contents. */
export interface SourceInventoryEntry {
  id: string;
  path: string;
  sha256: string;
  size: number;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: JsonValue;
  };
}
