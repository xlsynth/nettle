// SPDX-License-Identifier: Apache-2.0

import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Focus,
  GitCompareArrows,
  Home,
  Info,
  Layers3,
  ListFilter,
  Minus,
  Plus,
  Radio,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComparisonSlice } from "../comparison/types";
import {
  type DiffStatus,
  diffStatusLabel,
  type EntityDiffPresentation,
  type SchematicComparisonPresentation,
  schematicDiffStatusDescription,
} from "../components/comparison-types";
import { formatJsonValue } from "../model/format";
import type { GraphEdge, GraphSlice, ModuleContext } from "../model/graph";
import {
  type CameraBounds,
  type CameraViewBox,
  cameraFocusedOnBounds,
  cameraTransform,
  cameraViewBoxForBounds,
  constrainedCameraSize,
  panCameraByScreenDelta,
  resizeCameraAt,
  unionCameraBounds,
  wheelZoomFactor,
} from "./camera";
import { type ConstantRadix, formatConstantLiteral } from "./constant-format";
import { TOP_MODULE_ID } from "./constants";
import { gateHasInversion, type LogicGateKind, logicGateKind } from "./gate-symbol";
import { LAYOUT_PROFILE_OPTIONS, type LayoutProfile } from "./layout-profile";
import type {
  EdgeSection,
  FlattenRenderMode,
  LayoutEdge,
  LayoutGroup,
  LayoutNode,
  LayoutResult,
  Point,
} from "./layout-types";
import {
  controlSignalKey,
  controlSignalRole,
  detectedControlSignals,
  shortModuleName,
} from "./presentation";
import { useLayout } from "./use-layout";

export { TOP_MODULE_ID } from "./constants";

export interface LabelSettings {
  nets: boolean;
  signalTypes: boolean;
  bitWidths: boolean;
  instances: boolean;
  definitions: boolean;
}

interface SchematicCanvasProps {
  slice: GraphSlice;
  selectedId?: string;
  focusEntityId?: string;
  focusEntityRevision?: number;
  onSelect: (id: string) => void;
  onHover?: (id: string | undefined) => void;
  onOpenInstance: (id: string) => void;
  canGoUp: boolean;
  onGoUp: () => void;
  onGoTop: () => void;
  labelSettings: LabelSettings;
  onToggleLabel: (key: keyof LabelSettings) => void;
  flattenDepth: number;
  onFlattenDepthChange: (depth: number) => void;
  flattenRenderMode: FlattenRenderMode;
  onFlattenRenderModeChange: (mode: FlattenRenderMode) => void;
  layoutProfile: LayoutProfile;
  onLayoutProfileChange: (profile: LayoutProfile) => void;
  constantRadix: ConstantRadix;
  onConstantRadixChange: (radix: ConstantRadix) => void;
  onFlattenInstance: (id: string) => void;
  onRestoreInstance: () => void;
  individuallyFlattened: boolean;
  topLevelDefines: Array<{ name: string; value?: string }>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  comparison?: SchematicComparisonPresentation;
  warnings?: readonly string[];
  busy?: boolean;
}

type DiffVisibility = Record<DiffStatus, boolean>;
type DiffPreset = "reference" | "overlay" | "candidate" | "changes" | "custom";
type NamedDiffPreset = Exclude<DiffPreset, "custom">;

const DIFF_PRESET_LABELS: Record<DiffPreset, string> = {
  reference: "Reference snapshot",
  overlay: "Diff overlay",
  candidate: "Candidate snapshot",
  changes: "Changes only",
  custom: "Custom overlay",
};

const DIFF_PRESET_DESCRIPTIONS: Record<NamedDiffPreset, string> = {
  reference: "Reference payloads with candidate-only objects hidden and no diff decoration.",
  overlay: "The complete union with removed, added, and modified objects highlighted.",
  candidate: "Candidate payloads with reference-only objects hidden and no diff decoration.",
  changes: "The diff overlay restricted to changes and the connectivity needed to understand them.",
};

const ALL_DIFF_STATUSES: readonly DiffStatus[] = ["unchanged", "removed", "added", "modified"];

const defaultDiffVisibility = (): DiffVisibility => ({
  unchanged: true,
  removed: true,
  added: true,
  modified: true,
});

const diffClassName = (
  metadata: EntityDiffPresentation | undefined,
  visibility: DiffVisibility,
  contextVisible = false,
  emphasizeDifference = true,
) => {
  const status = metadata?.status ?? "unchanged";
  const visualStatus = emphasizeDifference ? status : "unchanged";
  return ` diff-${visualStatus}${
    emphasizeDifference && metadata?.matchMethod === "heuristic" ? " diff-heuristic" : ""
  }${
    metadata?.sourceHighlighted ? " source-cross-probed" : ""
  }${contextVisible ? " diff-context" : ""}${visibility[status] || contextVisible ? "" : " diff-filtered"}`;
};

const diffMarker = (metadata: EntityDiffPresentation | undefined, emphasizeDifference = true) => {
  if (!emphasizeDifference) return "";
  const status = metadata?.status ?? "unchanged";
  const marker =
    status === "added" ? "+" : status === "removed" ? "−" : status === "modified" ? "±" : "";
  return `${marker}${metadata?.matchMethod === "heuristic" ? "≈" : ""}`;
};

type ComparisonSemanticSide = "reference" | "candidate";

const semanticSideForPreset = (preset: DiffPreset): ComparisonSemanticSide | undefined =>
  preset === "reference" || preset === "candidate" ? preset : undefined;

const portComparisonKey = (nodeId: string, portId: string) => `${nodeId}\u0000${portId}`;

/**
 * Applies one snapshot's semantic payload to immutable union geometry. This is
 * deliberately downstream of layout so changing a view preset cannot move any
 * object or reroute any edge.
 */
const layoutForComparisonSide = (
  layout: LayoutResult,
  comparison: ComparisonSlice | undefined,
  side: ComparisonSemanticSide | undefined,
): LayoutResult => {
  if (!comparison || !side) return layout;
  const nodes = new Map(comparison.nodes.map((entity) => [entity.id, entity]));
  const ports = new Map(
    comparison.ports.map((entity) => [portComparisonKey(entity.nodeId, entity.id), entity]),
  );
  const edges = new Map(comparison.edges.map((entity) => [entity.id, entity]));
  const groups = new Map(comparison.groups.map((entity) => [entity.id, entity]));
  return {
    ...layout,
    nodes: layout.nodes.map((node) => {
      const semantic = nodes.get(node.id)?.[side];
      const semanticPorts = node.ports.flatMap((port) => {
        const comparisonPort = ports.get(portComparisonKey(node.id, port.id));
        if (!comparisonPort) return [port];
        const semanticPort = comparisonPort[side];
        if (!semanticPort) return [];
        return [
          {
            ...port,
            name: semanticPort.name,
            direction: semanticPort.direction,
            index: semanticPort.index,
            role: semanticPort.role,
            bitWidth: semanticPort.width,
          },
        ];
      });
      if (!semantic) return { ...node, ports: semanticPorts };
      return {
        ...node,
        kind: semantic.kind,
        label: semantic.label,
        glyph: semantic.glyph,
        definitionName: semantic.definitionName,
        parameters: semantic.parameters,
        origins: semantic.origins,
        transparent: semantic.transparent,
        metadata: semantic.metadata,
        ports: semanticPorts,
      };
    }),
    edges: layout.edges.map((edge) => {
      const semantic = edges.get(edge.id)?.[side];
      return semantic
        ? {
            ...edge,
            label: semantic.label,
            width: semantic.width,
            signalType: semantic.signalType,
            role: semantic.role,
            origins: semantic.origins,
          }
        : edge;
    }),
    groups: layout.groups.map((group) => {
      const semantic = groups.get(group.id)?.[side];
      return semantic
        ? {
            ...group,
            name: semantic.name,
            definitionName: semantic.definitionName,
            parameters: semantic.parameters,
            origins: semantic.origins,
          }
        : group;
    }),
  };
};

const moduleForComparisonSide = (
  fallback: ModuleContext,
  comparison: ComparisonSlice | undefined,
  side: ComparisonSemanticSide | undefined,
) => (comparison && side ? comparison[side].module : fallback);

const pointsForSection = (section: EdgeSection): Point[] => [
  section.startPoint,
  ...section.bendPoints,
  section.endPoint,
];

const pathForSections = (sections: EdgeSection[]) =>
  sections
    .map((section) => {
      const points = pointsForSection(section);
      return points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
        .join(" ");
    })
    .join(" ");

const labelPoint = (edge: LayoutEdge): Point | null => {
  let best: { length: number; point: Point } | null = null;
  for (const section of edge.sections) {
    const points = pointsForSection(section);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const horizontal = Math.abs(current.y - previous.y) < 0.5;
      const length = horizontal ? Math.abs(current.x - previous.x) : 0;
      if (!best || length > best.length) {
        best = {
          length,
          point: { x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2 },
        };
      }
    }
  }
  return best?.point ?? null;
};

const getHighlighted = (selectedId: string | undefined, edges: GraphEdge[]) => {
  const nodes = new Set<string>();
  const highlightedEdges = new Set<string>();
  if (!selectedId) return { nodes, edges: highlightedEdges };
  nodes.add(selectedId);
  for (const edge of edges) {
    if (
      edge.id === selectedId ||
      edge.sourceNode === selectedId ||
      edge.targetNode === selectedId
    ) {
      highlightedEdges.add(edge.id);
      nodes.add(edge.sourceNode);
      nodes.add(edge.targetNode);
    }
  }
  return { nodes, edges: highlightedEdges };
};

const isZeroParameter = (value: unknown): boolean =>
  value === 0 ||
  value === false ||
  (typeof value === "string" && value.length > 0 && [...value].every((digit) => digit === "0"));

const isActiveLowReset = (node: LayoutNode, port: LayoutNode["ports"][number]): boolean => {
  if (port.role !== "reset") return false;
  const polarityName = `${port.name.trim().replace(/^\\/, "").toUpperCase()}_POLARITY`;
  const entry = Object.entries(node.parameters ?? {}).find(
    ([name]) => name.toUpperCase() === polarityName,
  );
  return entry ? isZeroParameter(entry[1]) : false;
};

