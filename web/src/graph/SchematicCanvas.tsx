// SPDX-License-Identifier: Apache-2.0

import {
  ArrowUp,
  Check,
  ChevronDown,
  Focus,
  Home,
  Info,
  Layers3,
  Minus,
  Plus,
  Radio,
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
import { formatJsonValue } from "../model/format";
import type { GraphEdge, GraphSlice } from "../model/graph";
import {
  type CameraViewBox,
  cameraTransform,
  constrainedCameraSize,
  panCameraByScreenDelta,
  resizeCameraAt,
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
}

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
        width={width - 16}
        height={height - 16}
        rx={7}
      />
      <path className="top-level-header-rule" d={`M8,48 H${width - 8}`} />
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

export function SchematicCanvas({
  slice,
  selectedId,
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
}: SchematicCanvasProps) {
  const gridPatternId = useId().replaceAll(":", "");
  const edgeArrowId = useId().replaceAll(":", "");
  const [hiddenSignalKeys, setHiddenSignalKeys] = useState<Set<string>>(() => new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [flattenModesOpen, setFlattenModesOpen] = useState(false);
  const [layoutProfilesOpen, setLayoutProfilesOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    { id: string; x: number; y: number; action: "flatten" | "restore" } | undefined
  >();
  const controlSignals = useMemo(() => detectedControlSignals(slice), [slice]);
  const { layout, loading, error } = useLayout(slice, layoutProfile, flattenRenderMode);
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
  const committedCameraRef = useRef<CameraViewBox>(cameraRef.current);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const highlighted = useMemo(
    () => getHighlighted(selectedId, slice.edges),
    [selectedId, slice.edges],
  );

  useEffect(() => {
    setHiddenSignalKeys((current) => {
      const available = new Set(controlSignals.map((signal) => signal.key));
      const retained = new Set([...current].filter((key) => available.has(key)));
      return retained.size === current.size ? current : retained;
    });
  }, [controlSignals]);

  useEffect(() => {
    if (!contextMenu && !labelsOpen && !signalsOpen && !flattenModesOpen && !layoutProfilesOpen)
      return;
    const dismiss = () => {
      setContextMenu(undefined);
      setLabelsOpen(false);
      setSignalsOpen(false);
      setFlattenModesOpen(false);
      setLayoutProfilesOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu, flattenModesOpen, labelsOpen, layoutProfilesOpen, signalsOpen]);

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
    if (!layout?.width || !layout.height) return;
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = undefined;
    const camera = { x: 0, y: 0, width: layout.width, height: layout.height };
    cameraRef.current = camera;
    committedCameraRef.current = camera;
    viewportRef.current?.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    applyCamera(camera);
    if (stageRef.current) {
      stageRef.current.style.transform = "none";
    }
  }, [applyCamera, layout]);

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
    const maxWidth = Math.max(10000, (layout?.width ?? current.width) * 4);
    const maxHeight = Math.max(7000, (layout?.height ?? current.height) * 4);
    const nextSize = constrainedCameraSize(current, factor, {
      minWidth: 160,
      minHeight: 100,
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
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratioX = (event.clientX - rect.left) / rect.width;
    const ratioY = (event.clientY - rect.top) / rect.height;
    const factor = wheelZoomFactor(event.deltaY, event.deltaMode, rect.height);
    const current = cameraRef.current;
    const maxWidth = Math.max(10000, (layout?.width ?? current.width) * 4);
    const maxHeight = Math.max(7000, (layout?.height ?? current.height) * 4);
    const nextSize = constrainedCameraSize(current, factor, {
      minWidth: 160,
      minHeight: 100,
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
    if (event.button !== 0 || !svgRef.current) return;
    if ((event.target as Element).closest(".node-interaction, .group-interaction, .schematic-edge"))
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

  const hoveredNode = layout?.nodes.find((node) => node.id === hoveredId);
  const hoveredGroup = layout?.groups.find((group) => group.id === hoveredId);
  const hoveredInstance =
    hoveredNode?.kind === "module"
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
  const breadcrumbs = slice.module.instancePath.split(".");

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
          onClick={() =>
            layout && setCamera({ x: 0, y: 0, width: layout.width, height: layout.height })
          }
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

      <div
        ref={canvasWrapRef}
        className="canvas-wrap"
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
            <title>Interactive schematic for {slice.module.instancePath}</title>
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
        {layout ? (
          <div ref={stageRef} className="schematic-stage">
            <svg
              ref={viewportRef}
              className="schematic-viewport"
              width="100%"
              height="100%"
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              preserveAspectRatio="xMidYMid meet"
            >
              <title>Schematic graph for {slice.module.instancePath}</title>
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
              <g className="top-level-layer">
                <TopLevelBoundary
                  width={layout.width}
                  height={layout.height}
                  module={slice.module}
                  selected={selectedId === TOP_MODULE_ID}
                  hovered={hoveredId === TOP_MODULE_ID}
                  labelSettings={labelSettings}
                />
              </g>
              <g className="group-layer">
                {layout.groups.map((group) => (
                  <GroupBoundary
                    key={group.id}
                    group={group}
                    selected={group.id === selectedId}
                    hovered={group.id === hoveredId}
                    labelSettings={labelSettings}
                  />
                ))}
              </g>
              <g className="edge-layer">
                {layout.edges.map((edge) => {
                  const active = highlighted.edges.has(edge.id) || hoveredId === edge.id;
                  const signalKey = controlSignalKey(slice, edge);
                  const renderedRole = controlSignalRole(slice, edge) ?? edge.role ?? "data";
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
                  return (
                    <a
                      className={`schematic-edge role-${renderedRole}${active ? " active" : ""}${hidden ? " hidden-signal" : ""}`}
                      key={edge.id}
                      href={`#schematic-${encodeURIComponent(edge.id)}`}
                      aria-label={`Select net ${edge.label ?? edge.id}`}
                      tabIndex={hidden ? -1 : undefined}
                      onMouseEnter={() => updateHoveredId(edge.id)}
                      onMouseLeave={() => updateHoveredId(undefined)}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelect(edge.id);
                      }}
                    >
                      <path className="edge-hit" d={path} />
                      <path
                        className={`edge-line${(edge.width ?? 1) > 1 ? " bus" : ""}`}
                        d={path}
                        markerEnd={`url(#${edgeArrowId})`}
                      />
                      {showLabel && label ? (
                        <g
                          className="net-label"
                          transform={`translate(${label.x + (showBitWidth ? bitWidthLabelWidth / 2 + 6 : 0)} ${label.y - 7})`}
                        >
                          <rect x={-4} y={-11} width={labelText.length * 6.4 + 8} height={16} />
                          <text>{labelText}</text>
                        </g>
                      ) : null}
                      {showBitWidth && label ? (
                        <g
                          className="bus-width-annotation"
                          transform={`translate(${label.x} ${label.y})`}
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
                    </a>
                  );
                })}
              </g>
              <g className="node-layer">
                {layout.nodes.map((node) => (
                  <a
                    className="node-interaction"
                    key={node.id}
                    href={`#schematic-${encodeURIComponent(node.id)}`}
                    aria-label={`Select ${node.kind} ${node.label}`}
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
                    <NodeShape
                      node={node}
                      selected={node.id === selectedId}
                      hovered={node.id === hoveredId}
                      labelSettings={labelSettings}
                      constantRadix={node.kind === "constant" ? constantRadix : "binary"}
                    />
                  </a>
                ))}
              </g>
              <g className="group-interaction-layer">
                {layout.groups.map((group) => (
                  <a
                    className="group-interaction"
                    key={group.id}
                    href={`#schematic-${encodeURIComponent(group.id)}`}
                    aria-label={`Select transparent instance ${group.name}`}
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
                ))}
              </g>
              <g className="top-level-interaction-layer">
                <a
                  href={`#schematic-${encodeURIComponent(TOP_MODULE_ID)}`}
                  aria-label={`Select top-level module ${shortModuleName(slice.module.name)}`}
                  onMouseEnter={() => updateHoveredId(TOP_MODULE_ID)}
                  onMouseLeave={() => updateHoveredId(undefined)}
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
                    width={layout.width - 16}
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
        <span title={slice.module.definitionName}>
          {shortModuleName(slice.module.definitionName)}
        </span>
        <span className="status-spacer" />
        <span>{slice.nodes.length.toLocaleString()} nodes</span>
        <span>·</span>
        <span>{slice.edges.length.toLocaleString()} nets</span>
        {layout?.groups.length ? (
          <>
            <span>·</span>
            <span>{layout.groups.length.toLocaleString()} inline</span>
          </>
        ) : null}
        <span>·</span>
        <span>{layout ? `layout ${Math.round(layout.elapsedMs)} ms` : "layout pending"}</span>
        <span className="compile-ok">
          <Check size={12} /> current
        </span>
      </footer>
    </section>
  );
}
