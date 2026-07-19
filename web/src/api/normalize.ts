// SPDX-License-Identifier: Apache-2.0

import type {
  FileTreeEntry,
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphPort,
  GraphSlice,
  NodeKind,
  ProjectSnapshot,
  SourceFileRef,
  SourceOrigin,
} from "../model/graph";
import type {
  ApiGraphNode,
  ApiGraphSlice,
  ApiPortDirection,
  ApiSourceOrigin,
  ApiTreeEntry,
  ProjectResponse,
  SourceResponse,
  TreeResponse,
} from "./contracts";

const OPERATOR_NAMES: Record<string, string> = {
  "+": "Add",
  "−": "Subtract",
  "^": "Exclusive or",
  "~^": "Exclusive nor",
  NAND: "Nand",
  NOR: "Nor",
  "&": "And",
  "&&": "Logical and",
  "|": "Or",
  "||": "Logical or",
  "≥1": "Or",
  "≠0": "Boolean reduction",
  "~": "Bitwise not",
  "!": "Logical not",
  "≪": "Shift left",
  "≫": "Shift right",
  "×": "Multiply",
  "÷": "Divide",
  "%": "Modulo",
  "⇆": "Dynamic shift",
  "**": "Power",
  "==": "Equal",
  "!=": "Not equal",
  "<": "Less than",
  "≤": "Less than or equal",
  ">": "Greater than",
  "≥": "Greater than or equal",
  "→": "Buffer",
  "{}": "Concatenate",
  "[]": "Slice",
};

const normalizeNodeKind = (kind: ApiGraphNode["kind"]): NodeKind =>
  kind === "moduleInstance" ? "module" : kind;

const normalizeDirection = (direction: ApiPortDirection): GraphPort["direction"] =>
  direction === "unknown" ? "inout" : direction;

const normalizeRole = (role?: string): GraphPort["role"] => {
  switch (role) {
    case "clock":
    case "reset":
    case "enable":
    case "select":
    case "data":
      return role;
    default:
      return undefined;
  }
};

const normalizeOrigin = (origin: ApiSourceOrigin): SourceOrigin => ({
  file: normalizePath(origin.file),
  startLine: origin.startLine,
  startColumn: origin.startColumn,
  endLine: origin.endLine,
  endColumn: origin.endColumn,
});

const normalizeNode = (node: ApiGraphNode): GraphNode => {
  const kind = normalizeNodeKind(node.kind);
  const glyph = kind === "operator" ? node.label : undefined;
  return {
    id: node.id,
    kind,
    label: glyph ? (OPERATOR_NAMES[glyph] ?? `Operator ${glyph}`) : node.label,
    glyph,
    definitionName: node.definitionName,
    parameters: node.parameters,
    ports: node.ports.map((port) => ({
      id: port.id,
      name: port.name,
      direction: normalizeDirection(port.direction),
      index: port.index,
      role: normalizeRole(port.role),
      width: port.width,
    })),
    origins: node.origins?.map(normalizeOrigin),
  };
};

const roleForEdge = (
  edge: GraphEdge,
  roles: ReadonlyMap<string, GraphPort["role"]>,
): GraphEdge["role"] => {
  const sourceRole = edge.sourcePort
    ? roles.get(`${edge.sourceNode}:${edge.sourcePort}`)
    : undefined;
  const targetRole = edge.targetPort
    ? roles.get(`${edge.targetNode}:${edge.targetPort}`)
    : undefined;
  const role = sourceRole ?? targetRole;
  if (role === "clock" || role === "reset") return role;
  if (role === "enable" || role === "select") return "control";
  return "data";
};

export const normalizeGraphSlice = (slice: ApiGraphSlice): GraphSlice => {
  const nodes = slice.nodes.map(normalizeNode);
  const portRoles = nodes
    .flatMap((node) => node.ports.map((port) => [`${node.id}:${port.id}`, port.role] as const))
    .reduce((map, [key, role]) => map.set(key, role), new Map<string, GraphPort["role"]>());
  const edges = slice.edges.map((edge) => {
    const normalized: GraphEdge = {
      id: edge.id,
      sourceNode: edge.sourceNode,
      sourcePort: edge.sourcePort,
      targetNode: edge.targetNode,
      targetPort: edge.targetPort,
      label: edge.label,
      width: edge.width,
      ...(edge.signalType ? { signalType: edge.signalType } : {}),
      origins: edge.origins?.map(normalizeOrigin),
    };
    normalized.role = roleForEdge(normalized, portRoles);
    return normalized;
  });
  const groups: GraphGroup[] = (slice.groups ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    definitionName: group.definitionName,
    parameters: group.parameters ?? {},
    origins: group.origins?.map(normalizeOrigin),
    childNodeIds: group.childNodeIds,
  }));
  return {
    snapshotId: slice.snapshotId,
    module: {
      id: slice.module.id,
      name: slice.module.name,
      instancePath: slice.module.instancePath,
      definitionName: slice.module.definitionName,
      parameters: slice.module.parameters ?? {},
    },
    nodes,
    edges,
    groups,
    files: slice.files?.map((file) => ({ ...file, path: normalizePath(file.path) })),
    elaborationRanges: slice.elaborationRanges?.map((range) => ({
      ...range,
      file: normalizePath(range.file),
    })),
  };
};