interface NodeShapeProps {
  node: LayoutNode;
  selected: boolean;
  hovered: boolean;
  labelSettings: LabelSettings;
  constantRadix: ConstantRadix;
}

const ORDERED_BINARY_GLYPHS = new Set([
  "−",
  "-",
  "÷",
  "%",
  "**",
  "≪",
  "<<",
  "≫",
  ">>",
  "⇆",
  "<",
  "≤",
  "<=",
  ">",
  "≥",
  ">=",
]);

const numericPortName = (name: string) => (/^\d+$/.test(name.trim()) ? name.trim() : undefined);

const namedOperandIndex = (name: string) => {
  switch (name.trim().toUpperCase()) {
    case "A":
      return 0;
    case "B":
      return 1;
    default:
      return undefined;
  }
};

interface LogicGateShapeProps {
  kind: LogicGateKind;
  width: number;
  height: number;
  inputYs: number[];
  selected: boolean;
  hovered: boolean;
}

const LogicGateShape = memo(function LogicGateShape({
  kind,
  width,
  height,
  inputYs,
  selected,
  hovered,
}: LogicGateShapeProps) {
  const top = 5;
  const bottom = height - 5;
  const middle = height / 2;
  const left = 8;
  const inverted = gateHasInversion(kind);
  const bodyRight = inverted ? width - 16 : width - 8;
  const bubbleRadius = 4;
  const bubbleX = bodyRight + bubbleRadius;
  const outputStart = inverted ? bubbleX + bubbleRadius : bodyRight;
  const gateFamily =
    kind === "nand" ? "and" : kind === "nor" ? "or" : kind === "xnor" ? "xor" : kind;
  const bodyPath = (() => {
    if (gateFamily === "not" || gateFamily === "buffer") {
      return `M${left},${top} L${bodyRight},${middle} L${left},${bottom} Z`;
    }
    if (gateFamily === "and") {
      const shoulder = left + (bodyRight - left) * 0.43;
      return `M${left},${top} H${shoulder} C${bodyRight - 7},${top} ${bodyRight},${middle - 10} ${bodyRight},${middle} C${bodyRight},${middle + 10} ${bodyRight - 7},${bottom} ${shoulder},${bottom} H${left} Z`;
    }
    return `M${left},${top} C${left + 19},${top} ${bodyRight - 10},${middle - 11} ${bodyRight},${middle} C${bodyRight - 10},${middle + 11} ${left + 19},${bottom} ${left},${bottom} C${left + 10},${middle + 9} ${left + 10},${middle - 9} ${left},${top} Z`;
  })();
  const stateClass = `${selected ? " selected" : ""}${hovered ? " hovered" : ""}`;

  return (
    <g className={`logic-gate gate-${kind}${stateClass}`}>
      {inputYs.map((y) => (
        <line className="gate-detail gate-input-lead" x1={0} y1={y} x2={left + 18} y2={y} key={y} />
      ))}
      <path className={`node-shape gate-body${stateClass}`} d={bodyPath} />
      {gateFamily === "xor" ? (
        <path
          className="gate-detail gate-xor-arc"
          d={`M${left - 5},${top} C${left + 5},${middle - 9} ${left + 5},${middle + 9} ${left - 5},${bottom}`}
        />
      ) : null}
      {inverted ? (
        <circle className="gate-inversion" cx={bubbleX} cy={middle} r={bubbleRadius} />
      ) : null}
      <line
        className="gate-detail gate-output-lead"
        x1={outputStart}
        y1={middle}
        x2={width}
        y2={middle}
      />
    </g>
  );
});