const normalizeTreeEntry = (entry: ApiTreeEntry): FileTreeEntry => ({
  name: entry.name,
  path: normalizePath(entry.path),
  kind: entry.kind,
  fileId: entry.fileId,
  children: entry.children?.map(normalizeTreeEntry),
});

export const normalizeTree = (tree: TreeResponse): FileTreeEntry[] =>
  tree.entries.map(normalizeTreeEntry);

const basename = (path: string) => normalizePath(path).split("/").filter(Boolean).at(-1) ?? path;

const projectRelative = (path: string, root: string) => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : basename(normalizedPath);
};

export const normalizeProject = (
  response: ProjectResponse,
  tree: TreeResponse,
): ProjectSnapshot => {
  const filelist = response.filelist ?? response.normalizedProject?.rootFilelist ?? "";
  return {
    name: filelist
      ? basename(filelist)
      : response.yosysJson
        ? basename(response.yosysJson)
        : basename(response.projectRoot) || response.top,
    projectRoot: normalizePath(response.projectRoot),
    filelist,
    yosysJson: response.yosysJson ?? "",
    slangAstJson: response.slangAstJson ?? "",
    bundleStatus: response.status === "ready" ? "Bundle ready" : "Bundle has errors",
    snapshotId: response.snapshotId,
    files: normalizeTree(tree),
    defines:
      response.normalizedProject?.defines.map((define) => ({
        name: define.name,
        value: define.value,
        origin: `${projectRelative(define.origin.file, response.projectRoot)}:${define.origin.line}:${define.origin.column}`,
      })) ?? [],
    elaboration: response.elaboration ?? { parameters: [], defines: [], undefines: [] },
    effectiveElaboration: response.effectiveElaboration ??
      response.elaboration ?? { parameters: [], defines: [], undefines: [] },
    inputMode: response.inputMode,
    tools: response.tools ?? [],
  };
};

export const normalizePath = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");

export const pathsReferToSameFile = (left: string, right: string) => {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
};

/**
 * Resolves an exact path first, then a suffix match only when it identifies one
 * candidate. Compiler origins frequently omit a project prefix, but a shared
 * basename must never be resolved by input ordering.
 */
export const findUniquePathMatch = <T>(
  values: Iterable<T>,
  path: string,
  candidatePath: (value: T) => string,
): T | undefined => {
  const entries = [...values];
  const normalized = normalizePath(path);
  const exact = entries.filter((value) => normalizePath(candidatePath(value)) === normalized);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const suffix = entries.filter((value) => pathsReferToSameFile(path, candidatePath(value)));
  return suffix.length === 1 ? suffix[0] : undefined;
};

const flattenTreeFiles = (entries: FileTreeEntry[]): SourceFileRef[] =>
  entries.flatMap((entry): SourceFileRef[] => {
    if (entry.kind === "file") return entry.fileId ? [{ id: entry.fileId, path: entry.path }] : [];
    return flattenTreeFiles(entry.children ?? []);
  });

export const findSourceReference = (
  path: string,
  slice: GraphSlice,
  tree: FileTreeEntry[],
): SourceFileRef | undefined =>
  [...(slice.files ?? []), ...flattenTreeFiles(tree)].find((file) =>
    pathsReferToSameFile(file.path, path),
  );

export const firstSourceReference = (
  slice: GraphSlice,
  tree: FileTreeEntry[],
): SourceFileRef | undefined => {
  const origin = [...slice.nodes, ...slice.edges, ...(slice.groups ?? [])].flatMap(
    (entity) => entity.origins ?? [],
  )[0];
  if (origin) {
    const reference = findSourceReference(origin.file, slice, tree);
    if (reference) return reference;
  }
  if (slice.files?.[0]) return slice.files[0];
  return flattenTreeFiles(tree).find((file) => /\.(?:sv|svh|v|vh)$/i.test(file.path));
};

export interface LoadedWorkspace {
  project: ProjectSnapshot;
  slice: GraphSlice;
  source?: SourceResponse;
  sourceError?: string;
}