const NodeShape = memo(function NodeShape({
  node,
  selected,
  hovered,
  labelSettings,
  constantRadix,
}: NodeShapeProps) {
  const localPort = (port: LayoutNode["ports"][number]) => ({
    ...port,
    x: port.x - node.x,
    y: port.y - node.y,
  });
  const displayInstance = labelSettings.instances || hovered || selected;
  const displayDefinition = labelSettings.definitions || hovered || selected;
  const instanceLabel = shortModuleName(node.label, 20);
  const definitionLabel = node.definitionName
    ? shortModuleName(node.definitionName, 20)
    : undefined;
  const commonClass = `node-shape ${selected ? "selected" : ""} ${hovered ? "hovered" : ""}`;
  const gateKind = node.kind === "operator" ? logicGateKind(node.glyph) : undefined;
  const gateInputYs = gateKind
    ? node.ports
        .filter((port) => port.direction === "input")
        .map((port) => {
          const local = localPort(port);
          return local.y + local.height / 2;
        })
    : [];
  const registerDataInputs = node.ports.filter(
    (port) =>
      port.direction !== "output" &&
      port.role !== "clock" &&
      port.role !== "reset" &&
      port.role !== "enable",
  );
  const registerOutputs = node.ports.filter((port) => port.direction === "output");
  const registerControls = node.ports.filter(
    (port) => port.role === "reset" || port.role === "enable",
  );
  const clockPort = node.ports.find((port) => port.role === "clock");
  const clockCenterY = clockPort ? localPort(clockPort).y + clockPort.height / 2 : node.height - 22;
  const muxSelectPort =
    node.kind === "mux" ? node.ports.find((port) => port.role === "select") : undefined;
  const muxDataInputs =
    node.kind === "mux"
      ? node.ports.filter((port) => port.direction === "input" && port.role !== "select")
      : [];
  const orderedOperatorInputs =
    node.kind === "operator" && node.glyph && ORDERED_BINARY_GLYPHS.has(node.glyph)
      ? node.ports.filter((port) => port.direction === "input")
      : [];
  const muxSelectCenterX = muxSelectPort
    ? localPort(muxSelectPort).x + muxSelectPort.width / 2
    : node.width / 2;
  const muxSelectCenterY = muxSelectPort
    ? localPort(muxSelectPort).y + muxSelectPort.height / 2
    : node.height;
  const muxBottomEdgeY = (() => {
    const leftX = 0;
    const rightX = node.width;
    const clampedX = Math.min(rightX, Math.max(leftX, muxSelectCenterX));
    const ratio = (clampedX - leftX) / (rightX - leftX);
    return node.height - 5 + ratio * (node.height * 0.78 - (node.height - 5));
  })();

  return (
    <g className={`schematic-node kind-${node.kind}`} transform={`translate(${node.x} ${node.y})`}>
      {node.kind === "operator" ? (
        gateKind ? (
          <LogicGateShape
            kind={gateKind}
            width={node.width}
            height={node.height}
            inputYs={gateInputYs}
            selected={selected}
            hovered={hovered}
          />
        ) : (
          <>
            {node.ports.map((port) => {
              const local = localPort(port);
              const centerY = local.y + local.height / 2;
              const atWest = local.x < node.width / 2;
              return (
                <line
                  className="symbol-port-lead"
                  x1={atWest ? 0 : node.width - 3}
                  y1={centerY}
                  x2={atWest ? 3 : node.width}
                  y2={centerY}
                  key={`lead-${port.id}`}
                />
              );
            })}
            <circle
              className={commonClass}
              cx={node.width / 2}
              cy={node.height / 2}
              r={node.width / 2 - 3}
            />
            <text className="operator-glyph" x={node.width / 2} y={node.height / 2 + 1}>
              {node.glyph}
            </text>
            {orderedOperatorInputs.length > 1
              ? orderedOperatorInputs.map((port) => {
                  const local = localPort(port);
                  const index = port.index ?? namedOperandIndex(port.name);
                  if (index === undefined) return null;
                  return (
                    <text
                      className="operand-order-label"
                      x={10}
                      y={local.y + local.height / 2}
                      key={port.id}
                    >
                      {index === 0 ? "lhs" : index === 1 ? "rhs" : index}
                    </text>
                  );
                })
              : null}
          </>
        )
      ) : null}

      {node.kind === "mux" ? (
        <>
          <path
            className={commonClass}
            d={`M0,5 L${node.width},${node.height * 0.22} L${node.width},${node.height * 0.78} L0,${node.height - 5} Z`}
          />
          {muxSelectPort ? (
            <line
              className="mux-select-lead"
              x1={muxSelectCenterX}
              y1={muxBottomEdgeY}
              x2={muxSelectCenterX}
              y2={muxSelectCenterY}
            />
          ) : null}
          <text className="mux-select" x={muxSelectCenterX} y={muxBottomEdgeY - 8}>
            sel
          </text>
          {muxDataInputs.map((port) => {
            const local = localPort(port);
            const index = port.index ?? numericPortName(port.name);
            if (index === undefined) return null;
            return (
              <text className="mux-input-index" x={14} y={local.y + local.height / 2} key={port.id}>
                {index}
              </text>
            );
          })}
        </>
      ) : null}

      {node.kind === "register" || node.kind === "latch" ? (
        <>
          <rect
            className={`${commonClass} storage-element`}
            x={0}
            y={0}
            width={node.width}
            height={node.height}
          />
          <text className="node-title register-title" x={node.width / 2} y={-8}>
            {node.label}
          </text>
          {registerDataInputs.map((port) => {
            const local = localPort(port);
            return (
              <text className="port-inside" x={14} y={local.y + local.height / 2} key={port.id}>
                {port.name}
              </text>
            );
          })}
          {registerOutputs.map((port) => {
            const local = localPort(port);
            return (
              <text
                className="port-inside"
                x={node.width - 16}
                y={local.y + local.height / 2}
                key={port.id}
              >
                {port.name}
              </text>
            );
          })}
          {registerControls.map((port) => {
            const local = localPort(port);
            return (
              <text
                className="port-inside register-control-label"
                x={local.x + local.width / 2}
                y={node.height - 13}
                key={port.id}
              >
                {port.name}
              </text>
            );
          })}
          <path className="clock-marker" d={`M0,${clockCenterY - 9} l18,9 l-18,9`} />
          {node.kind === "latch" ? (
            <text className="latch-mark" x={node.width / 2} y={node.height - 14}>
              L
            </text>
          ) : null}
        </>
      ) : null}

      {node.kind === "module" ? (
        <>
          <rect
            className={`${commonClass} ${node.transparent ? "transparent-boundary" : "submodule-instance"}`}
            x={0}
            y={0}
            width={node.width}
            height={node.height}
          />
          {node.transparent ? (
            <g className="transparent-preview">
              <circle cx={node.width * 0.36} cy={node.height * 0.57} r={16} />
              <text x={node.width * 0.36} y={node.height * 0.57 + 1}>
                &lt;&lt;
              </text>
              <circle cx={node.width * 0.68} cy={node.height * 0.57} r={16} />
              <text x={node.width * 0.68} y={node.height * 0.57 + 1}>
                &gt;&gt;
              </text>
            </g>
          ) : null}
          {displayInstance ? (
            <text className="node-title module-title" x={node.width / 2} y={23}>
              <title>{node.label}</title>
              {instanceLabel}
            </text>
          ) : null}
          {displayDefinition && definitionLabel ? (
            <text
              className="node-subtitle"
              x={node.width / 2}
              y={node.transparent ? 42 : node.height / 2 + 4}
            >
              <title>{node.definitionName}</title>
              {definitionLabel}
            </text>
          ) : null}
        </>
      ) : null}

      {node.kind === "input" || node.kind === "output" ? (
        <>
          <path
            className={commonClass}
            d={`M0,7 H${node.width - 13} L${node.width},${node.height / 2} L${node.width - 13},${node.height - 7} H0 Z`}
          />
          <text
            className={`boundary-label ${node.kind}`}
            x={node.kind === "input" ? 2 : node.width - 2}
            y={-9}
          >
            {node.label}
          </text>
          {node.ports[0]?.bitWidth && node.ports[0].bitWidth > 1 ? (
            <text
              className={`bus-width ${node.kind}`}
              x={node.kind === "input" ? 2 : node.width - 2}
              y={node.height + 13}
            >
              [{node.ports[0].bitWidth - 1}:0]
            </text>
          ) : null}
        </>
      ) : null}

      {node.kind === "constant" ? (
        <text
          className={`constant-value${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
          x={node.width / 2}
          y={node.height / 2}
        >
          {formatConstantLiteral(node.label, constantRadix)}
        </text>
      ) : node.kind === "memory" ? (
        <>
          <rect
            className={`${commonClass} memory-element`}
            x={0}
            y={0}
            width={node.width}
            height={node.height}
          />
          <text className="node-title" x={node.width / 2} y={23}>
            {node.label}
          </text>
        </>
      ) : null}

      {![
        "operator",
        "mux",
        "register",
        "latch",
        "module",
        "memory",
        "input",
        "output",
        "constant",
      ].includes(node.kind) ? (
        <>
          <rect className={commonClass} x={0} y={0} width={node.width} height={node.height} />
          <text className="node-title" x={node.width / 2} y={node.height / 2}>
            {node.label}
          </text>
        </>
      ) : null}

      {node.ports.map((port) => {
        const local = localPort(port);
        const atWest = local.x < node.width / 2;
        const atSouth = local.y + local.height / 2 >= node.height - 0.5;
        const activeLow = isActiveLowReset(node, port);
        return (
          <g
            className={`node-port role-${port.role ?? "data"}${activeLow ? " active-low" : ""}`}
            key={port.id}
          >
            {activeLow ? (
              <circle cx={local.x + local.width / 2} cy={local.y + local.height / 2} r={2.8} />
            ) : null}
            {(node.kind === "module" && !node.transparent) || node.kind === "memory" ? (
              <text
                className="port-label"
                x={atSouth ? local.x + local.width / 2 : atWest ? 10 : node.width - 10}
                y={atSouth ? node.height - 12 : local.y + 5}
                textAnchor={atSouth ? "middle" : atWest ? "start" : "end"}
              >
                {port.name}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
});

interface GroupBoundaryProps {
  group: LayoutGroup;
  selected: boolean;
  hovered: boolean;
  labelSettings: LabelSettings;
}

const GroupBoundary = memo(function GroupBoundary({
  group,
  selected,
  hovered,
  labelSettings,
}: GroupBoundaryProps) {
  const displayInstance = labelSettings.instances || hovered || selected;
  const displayDefinition = labelSettings.definitions || hovered || selected;
  const groupLabelLength = Math.max(6, Math.floor((group.width - 22) / 6.2));
  const instanceLabel = shortModuleName(group.name, groupLabelLength);
  const definitionLabel = shortModuleName(group.definitionName, groupLabelLength);

  return (
    <g
      className={`transparent-group${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      transform={`translate(${group.x} ${group.y})`}
    >
      <rect className="group-boundary" width={group.width} height={group.height} rx={5} />
      <path className="group-header-rule" d={`M0,34 H${group.width}`} />
      {displayInstance ? (
        <text className="group-title" x={11} y={15}>
          <title>{group.name}</title>
          {instanceLabel}
        </text>
      ) : null}
      {displayDefinition ? (
        <text className="group-definition" x={11} y={28}>
          <title>{group.definitionName}</title>
          {definitionLabel}
        </text>
      ) : null}
    </g>
  );
});

interface TopLevelBoundaryProps {
  width: number;
  height: number;
  module: GraphSlice["module"];
  selected: boolean;
  hovered: boolean;
  labelSettings: LabelSettings;
}

const TopLevelBoundary = memo(function TopLevelBoundary({
  width,
  height,
  module,
  selected,
  hovered,
  labelSettings,
}: TopLevelBoundaryProps) {
  const showInstance = labelSettings.instances || selected || hovered;
  const showDefinition = labelSettings.definitions || selected || hovered;
  return (
    <g className={`top-level-module${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}>
      <rect
        className="top-level-boundary"
        x={8}
        y={8}
        width={Math.max(0, width - 16)}
        height={Math.max(0, height - 16)}
        rx={7}
      />
      <path className="top-level-header-rule" d={`M8,48 H${Math.max(8, width - 8)}`} />
      {showInstance ? (
        <text className="top-level-title" x={20} y={27}>
          <title>{module.instancePath}</title>
          {shortModuleName(module.name || module.instancePath, 30)}
        </text>
      ) : null}
      {showDefinition ? (
        <text className="top-level-definition" x={20} y={41}>
          <title>{module.definitionName}</title>
          {shortModuleName(module.definitionName, 36)}
        </text>
      ) : null}
    </g>
  );
});

const LABEL_OPTIONS: Array<{ key: keyof LabelSettings; label: string }> = [
  { key: "nets", label: "Net names" },
  { key: "signalTypes", label: "Signal types" },
  { key: "bitWidths", label: "Total bitwidth" },
  { key: "instances", label: "Instance names" },
  { key: "definitions", label: "Definition names" },
];

const FLATTEN_RENDER_MODE_OPTIONS: Array<{
  value: FlattenRenderMode;
  label: string;
  description: string;
}> = [
  {
    value: "grouped",
    label: "Grouped",
    description:
      "Preserve each flattened submodule as a non-overlapping region and lay out its contents inside that boundary.",
  },
  {
    value: "flat",
    label: "Flat",
    description:
      "Remove flattened submodule boundaries and lay out every expanded node together as one flat graph.",
  },
];

const boundsForLayoutEntity = (layout: LayoutResult, id: string): CameraBounds | undefined => {
  const node = layout.nodes.find((candidate) => candidate.id === id);
  if (node) return { x: node.x, y: node.y, width: node.width, height: node.height };
  const group = layout.groups.find((candidate) => candidate.id === id);
  if (group) return { x: group.x, y: group.y, width: group.width, height: group.height };
  const edge = layout.edges.find((candidate) => candidate.id === id);
  if (!edge) return undefined;
  return unionCameraBounds([
    ...edge.sections.flatMap((section) =>
      pointsForSection(section).map((point) => ({
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
      })),
    ),
    ...layout.nodes
      .filter((candidate) => candidate.id === edge.sourceNode || candidate.id === edge.targetNode)
      .map((candidate) => ({
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      })),
  ]);
};

export function SchematicCanvas({
  slice,
  selectedId,
  focusEntityId,
  focusEntityRevision,
  onSelect,
  onHover,
  onOpenInstance,
  canGoUp,
  onGoUp,
  onGoTop,
  labelSettings,
  onToggleLabel,
  flattenDepth,
  onFlattenDepthChange,
  flattenRenderMode,
  onFlattenRenderModeChange,
  layoutProfile,
  onLayoutProfileChange,
  constantRadix,
  onConstantRadixChange,
  onFlattenInstance,
  onRestoreInstance,
  individuallyFlattened,
  topLevelDefines,
  inspectorOpen,
  onToggleInspector,
  comparison,
  warnings = [],
  busy = false,
}: SchematicCanvasProps) {
  const gridPatternId = useId().replaceAll(":", "");
  const edgeArrowId = useId().replaceAll(":", "");
  const [hiddenSignalKeys, setHiddenSignalKeys] = useState<Set<string>>(() => new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [flattenModesOpen, setFlattenModesOpen] = useState(false);
  const [layoutProfilesOpen, setLayoutProfilesOpen] = useState(false);
  const [diffViewOpen, setDiffViewOpen] = useState(false);
  const [diffVisibility, setDiffVisibility] = useState<DiffVisibility>(defaultDiffVisibility);
  const [diffPreset, setDiffPreset] = useState<DiffPreset>("overlay");
  const emphasizeDifferences = diffPreset !== "reference" && diffPreset !== "candidate";
  const [contextMenu, setContextMenu] = useState<
    { id: string; x: number; y: number; action: "flatten" | "restore" } | undefined
  >();
  const controlSignals = useMemo(() => detectedControlSignals(slice), [slice]);
  const { layout, loading, error } = useLayout(
    slice,
    layoutProfile,
    flattenRenderMode,
    Boolean(comparison),
  );
  const semanticSide = semanticSideForPreset(diffPreset);
  const renderedLayout = useMemo(
    () =>
      layout
        ? layoutForComparisonSide(layout, comparison?.comparisonSlice, semanticSide)
        : undefined,
    [comparison?.comparisonSlice, layout, semanticSide],
  );
  const renderedNodeLabels = useMemo(
    () => new Map(renderedLayout?.nodes.map((node) => [node.id, node.label]) ?? []),
    [renderedLayout],
  );
  const renderedModule = moduleForComparisonSide(
    slice.module,
    comparison?.comparisonSlice,
    semanticSide,
  );
  const changesOnlyContext = useMemo(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    if (!comparison || !layout || diffPreset !== "changes") return { nodeIds, edgeIds };
    const statusFor = (id: string) => comparison.entities[id]?.status ?? "unchanged";
    const visibleChange = (id: string) => {
      const status = statusFor(id);
      return status !== "unchanged" && diffVisibility[status];
    };
    for (const edge of layout.edges) {
      const edgeChanged = visibleChange(edge.id);
      const touchesChangedNode = visibleChange(edge.sourceNode) || visibleChange(edge.targetNode);
      if (!edgeChanged && touchesChangedNode && statusFor(edge.id) === "unchanged") {
        edgeIds.add(edge.id);
      }
      if (!edgeChanged && !touchesChangedNode) continue;
      for (const nodeId of [edge.sourceNode, edge.targetNode]) {
        if (statusFor(nodeId) === "unchanged") nodeIds.add(nodeId);
      }
    }
    return { nodeIds, edgeIds };
  }, [comparison, diffPreset, diffVisibility, layout]);
  const changesOnlyBounds = useMemo(() => {
    if (!comparison || !layout) return undefined;
    const visibleChange = (id: string) => {
      const status = comparison.entities[id]?.status ?? "unchanged";
      return status !== "unchanged" && diffVisibility[status];
    };
    const bounds: CameraBounds[] = [];
    for (const node of layout.nodes) {
      if (!visibleChange(node.id) && !changesOnlyContext.nodeIds.has(node.id)) continue;
      bounds.push({ x: node.x, y: node.y, width: node.width, height: node.height });
    }
    for (const group of layout.groups) {
      if (!visibleChange(group.id)) continue;
      bounds.push({ x: group.x, y: group.y, width: group.width, height: group.height });
    }
    for (const edge of layout.edges) {
      if (!visibleChange(edge.id) && !changesOnlyContext.edgeIds.has(edge.id)) continue;
      const signalKey = controlSignalKey(slice, edge);
      if (signalKey && hiddenSignalKeys.has(signalKey)) continue;
      const edgeBounds = unionCameraBounds(
        edge.sections.flatMap((section) =>
          pointsForSection(section).map((point) => ({
            x: point.x,
            y: point.y,
            width: 0,
            height: 0,
          })),
        ),
      );
      if (edgeBounds) bounds.push(edgeBounds);
    }
    return unionCameraBounds(bounds);
  }, [changesOnlyContext, comparison, diffVisibility, hiddenSignalKeys, layout, slice]);
  const fitCameraViewBox = useMemo(() => {
    if (!layout) return undefined;
    if (diffPreset !== "changes" || !changesOnlyBounds) {
      return { x: 0, y: 0, width: layout.width, height: layout.height };
    }
    const padding = Math.max(
      24,
      Math.min(160, Math.max(changesOnlyBounds.width, changesOnlyBounds.height) * 0.06),
    );
    return cameraViewBoxForBounds(changesOnlyBounds, layout, padding);
  }, [changesOnlyBounds, diffPreset, layout]);
  const selectedLayoutProfile =
    LAYOUT_PROFILE_OPTIONS.find((option) => option.value === layoutProfile) ??
    LAYOUT_PROFILE_OPTIONS[0];
  const selectedFlattenMode =
    FLATTEN_RENDER_MODE_OPTIONS.find((option) => option.value === flattenRenderMode) ??
    FLATTEN_RENDER_MODE_OPTIONS[0];
  const [hoveredId, setHoveredId] = useState<string>();
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number }>();
  const updateHoveredId = useCallback(
    (id: string | undefined) => {
      setHoveredId(id);
      onHover?.(id);
    },
    [onHover],
  );
  const cameraRef = useRef<CameraViewBox>({ x: 0, y: 0, width: 1000, height: 620 });
  const dragRef = useRef<{ x: number; y: number; viewBox: CameraViewBox } | undefined>(undefined);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gridPatternRef = useRef<SVGPatternElement>(null);
  const zoomReadoutRef = useRef<HTMLSpanElement>(null);
  const diffViewButtonRef = useRef<HTMLButtonElement>(null);
  const diffViewDialogRef = useRef<HTMLDivElement>(null);
  const committedCameraRef = useRef<CameraViewBox>(cameraRef.current);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const appliedFocusRevision = useRef<number | undefined>(undefined);
  const fittedLayoutRef = useRef<LayoutResult | undefined>(undefined);
  const fittedPolicyRef = useRef(comparison?.policy);
  const fittedPresetRef = useRef<DiffPreset>(diffPreset);
  const fittedChangesBoundsKeyRef = useRef("");
  const highlighted = useMemo(
    () => getHighlighted(selectedId, slice.edges),
    [selectedId, slice.edges],
  );

  useLayoutEffect(() => {
    if (!diffViewOpen) return;
    const dialog = diffViewDialogRef.current;
    (
      dialog?.querySelector<HTMLInputElement>("input:checked") ??
      dialog?.querySelector<HTMLInputElement>("input")
    )?.focus();
  }, [diffViewOpen]);

  useEffect(() => {
    setHiddenSignalKeys((current) => {
      const available = new Set(controlSignals.map((signal) => signal.key));
      const retained = new Set([...current].filter((key) => available.has(key)));
      return retained.size === current.size ? current : retained;
    });
  }, [controlSignals]);

  useEffect(() => {
    if (
      !contextMenu &&
      !labelsOpen &&
      !signalsOpen &&
      !flattenModesOpen &&
      !layoutProfilesOpen &&
      !diffViewOpen
    )
      return;
    const dismiss = () => {
      setContextMenu(undefined);
      setLabelsOpen(false);
      setSignalsOpen(false);
      setFlattenModesOpen(false);
      setLayoutProfilesOpen(false);
      setDiffViewOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
      if (diffViewOpen) diffViewButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu, diffViewOpen, flattenModesOpen, labelsOpen, layoutProfilesOpen, signalsOpen]);

  const applyCamera = useCallback(
    (camera: CameraViewBox) => {
      const svg = svgRef.current;
      const stage = stageRef.current;
      if (!svg || !stage) return;

      const rect = svg.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const currentViewBox = svg.viewBox.baseVal;
      if (currentViewBox.width !== width || currentViewBox.height !== height) {
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      }

      const viewport = { width, height };
      const transform = cameraTransform(camera, viewport);
      const committedTransform = cameraTransform(committedCameraRef.current, viewport);
      const relativeScale = transform.scale / committedTransform.scale;
      const relativeX = transform.x - committedTransform.x * relativeScale;
      const relativeY = transform.y - committedTransform.y * relativeScale;
      const isCommittedView =
        Math.abs(relativeScale - 1) < 1e-9 &&
        Math.abs(relativeX) < 1e-6 &&
        Math.abs(relativeY) < 1e-6;
      stage.style.transform = isCommittedView
        ? "none"
        : `translate3d(${relativeX}px, ${relativeY}px, 0) scale(${relativeScale})`;
      gridPatternRef.current?.setAttribute(
        "patternTransform",
        `translate(${transform.x} ${transform.y}) scale(${transform.scale})`,
      );

      if (zoomReadoutRef.current && layout) {
        zoomReadoutRef.current.textContent = `${Math.round((layout.width / camera.width) * 100)}%`;
      }
    },
    [layout],
  );

  const replaceCamera = useCallback(
    (camera: CameraViewBox) => {
      if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = undefined;
      cameraRef.current = camera;
      committedCameraRef.current = camera;
      viewportRef.current?.setAttribute(
        "viewBox",
        `${camera.x} ${camera.y} ${camera.width} ${camera.height}`,
      );
      applyCamera(camera);
      if (stageRef.current) stageRef.current.style.transform = "none";
    },
    [applyCamera],
  );

  const commitCamera = useCallback(() => {
    const camera = cameraRef.current;
    committedCameraRef.current = camera;
    if (viewportRef.current) {
      viewportRef.current.setAttribute(
        "viewBox",
        `${camera.x} ${camera.y} ${camera.width} ${camera.height}`,
      );
    }
    if (stageRef.current) {
      stageRef.current.style.transform = "none";
    }
  }, []);

  const scheduleCameraCommit = useCallback(() => {
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = undefined;
      commitCamera();
    }, 180);
  }, [commitCamera]);

  const setCamera = useCallback(
    (camera: CameraViewBox) => {
      cameraRef.current = camera;
      applyCamera(camera);
      scheduleCameraCommit();
    },
    [applyCamera, scheduleCameraCommit],
  );

  useLayoutEffect(() => {
    if (!layout?.width || !layout.height || !fitCameraViewBox) {
      fittedPresetRef.current = diffPreset;
      return;
    }
    const policyChanged = fittedPolicyRef.current !== comparison?.policy;
    // A policy change temporarily installs an empty comparison slice while matching. Keep the
    // camera and the last completed layout as the transition anchor until the replacement union
    // has finished matching and layout.
    if (policyChanged && busy) return;
    const layoutChanged = fittedLayoutRef.current !== layout;
    const enteringChanges = diffPreset === "changes" && fittedPresetRef.current !== "changes";
    const changesBoundsKey = changesOnlyBounds
      ? `${changesOnlyBounds.x}:${changesOnlyBounds.y}:${changesOnlyBounds.width}:${changesOnlyBounds.height}`
      : "";
    const activeChangesMoved =
      diffPreset === "changes" && fittedChangesBoundsKeyRef.current !== changesBoundsKey;
    fittedPresetRef.current = diffPreset;
    if (!layoutChanged && !enteringChanges && !activeChangesMoved && !policyChanged) return;
    fittedLayoutRef.current = layout;
    fittedPolicyRef.current = comparison?.policy;
    fittedChangesBoundsKeyRef.current = changesBoundsKey;
    if (policyChanged && diffPreset !== "changes") {
      const retainedBounds = selectedId ? boundsForLayoutEntity(layout, selectedId) : undefined;
      const target = retainedBounds ?? {
        x: layout.width / 2,
        y: layout.height / 2,
        width: 0,
        height: 0,
      };
      replaceCamera(
        cameraFocusedOnBounds(cameraRef.current, target, {
          width: layout.width,
          height: layout.height,
        }),
      );
      return;
    }
    replaceCamera(fitCameraViewBox);
  }, [
    busy,
    changesOnlyBounds,
    comparison?.policy,
    diffPreset,
    fitCameraViewBox,
    layout,
    replaceCamera,
    selectedId,
  ]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => applyCamera(cameraRef.current));
    observer.observe(svg);
    return () => {
      observer.disconnect();
      if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    };
  }, [applyCamera]);

  const zoom = (factor: number) => {
    const current = cameraRef.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const worldWidth = layout?.width ?? current.width;
    const worldHeight = layout?.height ?? current.height;
    const maxWidth = Math.max(10000, (layout?.width ?? current.width) * 4);
    const maxHeight = Math.max(7000, (layout?.height ?? current.height) * 4);
    const nextSize = constrainedCameraSize(current, factor, {
      minWidth: Math.min(160, Math.max(24, worldWidth * 0.2)),
      minHeight: Math.min(100, Math.max(24, worldHeight * 0.2)),
      maxWidth,
      maxHeight,
    });
    setCamera(
      resizeCameraAt(
        current,
        nextSize,
        { width: rect.width, height: rect.height },
        { x: rect.width / 2, y: rect.height / 2 },
      ),
    );
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratioX = (event.clientX - rect.left) / rect.width;
    const ratioY = (event.clientY - rect.top) / rect.height;
    const factor = wheelZoomFactor(event.deltaY, event.deltaMode, rect.height);
    const current = cameraRef.current;
    const worldWidth = layout?.width ?? current.width;
    const worldHeight = layout?.height ?? current.height;
    const maxWidth = Math.max(10000, (layout?.width ?? current.width) * 4);
    const maxHeight = Math.max(7000, (layout?.height ?? current.height) * 4);
    const nextSize = constrainedCameraSize(current, factor, {
      minWidth: Math.min(160, Math.max(24, worldWidth * 0.2)),
      minHeight: Math.min(100, Math.max(24, worldHeight * 0.2)),
      maxWidth,
      maxHeight,
    });
    setCamera(
      resizeCameraAt(
        current,
        nextSize,
        { width: rect.width, height: rect.height },
        { x: ratioX * rect.width, y: ratioY * rect.height },
      ),
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy) return;
    if (event.button !== 0 || !svgRef.current) return;
    if (
      (event.target as Element).closest(
        ".node-interaction, .group-interaction, .schematic-edge, .top-level-interaction-layer",
      )
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, viewBox: cameraRef.current };
    canvasWrapRef.current?.classList.add("dragging");
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setCamera(
      panCameraByScreenDelta(
        dragRef.current.viewBox,
        { width: rect.width, height: rect.height },
        {
          x: event.clientX - dragRef.current.x,
          y: event.clientY - dragRef.current.y,
        },
      ),
    );
  };

  const onPointerUp = () => {
    dragRef.current = undefined;
    canvasWrapRef.current?.classList.remove("dragging");
  };

  const hoveredNode = renderedLayout?.nodes.find((node) => node.id === hoveredId);
  const hoveredGroup = renderedLayout?.groups.find((group) => group.id === hoveredId);
  const hoveredInstance =
    hoveredId === TOP_MODULE_ID
      ? {
          label: renderedModule.name,
          definitionName: renderedModule.definitionName,
          parameters: renderedModule.parameters,
        }
      : hoveredNode?.kind === "module"
        ? hoveredNode
        : hoveredGroup
          ? {
              label: hoveredGroup.name,
              definitionName: hoveredGroup.definitionName,
              parameters: hoveredGroup.parameters,
            }
          : undefined;
  const updateTooltipPosition = (clientX: number, clientY: number) => {
    const bounds = canvasWrapRef.current?.getBoundingClientRect();
    setTooltipPosition({
      x: clientX - (bounds?.left ?? 0) + 14,
      y: clientY - (bounds?.top ?? 0) + 14,
    });
  };
  const breadcrumbs = renderedModule.instancePath.split(".");
  const entityDiff = useCallback((id: string) => comparison?.entities[id], [comparison?.entities]);
  const visibleDisconnectedComponentCount = useMemo(() => {
    const region = renderedLayout?.disconnectedRegion;
    if (!comparison || !region) return 0;
    return region.componentEntityIds.filter((entityIds) =>
      entityIds.some((id) => diffVisibility[comparison.entities[id]?.status ?? "unchanged"]),
    ).length;
  }, [comparison, diffVisibility, renderedLayout?.disconnectedRegion]);
  const changeIds = useMemo(() => {
    if (!comparison || !layout) return [];
    const ids = [
      ...layout.nodes.map((node) => node.id),
      ...layout.edges.map((edge) => edge.id),
      ...layout.groups.map((group) => group.id),
      TOP_MODULE_ID,
    ];
    return ids.filter((id) => {
      const status = comparison.entities[id]?.status ?? "unchanged";
      return status !== "unchanged" && diffVisibility[status];
    });
  }, [comparison, diffVisibility, layout]);
  const comparisonCounts = useMemo(() => {
    if (!comparison || !layout) return undefined;
    const derived = { unchanged: 0, removed: 0, added: 0, modified: 0, heuristic: 0 };
    const visibleIds = [
      ...layout.nodes.map((node) => node.id),
      ...layout.edges.map((edge) => edge.id),
      ...layout.groups.map((group) => group.id),
      TOP_MODULE_ID,
    ];
    for (const id of new Set(visibleIds)) {
      const metadata = comparison.entities[id];
      if (!metadata) continue;
      if (!diffVisibility[metadata.status]) continue;
      derived[metadata.status] += 1;
      if (metadata.matchMethod === "heuristic") derived.heuristic += 1;
    }
    return derived;
  }, [comparison, diffVisibility, layout]);
  const availableDiffStatuses = useMemo(() => {
    if (!comparison) return ALL_DIFF_STATUSES;
    const statuses = new Set(
      Object.values(comparison.entities).flatMap((entity) => (entity ? [entity.status] : [])),
    );
    return ALL_DIFF_STATUSES.filter((status) => statuses.has(status));
  }, [comparison]);
  const focusEntity = useCallback(
    (id: string, zoomToTarget = false) => {
      if (!layout) return;
      const bounds = boundsForLayoutEntity(layout, id);
      if (!bounds) return;
      setCamera(
        cameraFocusedOnBounds(
          cameraRef.current,
          bounds,
          { width: layout.width, height: layout.height },
          zoomToTarget,
        ),
      );
    },
    [layout, setCamera],
  );
  useLayoutEffect(() => {
    if (
      focusEntityRevision === undefined ||
      appliedFocusRevision.current === focusEntityRevision ||
      !focusEntityId ||
      !layout
    ) {
      return;
    }
    if (focusEntityId === TOP_MODULE_ID) {
      appliedFocusRevision.current = focusEntityRevision;
      return;
    }
    if (diffPreset === "changes") {
      const status = comparison?.entities[focusEntityId]?.status ?? "unchanged";
      const contextVisible =
        changesOnlyContext.nodeIds.has(focusEntityId) ||
        changesOnlyContext.edgeIds.has(focusEntityId);
      if ((status === "unchanged" || !diffVisibility[status]) && !contextVisible) {
        // Policy replacement can retain a selection whose new correspondence is unchanged. It is
        // deliberately hidden in Changes-only, so centering it would move every visible change
        // outside the camera immediately after the replacement layout was fitted.
        appliedFocusRevision.current = focusEntityRevision;
        return;
      }
    }
    const exists =
      layout.nodes.some((node) => node.id === focusEntityId) ||
      layout.edges.some((edge) => edge.id === focusEntityId) ||
      layout.groups.some((group) => group.id === focusEntityId);
    if (!exists) return;
    appliedFocusRevision.current = focusEntityRevision;
    focusEntity(focusEntityId);
  }, [
    changesOnlyContext,
    comparison?.entities,
    diffPreset,
    diffVisibility,
    focusEntity,
    focusEntityId,
    focusEntityRevision,
    layout,
  ]);
  const selectAdjacentChange = (direction: -1 | 1) => {
    if (changeIds.length === 0) return;
    const currentIndex = selectedId ? changeIds.indexOf(selectedId) : -1;
    const fallback = direction > 0 ? 0 : changeIds.length - 1;
    const nextIndex =
      currentIndex < 0
        ? fallback
        : (currentIndex + direction + changeIds.length) % changeIds.length;
    const next = changeIds[nextIndex];
    if (!next) return;
    onSelect(next);
    focusEntity(next, true);
  };
  const selectedChangeIndex = selectedId ? changeIds.indexOf(selectedId) : -1;
  const applyDiffPreset = (preset: NamedDiffPreset) => {
    setDiffPreset(preset);
    switch (preset) {
      case "reference":
        setDiffVisibility({ unchanged: true, removed: true, added: false, modified: true });
        break;
      case "candidate":
        setDiffVisibility({ unchanged: true, removed: false, added: true, modified: true });
        break;
      case "changes":
        setDiffVisibility({ unchanged: false, removed: true, added: true, modified: true });
        break;
      case "overlay":
        setDiffVisibility(defaultDiffVisibility());
        break;
    }
  };

  return (
    <section className="schematic-panel" aria-label="Schematic">
      <div className="schematic-toolbar">
        <nav className="breadcrumb" aria-label="Hierarchy breadcrumb">
          {breadcrumbs.map((part, index) => (
            <span key={breadcrumbs.slice(0, index + 1).join(".")}>
              {index > 0 ? <i>/</i> : null}
              <strong className={index === breadcrumbs.length - 1 ? "current" : ""}>{part}</strong>
            </span>
          ))}
        </nav>
        {comparison ? (
          <>
            <div className="toolbar-divider" />
            <div className="comparison-toolbar">
              <label className="comparison-policy-control">
                <GitCompareArrows size={13} aria-hidden="true" />
                <span>Matching</span>
                <select
                  aria-label="Schematic matching policy"
                  value={comparison.policy}
                  onChange={(event) =>
                    comparison.onPolicyChange(
                      event.target.value as SchematicComparisonPresentation["policy"],
                    )
                  }
                >
                  <option value="conservative">Conservative</option>
                  <option value="aggressive">Aggressive</option>
                </select>
              </label>
              <div
                className="comparison-view-wrap"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  ref={diffViewButtonRef}
                  type="button"
                  className={`toolbar-button comparison-view-button${diffViewOpen ? " active" : ""}`}
                  aria-expanded={diffViewOpen}
                  aria-haspopup="dialog"
                  aria-label={`Schematic comparison view: ${DIFF_PRESET_LABELS[diffPreset]}`}
                  title="Choose a snapshot or diff view and control visible statuses"
                  onClick={() => setDiffViewOpen((open) => !open)}
                >
                  <ListFilter size={13} aria-hidden="true" />
                  <span>View</span>
                  <strong>{DIFF_PRESET_LABELS[diffPreset]}</strong>
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                {diffViewOpen ? (
                  <div
                    ref={diffViewDialogRef}
                    className="signal-filter-menu comparison-view-menu"
                    role="dialog"
                    aria-label="Schematic comparison view options"
                  >
                    <fieldset className="comparison-preset-menu">
                      <legend>View preset</legend>
                      {(Object.keys(DIFF_PRESET_DESCRIPTIONS) as NamedDiffPreset[]).map(
                        (preset) => (
                          <label key={preset} title={DIFF_PRESET_DESCRIPTIONS[preset]}>
                            <input
                              type="radio"
                              name="schematic-comparison-view"
                              value={preset}
                              checked={diffPreset === preset}
                              onChange={() => {
                                applyDiffPreset(preset);
                                setDiffViewOpen(false);
                                diffViewButtonRef.current?.focus();
                              }}
                            />
                            <span>{DIFF_PRESET_LABELS[preset]}</span>
                          </label>
                        ),
                      )}
                    </fieldset>
                    {emphasizeDifferences ? (
                      <fieldset className="comparison-filter-menu">
                        <legend>Visible statuses</legend>
                        {availableDiffStatuses.map((status) => (
                          <label key={status} title={schematicDiffStatusDescription(status)}>
                            <input
                              type="checkbox"
                              checked={diffVisibility[status]}
                              onChange={() => {
                                setDiffPreset("custom");
                                setDiffVisibility((current) => ({
                                  ...current,
                                  [status]: !current[status],
                                }));
                              }}
                            />
                            <span className={`diff-filter-swatch ${status}`} aria-hidden="true" />
                            <span>{diffStatusLabel(status)}</span>
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      <p className="comparison-view-note">
                        Snapshot views use fixed side membership. Choose a diff view to filter
                        statuses.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
              <button
                className="icon-button toolbar-icon comparison-change-nav"
                type="button"
                onClick={() => selectAdjacentChange(-1)}
                disabled={changeIds.length === 0}
                aria-label="Previous schematic change"
                title="Previous schematic change"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                className="icon-button toolbar-icon comparison-change-nav"
                type="button"
                onClick={() => selectAdjacentChange(1)}
                disabled={changeIds.length === 0}
                aria-label="Next schematic change"
                title="Next schematic change"
              >
                <ChevronRight size={14} />
              </button>
              <span className="comparison-change-count">
                {selectedChangeIndex >= 0
                  ? `${(selectedChangeIndex + 1).toLocaleString()} of ${changeIds.length.toLocaleString()}`
                  : `${changeIds.length.toLocaleString()} visible`}
              </span>
            </div>
          </>
        ) : null}
        <div className="toolbar-divider" />
        <button
          className="toolbar-button up-button"
          type="button"
          onClick={onGoUp}
          disabled={!canGoUp}
          aria-label="Up one hierarchy level"
          title="Up one hierarchy level"
        >
          <ArrowUp size={14} /> Up
        </button>
        <button
          className="toolbar-button top-button"
          type="button"
          onClick={onGoTop}
          disabled={!canGoUp}
          aria-label="Jump to top module"
          title="Jump to top module"
        >
          <Home size={13} /> Top
        </button>
        <label className="flatten-depth-control">
          <Layers3 size={14} aria-hidden="true" />
          <span>Flatten depth</span>
          <select
            aria-label="Flatten instance depth"
            value={flattenDepth}
            onChange={(event) => onFlattenDepthChange(Number(event.target.value))}
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((depth) => (
              <option value={depth} key={depth}>
                {depth}
              </option>
            ))}
          </select>
        </label>
        <div
          className="flatten-render-mode-control"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span>Render mode</span>
          <button
            type="button"
            className="layout-profile-trigger flatten-render-mode-trigger"
            aria-label="Flatten render mode"
            aria-haspopup="menu"
            aria-expanded={flattenModesOpen}
            onClick={() => setFlattenModesOpen((open) => !open)}
          >
            <span>{selectedFlattenMode.label}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {flattenModesOpen ? (
            <div
              className="layout-profile-menu flatten-render-mode-menu"
              role="menu"
              aria-label="Flatten render modes"
            >
              {FLATTEN_RENDER_MODE_OPTIONS.map((option) => (
                <button
                  type="button"
                  className={`layout-profile-option${
                    option.value === flattenRenderMode ? " selected" : ""
                  }`}
                  role="menuitemradio"
                  aria-checked={option.value === flattenRenderMode}
                  key={option.value}
                  onClick={() => {
                    onFlattenRenderModeChange(option.value);
                    setFlattenModesOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === flattenRenderMode ? (
                    <Check size={13} aria-hidden="true" />
                  ) : null}
                  <span className="layout-profile-tooltip" role="tooltip">
                    {option.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <label className="constant-radix-control">
          <span>Constants</span>
          <select
            aria-label="Constant number format"
            value={constantRadix}
            onChange={(event) => onConstantRadixChange(event.target.value as ConstantRadix)}
          >
            <option value="binary">Binary</option>
            <option value="hex">Hex</option>
            <option value="decimal">Decimal</option>
          </select>
        </label>
        <div className="layout-profile-control" onPointerDown={(event) => event.stopPropagation()}>
          <span>Layout</span>
          <button
            type="button"
            className="layout-profile-trigger"
            aria-label="Schematic layout profile"
            aria-haspopup="menu"
            aria-expanded={layoutProfilesOpen}
            onClick={() => setLayoutProfilesOpen((open) => !open)}
          >
            <span>{selectedLayoutProfile.label}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {layoutProfilesOpen ? (
            <div className="layout-profile-menu" role="menu" aria-label="Layout profiles">
              {LAYOUT_PROFILE_OPTIONS.map((option) => (
                <button
                  type="button"
                  className={`layout-profile-option${
                    option.value === layoutProfile ? " selected" : ""
                  }`}
                  role="menuitemradio"
                  aria-checked={option.value === layoutProfile}
                  key={option.value}
                  onClick={() => {
                    onLayoutProfileChange(option.value);
                    setLayoutProfilesOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === layoutProfile ? <Check size={13} aria-hidden="true" /> : null}
                  <span className="layout-profile-tooltip" role="tooltip">
                    {option.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {individuallyFlattened ? (
          <button
            className="toolbar-button restore-instance-button"
            type="button"
            onClick={onRestoreInstance}
            aria-label="Restore instance"
            title="Restore the individually flattened instance"
          >
            <Undo2 size={13} /> Restore instance
          </button>
        ) : null}
        <div className="toolbar-divider" />
        <div className="label-filter-wrap" onPointerDown={(event) => event.stopPropagation()}>
          <button
            className={`toolbar-button${labelsOpen ? " active" : ""}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={labelsOpen}
            onClick={() => setLabelsOpen((open) => !open)}
          >
            <Check size={13} /> Labels
          </button>
          {labelsOpen ? (
            <div
              className="label-filter-menu signal-filter-menu"
              role="menu"
              aria-label="Label visibility"
            >
              <section>
                <strong>Visible labels</strong>
                {LABEL_OPTIONS.map((option) => (
                  <label key={option.key}>
                    <input
                      type="checkbox"
                      checked={labelSettings[option.key]}
                      onChange={() => onToggleLabel(option.key)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </section>
            </div>
          ) : null}
        </div>
        <div className="signal-filter-wrap" onPointerDown={(event) => event.stopPropagation()}>
          <button
            className={`toolbar-button${signalsOpen ? " active" : ""}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={signalsOpen}
            onClick={() => setSignalsOpen((open) => !open)}
          >
            <Radio size={13} /> Signals
            {hiddenSignalKeys.size > 0 ? (
              <span className="signal-hidden-count">{hiddenSignalKeys.size} hidden</span>
            ) : null}
          </button>
          {signalsOpen ? (
            <div className="signal-filter-menu" role="menu" aria-label="Signal visibility">
              {(["clock", "reset"] as const).map((role) => {
                const matching = controlSignals.filter((signal) => signal.role === role);
                return (
                  <section key={role}>
                    <strong>{role === "clock" ? "Clocks" : "Resets"}</strong>
                    {matching.length > 0 ? (
                      matching.map((signal) => (
                        <label key={signal.key}>
                          <input
                            type="checkbox"
                            checked={!hiddenSignalKeys.has(signal.key)}
                            onChange={() =>
                              setHiddenSignalKeys((current) => {
                                const next = new Set(current);
                                if (next.has(signal.key)) next.delete(signal.key);
                                else next.add(signal.key);
                                return next;
                              })
                            }
                          />
                          <span>{signal.name}</span>
                        </label>
                      ))
                    ) : (
                      <span className="signal-filter-empty">
                        No {role === "clock" ? "clocks" : "resets"} detected at this level.
                      </span>
                    )}
                  </section>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="toolbar-spacer" />
        <div className="canvas-view-controls">
          <button
            className={`icon-button toolbar-icon${inspectorOpen ? " active" : ""}`}
            type="button"
            onClick={onToggleInspector}
            aria-label="Toggle inspector"
          >
            <Info size={15} />
          </button>
          <button
            className="icon-button toolbar-icon"
            type="button"
            onClick={() => fitCameraViewBox && replaceCamera(fitCameraViewBox)}
            aria-label="Fit schematic"
          >
            <Focus size={15} />
          </button>
          <button
            className="icon-button toolbar-icon"
            type="button"
            onClick={() => zoom(1.18)}
            aria-label="Zoom out"
          >
            <Minus size={15} />
          </button>
          <span ref={zoomReadoutRef} className="zoom-readout">
            {layout ? "100%" : "—"}
          </span>
          <button
            className="icon-button toolbar-icon"
            type="button"
            onClick={() => zoom(0.84)}
            aria-label="Zoom in"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div
        ref={canvasWrapRef}
        className={`canvas-wrap${busy ? " busy" : ""}`}
        aria-busy={busy}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {loading && !layout ? (
          <div className="canvas-state">
            <span className="spinner" />
            Laying out graph…
          </div>
        ) : null}
        {error ? <div className="canvas-state error">Layout failed: {error}</div> : null}
        {layout ? (
          <svg
            ref={svgRef}
            className="schematic-svg"
            viewBox="0 0 1000 620"
            preserveAspectRatio="none"
          >
            <title>Interactive schematic for {renderedModule.instancePath}</title>
            <defs>
              <pattern
                ref={gridPatternRef}
                id={gridPatternId}
                width="28"
                height="28"
                patternUnits="userSpaceOnUse"
              >
                <circle cx="1" cy="1" r="0.55" fill="#d8ddda" />
              </pattern>
            </defs>
            <rect
              className="schematic-grid"
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill={`url(#${gridPatternId})`}
              opacity={0.24}
            />
          </svg>
        ) : null}
        {renderedLayout ? (
          <div ref={stageRef} className="schematic-stage">
            <svg
              ref={viewportRef}
              className="schematic-viewport"
              width="100%"
              height="100%"
              viewBox={`0 0 ${renderedLayout.width} ${renderedLayout.height}`}
              preserveAspectRatio="xMidYMid meet"
            >
              <title>Schematic graph for {renderedModule.instancePath}</title>
              <defs>
                <marker
                  id={edgeArrowId}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
                </marker>
              </defs>
              <g
                className={`top-level-layer${
                  comparison
                    ? diffClassName(
                        entityDiff(TOP_MODULE_ID),
                        diffVisibility,
                        false,
                        emphasizeDifferences,
                      )
                    : ""
                }`}
              >
                <TopLevelBoundary
                  width={renderedLayout.width}
                  height={renderedLayout.height}
                  module={renderedModule}
                  selected={selectedId === TOP_MODULE_ID}
                  hovered={hoveredId === TOP_MODULE_ID}
                  labelSettings={labelSettings}
                />
              </g>
              {comparison &&
              renderedLayout.disconnectedRegion &&
              visibleDisconnectedComponentCount > 0 ? (
                <g className="disconnected-comparison-region" aria-label="No visible connections">
                  <title>
                    Objects in this region have no routed connection to the primary visible circuit.
                  </title>
                  <rect
                    x={renderedLayout.disconnectedRegion.x}
                    y={renderedLayout.disconnectedRegion.y}
                    width={renderedLayout.disconnectedRegion.width}
                    height={renderedLayout.disconnectedRegion.height}
                    rx={8}
                  />
                  <text
                    className="disconnected-region-title"
                    x={renderedLayout.disconnectedRegion.x + 12}
                    y={renderedLayout.disconnectedRegion.y + 16}
                  >
                    NO VISIBLE CONNECTIONS
                  </text>
                  <text
                    className="disconnected-region-note"
                    x={renderedLayout.disconnectedRegion.x + 12}
                    y={renderedLayout.disconnectedRegion.y + 29}
                  >
                    {`${visibleDisconnectedComponentCount} isolated ${visibleDisconnectedComponentCount === 1 ? "component" : "components"}`}
                  </text>
                </g>
              ) : null}
              <g className="group-layer">
                {renderedLayout.groups.map((group) => {
                  const metadata = entityDiff(group.id);
                  const marker = diffMarker(metadata, emphasizeDifferences);
                  return (
                    <g
                      className={
                        comparison
                          ? diffClassName(metadata, diffVisibility, false, emphasizeDifferences)
                          : undefined
                      }
                      key={group.id}
                    >
                      <GroupBoundary
                        group={group}
                        selected={group.id === selectedId}
                        hovered={group.id === hoveredId}
                        labelSettings={labelSettings}
                      />
                      {marker ? (
                        <g
                          className={`diff-node-badge ${metadata?.status ?? "unchanged"}`}
                          transform={`translate(${group.x + group.width - 10} ${group.y + 12})`}
                        >
                          <circle r={9} />
                          <text>{marker}</text>
                        </g>
                      ) : null}
                    </g>
                  );
                })}
              </g>
              <g className="edge-layer">
                {renderedLayout.edges.map((edge) => {
                  const metadata = entityDiff(edge.id);
                  const contextVisible = changesOnlyContext.edgeIds.has(edge.id);
                  const active = highlighted.edges.has(edge.id) || hoveredId === edge.id;
                  const signalKey = controlSignalKey(slice, edge);
                  const inferredRole = controlSignalRole(slice, edge);
                  const renderedRole = semanticSide
                    ? (edge.role ?? inferredRole ?? "data")
                    : (inferredRole ?? edge.role ?? "data");
                  const hidden = signalKey ? hiddenSignalKeys.has(signalKey) : false;
                  const path = pathForSections(edge.sections);
                  const label = labelPoint(edge);
                  const labelParts = [
                    labelSettings.nets || active ? edge.label : undefined,
                    labelSettings.signalTypes ? edge.signalType : undefined,
                  ].filter((part): part is string => Boolean(part));
                  const labelText = labelParts.join(" · ");
                  const showLabel = !hidden && labelText.length > 0;
                  const showBitWidth = !hidden && labelSettings.bitWidths && (edge.width ?? 1) > 1;
                  const bitWidthText = String(edge.width ?? 1);
                  const bitWidthLabelWidth = Math.max(12, bitWidthText.length * 5.5 + 5);
                  const marker = diffMarker(metadata, emphasizeDifferences);
                  const lineLaneOffset = emphasizeDifferences
                    ? metadata?.status === "removed"
                      ? -2.5
                      : metadata?.status === "added"
                        ? 2.5
                        : 0
                    : 0;
                  const labelLaneOffset = emphasizeDifferences
                    ? metadata?.status === "removed"
                      ? -11
                      : metadata?.status === "added"
                        ? 11
                        : 0
                    : 0;
                  const accessibleLabel =
                    edge.label?.trim() ||
                    `unlabeled net from ${renderedNodeLabels.get(edge.sourceNode) ?? "source"} to ${
                      renderedNodeLabels.get(edge.targetNode) ?? "target"
                    }`;
                  return (
                    <a
                      className={`schematic-edge role-${renderedRole}${active ? " active" : ""}${hidden ? " hidden-signal" : ""}${comparison ? diffClassName(metadata, diffVisibility, contextVisible, emphasizeDifferences) : ""}`}
                      key={edge.id}
                      href={`#schematic-${encodeURIComponent(edge.id)}`}
                      data-entity-id={edge.id}
                      data-source-node={edge.sourceNode}
                      data-target-node={edge.targetNode}
                      aria-label={`Select net ${accessibleLabel}${
                        comparison
                          ? `, ${diffStatusLabel(metadata?.status ?? "unchanged")}${
                              metadata?.matchMethod === "heuristic" ? ", heuristic match" : ""
                            }${metadata?.sourceHighlighted ? ", intersects selected source hunk" : ""}`
                          : ""
                      }${contextVisible ? ", context for visible change" : ""}`}
                      tabIndex={hidden ? -1 : undefined}
                      onMouseEnter={() => updateHoveredId(edge.id)}
                      onMouseLeave={() => updateHoveredId(undefined)}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(edge.id);
                      }}
                    >
                      <path
                        className="edge-hit"
                        d={path}
                        transform={lineLaneOffset ? `translate(0 ${lineLaneOffset})` : undefined}
                      />
                      <path
                        className={`edge-line${(edge.width ?? 1) > 1 ? " bus" : ""}`}
                        d={path}
                        markerEnd={`url(#${edgeArrowId})`}
                        transform={lineLaneOffset ? `translate(0 ${lineLaneOffset})` : undefined}
                      />
                      {showLabel && label ? (
                        <g
                          className="net-label"
                          transform={`translate(${label.x + (showBitWidth ? bitWidthLabelWidth / 2 + 6 : 0)} ${label.y - 7 + labelLaneOffset})`}
                        >
                          <rect x={-4} y={-11} width={labelText.length * 6.4 + 8} height={16} />
                          <text>{labelText}</text>
                        </g>
                      ) : null}
                      {showBitWidth && label ? (
                        <g
                          className="bus-width-annotation"
                          transform={`translate(${label.x} ${label.y + labelLaneOffset})`}
                          aria-label={`${edge.width} bits`}
                        >
                          <rect
                            x={-bitWidthLabelWidth / 2}
                            y={-16}
                            width={bitWidthLabelWidth}
                            height={11}
                            rx={1.5}
                          />
                          <path d="M-3,3 L3,-3" />
                          <text y={-7}>{bitWidthText}</text>
                        </g>
                      ) : null}
                      {marker && label ? (
                        <g
                          className={`diff-edge-badge ${metadata?.status ?? "unchanged"}`}
                          transform={`translate(${label.x} ${label.y + 13 + labelLaneOffset})`}
                        >
                          <rect x={-10} y={-7} width={20} height={12} rx={5} />
                          <text>{marker}</text>
                        </g>
                      ) : null}
                    </a>
                  );
                })}
              </g>
              <g className="node-layer">
                {renderedLayout.nodes.map((node) => {
                  const metadata = entityDiff(node.id);
                  const marker = diffMarker(metadata, emphasizeDifferences);
                  const contextVisible = changesOnlyContext.nodeIds.has(node.id);
                  const boundaryHitWidth =
                    node.kind === "input" || node.kind === "output"
                      ? Math.max(node.width, node.label.length * 6.5 + 8)
                      : undefined;
                  return (
                    <a
                      className={`node-interaction${node.id === selectedId ? " selected" : ""}${
                        comparison
                          ? diffClassName(
                              metadata,
                              diffVisibility,
                              contextVisible,
                              emphasizeDifferences,
                            )
                          : ""
                      }`}
                      key={node.id}
                      href={`#schematic-${encodeURIComponent(node.id)}`}
                      data-entity-id={node.id}
                      data-layout-x={node.x}
                      data-layout-y={node.y}
                      data-layout-width={node.width}
                      data-layout-height={node.height}
                      aria-label={`Select ${node.kind} ${node.label}${
                        comparison
                          ? `, ${diffStatusLabel(metadata?.status ?? "unchanged")}${
                              metadata?.matchMethod === "heuristic" ? ", heuristic match" : ""
                            }${metadata?.sourceHighlighted ? ", intersects selected source hunk" : ""}`
                          : ""
                      }${contextVisible ? ", context for visible change" : ""}`}
                      onMouseEnter={() => updateHoveredId(node.id)}
                      onMouseMove={(event) => updateTooltipPosition(event.clientX, event.clientY)}
                      onMouseLeave={() => {
                        updateHoveredId(undefined);
                        setTooltipPosition(undefined);
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(node.id);
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        if (node.kind === "module") onOpenInstance(node.id);
                      }}
                      onContextMenu={(event) => {
                        if (node.kind !== "module") return;
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(node.id);
                        const bounds = canvasWrapRef.current?.getBoundingClientRect();
                        setContextMenu({
                          id: node.id,
                          x: event.clientX - (bounds?.left ?? 0),
                          y: event.clientY - (bounds?.top ?? 0),
                          action: "flatten",
                        });
                      }}
                    >
                      {boundaryHitWidth !== undefined ? (
                        <rect
                          className="node-hit"
                          x={
                            node.kind === "output" ? node.x + node.width - boundaryHitWidth : node.x
                          }
                          y={node.y - 22}
                          width={boundaryHitWidth}
                          height={node.height + 44}
                          rx={4}
                        />
                      ) : null}
                      {emphasizeDifferences && metadata?.status === "modified" ? (
                        <rect
                          className="diff-modified-outline"
                          x={node.x - 3}
                          y={node.y - 3}
                          width={node.width + 6}
                          height={node.height + 6}
                          rx={5}
                        />
                      ) : null}
                      {emphasizeDifferences &&
                      node.kind === "constant" &&
                      (metadata?.status === "removed" || metadata?.status === "added") ? (
                        <rect
                          className={`diff-constant-outline ${metadata.status}`}
                          x={node.x - 3}
                          y={node.y - 3}
                          width={node.width + 6}
                          height={node.height + 6}
                          rx={5}
                        />
                      ) : null}
                      <NodeShape
                        node={node}
                        selected={node.id === selectedId}
                        hovered={node.id === hoveredId}
                        labelSettings={labelSettings}
                        constantRadix={node.kind === "constant" ? constantRadix : "binary"}
                      />
                      {marker ? (
                        <g
                          className={`diff-node-badge ${metadata?.status ?? "unchanged"}`}
                          transform={`translate(${node.x + node.width - 2} ${node.y + 2})`}
                        >
                          <circle r={9} />
                          <text>{marker}</text>
                        </g>
                      ) : null}
                    </a>
                  );
                })}
              </g>
              <g className="group-interaction-layer">
                {renderedLayout.groups.map((group) => {
                  const metadata = entityDiff(group.id);
                  return (
                    <a
                      className={`group-interaction${
                        comparison
                          ? diffClassName(metadata, diffVisibility, false, emphasizeDifferences)
                          : ""
                      }`}
                      key={group.id}
                      href={`#schematic-${encodeURIComponent(group.id)}`}
                      aria-label={`Select transparent instance ${group.name}${
                        comparison
                          ? `, ${diffStatusLabel(metadata?.status ?? "unchanged")}${
                              metadata?.matchMethod === "heuristic" ? ", heuristic match" : ""
                            }${metadata?.sourceHighlighted ? ", intersects selected source hunk" : ""}`
                          : ""
                      }`}
                      onMouseEnter={() => updateHoveredId(group.id)}
                      onMouseMove={(event) => updateTooltipPosition(event.clientX, event.clientY)}
                      onMouseLeave={() => {
                        updateHoveredId(undefined);
                        setTooltipPosition(undefined);
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(group.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(group.id);
                        const bounds = canvasWrapRef.current?.getBoundingClientRect();
                        setContextMenu({
                          id: group.id,
                          x: event.clientX - (bounds?.left ?? 0),
                          y: event.clientY - (bounds?.top ?? 0),
                          action: "restore",
                        });
                      }}
                    >
                      <rect
                        className="group-hit"
                        x={group.x}
                        y={group.y}
                        width={group.width}
                        height={34}
                        rx={5}
                      />
                    </a>
                  );
                })}
              </g>
              <g
                className={`top-level-interaction-layer${
                  comparison
                    ? diffClassName(
                        entityDiff(TOP_MODULE_ID),
                        diffVisibility,
                        false,
                        emphasizeDifferences,
                      )
                    : ""
                }`}
              >
                {comparison && diffMarker(entityDiff(TOP_MODULE_ID), emphasizeDifferences) ? (
                  <g
                    className={`diff-node-badge ${entityDiff(TOP_MODULE_ID)?.status ?? "unchanged"}`}
                    transform={`translate(${renderedLayout.width - 22} 25)`}
                  >
                    <circle r={9} />
                    <text>{diffMarker(entityDiff(TOP_MODULE_ID), emphasizeDifferences)}</text>
                  </g>
                ) : null}
                <a
                  className={
                    comparison
                      ? diffClassName(
                          entityDiff(TOP_MODULE_ID),
                          diffVisibility,
                          false,
                          emphasizeDifferences,
                        ).trim()
                      : undefined
                  }
                  href={`#schematic-${encodeURIComponent(TOP_MODULE_ID)}`}
                  aria-label={`Select top-level module ${shortModuleName(renderedModule.name)}${
                    comparison
                      ? `, ${diffStatusLabel(entityDiff(TOP_MODULE_ID)?.status ?? "unchanged")}`
                      : ""
                  }`}
                  onMouseEnter={() => updateHoveredId(TOP_MODULE_ID)}
                  onMouseMove={(event) => updateTooltipPosition(event.clientX, event.clientY)}
                  onMouseLeave={() => {
                    updateHoveredId(undefined);
                    setTooltipPosition(undefined);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(TOP_MODULE_ID);
                  }}
                >
                  <rect
                    className="top-level-hit"
                    x={8}
                    y={8}
                    width={Math.max(0, renderedLayout.width - 16)}
                    height={40}
                  />
                </a>
              </g>
            </svg>
          </div>
        ) : null}
        {hoveredInstance && tooltipPosition ? (
          <div
            className="instance-config-tooltip"
            role="tooltip"
            style={{ left: tooltipPosition.x, top: tooltipPosition.y }}
          >
            <header>
              <strong>{hoveredInstance.label}</strong>
              <span>{hoveredInstance.definitionName}</span>
            </header>
            <section className="instance-config-section">
              <b>Parameters</b>
              {Object.entries(hoveredInstance.parameters ?? {}).length > 0 ? (
                Object.entries(hoveredInstance.parameters ?? {}).map(([name, value]) => (
                  <div className="instance-config-row" key={name}>
                    <span>{name}</span>
                    <code>{formatJsonValue(value)}</code>
                  </div>
                ))
              ) : (
                <small>None</small>
              )}
            </section>
            <section className="instance-config-section">
              <b>Defines</b>
              {topLevelDefines.length > 0 ? (
                topLevelDefines.map((define) => (
                  <div className="instance-config-row" key={define.name}>
                    <span>{define.name}</span>
                    <code>{define.value ?? "1"}</code>
                  </div>
                ))
              ) : (
                <small>None</small>
              )}
            </section>
          </div>
        ) : null}
        {contextMenu ? (
          <div
            className="schematic-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (contextMenu.action === "flatten") onFlattenInstance(contextMenu.id);
                else onRestoreInstance();
                setContextMenu(undefined);
              }}
            >
              {contextMenu.action === "flatten" ? (
                <>
                  <Layers3 size={14} /> Flatten selected instance
                </>
              ) : (
                <>
                  <Undo2 size={14} /> Restore selected instance
                </>
              )}
            </button>
          </div>
        ) : null}
      </div>
      <footer className="canvas-status">
        <span title={renderedModule.definitionName}>
          {shortModuleName(renderedModule.definitionName)}
        </span>
        {warnings.length ? (
          <output
            className="canvas-warning-count"
            title={warnings.join(" · ")}
            aria-label={`${warnings.length} comparison ${warnings.length === 1 ? "warning" : "warnings"}: ${warnings.join("; ")}`}
          >
            <TriangleAlert size={11} /> {warnings.length}
          </output>
        ) : null}
        <span className="status-spacer" />
        <span>{(layout?.nodes.length ?? slice.nodes.length).toLocaleString()} nodes</span>
        <span>·</span>
        <span>{(layout?.edges.length ?? slice.edges.length).toLocaleString()} nets</span>
        {layout?.groups.length ? (
          <>
            <span>·</span>
            <span>{layout.groups.length.toLocaleString()} inline</span>
          </>
        ) : null}
        <span>·</span>
        <span>{layout ? `layout ${Math.round(layout.elapsedMs)} ms` : "layout pending"}</span>
        {comparisonCounts ? (
          <>
            <span>·</span>
            <span className="diff-count removed">−{comparisonCounts.removed}</span>
            <span className="diff-count added">+{comparisonCounts.added}</span>
            {availableDiffStatuses.includes("modified") ? (
              <span
                className="diff-count modified"
                title={schematicDiffStatusDescription("modified")}
              >
                ±{comparisonCounts.modified}
              </span>
            ) : null}
            {comparisonCounts.heuristic ? (
              <span className="diff-count heuristic">≈{comparisonCounts.heuristic}</span>
            ) : null}
          </>
        ) : null}
        <span className={comparison ? "compile-ok comparison" : "compile-ok"}>
          {comparison ? <GitCompareArrows size={12} /> : <Check size={12} />}
          {comparison ? comparison.policy : "current"}
        </span>
      </footer>
    </section>
  );
}
