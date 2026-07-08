// SPDX-License-Identifier: Apache-2.0

import { Braces, ChevronDown, ChevronRight, GitFork, LoaderCircle, Network } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GraphNode, GraphSlice } from "../model/graph";
import { type DiffStatus, diffStatusLabel } from "./comparison-types";

type InstanceDiffStatusResolver = (
  parent: GraphSlice,
  instance: GraphNode | undefined,
) => DiffStatus | undefined;

export type DescendantChangeStatus = "contains" | "none" | "unknown";

type DescendantChangeResolver = (
  parent: GraphSlice,
  instance: GraphNode,
  signal: AbortSignal,
) => Promise<DescendantChangeStatus>;

interface InstanceHierarchyProps {
  root: GraphSlice;
  activeInstancePath: string;
  loadChild: (parent: GraphSlice, instance: GraphNode, signal: AbortSignal) => Promise<GraphSlice>;
  onNavigate: (stack: GraphSlice[]) => void;
  onShowSource: () => void;
  diffStatusFor?: InstanceDiffStatusResolver;
  descendantChangesFor?: DescendantChangeResolver;
}

interface InstanceRowProps {
  instance?: GraphNode;
  stack: GraphSlice[];
  activeInstancePath: string;
  loadChild: InstanceHierarchyProps["loadChild"];
  onNavigate: InstanceHierarchyProps["onNavigate"];
  diffStatusFor?: InstanceDiffStatusResolver;
  descendantChangesFor?: DescendantChangeResolver;
  depth: number;
}

const diffStatusMarker = (status: DiffStatus) => {
  switch (status) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "modified":
      return "M";
    case "unchanged":
      return "=";
  }
};

const moduleInstances = (slice: GraphSlice) =>
  slice.nodes.filter(
    (node): node is GraphNode & { definitionName: string } =>
      node.kind === "module" && Boolean(node.definitionName),
  );

function InstanceRow({
  instance,
  stack,
  activeInstancePath,
  loadChild,
  onNavigate,
  diffStatusFor,
  descendantChangesFor,
  depth,
}: InstanceRowProps) {
  const parent = stack.at(-1) as GraphSlice;
  const [child, setChild] = useState<GraphSlice>();
  const [open, setOpen] = useState(instance === undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [descendantChangeStatus, setDescendantChangeStatus] = useState<DescendantChangeStatus>();
  const request = useRef<AbortController | undefined>(undefined);
  const descendantRequest = useRef<AbortController | undefined>(undefined);
  const statusDescriptionId = useId();
  const descendantStatusDescriptionId = useId();

  useEffect(
    () => () => {
      request.current?.abort();
      descendantRequest.current?.abort();
    },
    [],
  );

  useEffect(() => {
    descendantRequest.current?.abort();
    setDescendantChangeStatus(undefined);
    if (!instance || !descendantChangesFor) return;
    const controller = new AbortController();
    descendantRequest.current = controller;
    void descendantChangesFor(parent, instance, controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setDescendantChangeStatus(status);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDescendantChangeStatus("unknown");
      });
    return () => controller.abort();
  }, [descendantChangesFor, instance, parent]);

  const ensureChild = useCallback(async () => {
    if (!instance) return parent;
    if (child) return child;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const loaded = await loadChild(parent, instance, controller.signal);
      if (!controller.signal.aborted) setChild(loaded);
      return loaded;
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      return undefined;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [child, instance, loadChild, parent]);

  const slice = instance ? child : parent;
  const rowPath = slice?.module.instancePath ?? `${parent.module.instancePath}.${instance?.label}`;
  const children = slice ? moduleInstances(slice) : [];
  const selected = rowPath === activeInstancePath;
  const canExpand = instance ? child === undefined || children.length > 0 : children.length > 0;
  const diffStatus = diffStatusFor?.(parent, instance);
  const instanceLabel = instance?.label ?? parent.module.name;
  const definitionLabel = instance?.definitionName ?? parent.module.definitionName;
  const statusLabel = diffStatus ? diffStatusLabel(diffStatus) : undefined;
  const containsDescendantChanges = descendantChangeStatus === "contains";
  const descendantChangeUnknown = descendantChangeStatus === "unknown";
  const accessibleStatuses = [
    ...(statusLabel ? [statusLabel] : []),
    ...(containsDescendantChanges ? ["Contains changes"] : []),
    ...(descendantChangeUnknown ? ["Change status unknown"] : []),
  ];

  const activate = async () => {
    if (!instance) {
      onNavigate(stack);
      return;
    }
    const loaded = await ensureChild();
    if (loaded) {
      setOpen(true);
      onNavigate([...stack, loaded]);
    }
  };

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    const loaded = instance ? await ensureChild() : parent;
    if (loaded) setOpen(true);
  };

  return (
    <>
      <div
        className={`hierarchy-row${selected ? " selected" : ""}${
          diffStatus ? ` diff-status-${diffStatus}` : ""
        }${containsDescendantChanges ? " contains-descendant-changes" : ""}${
          descendantChangeUnknown ? " descendant-change-unknown" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 15 }}
        role="treeitem"
        aria-label={
          accessibleStatuses.length > 0
            ? `${instanceLabel} (${definitionLabel}), ${accessibleStatuses.join(", ")}`
            : undefined
        }
        tabIndex={-1}
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={canExpand ? open : undefined}
      >
        <button
          className="hierarchy-disclosure"
          type="button"
          aria-label={`${open ? "Collapse" : "Expand"} ${instanceLabel}`}
          onClick={() => void toggle()}
          disabled={!canExpand || loading}
        >
          {loading ? (
            <LoaderCircle className="source-state-spinner" size={12} />
          ) : canExpand ? (
            open ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : null}
        </button>
        <button
          className="hierarchy-instance"
          type="button"
          title={rowPath}
          aria-label={`${instanceLabel} (${definitionLabel})`}
          aria-describedby={
            accessibleStatuses.length > 0
              ? [
                  ...(statusLabel ? [statusDescriptionId] : []),
                  ...(containsDescendantChanges ? [descendantStatusDescriptionId] : []),
                  ...(descendantChangeUnknown ? [descendantStatusDescriptionId] : []),
                ].join(" ")
              : undefined
          }
          onClick={() => void activate()}
        >
          {instance ? <GitFork size={14} /> : <Network size={14} />}
          <span>{instanceLabel}</span>
          <small>{definitionLabel}</small>
        </button>
        {diffStatus || containsDescendantChanges || descendantChangeUnknown ? (
          <span className="hierarchy-status-badges">
            {diffStatus && statusLabel ? (
              <span
                id={statusDescriptionId}
                className={`tree-diff-badge hierarchy-diff-badge ${diffStatus}`}
                title={statusLabel}
              >
                <span aria-hidden="true">{diffStatusMarker(diffStatus)}</span>
                <span className="visually-hidden">{statusLabel}</span>
              </span>
            ) : null}
            {containsDescendantChanges ? (
              <span
                id={descendantStatusDescriptionId}
                className="tree-diff-badge hierarchy-diff-badge contains-changes"
                title={`Contains changes in ${rowPath}`}
              >
                <span aria-hidden="true">C</span>
                <span className="visually-hidden">Contains changes</span>
              </span>
            ) : null}
            {descendantChangeUnknown ? (
              <span
                id={descendantStatusDescriptionId}
                className="tree-diff-badge hierarchy-diff-badge change-status-unknown"
                title={`Descendant change status unknown for ${rowPath}`}
              >
                <span aria-hidden="true">?</span>
                <span className="visually-hidden">Change status unknown</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="hierarchy-error" style={{ paddingLeft: 35 + depth * 15 }} role="alert">
          {error}
        </div>
      ) : null}
      {open && slice
        ? children.map((next) => (
            <InstanceRow
              key={`${slice.module.instancePath}:${next.id}`}
              instance={next}
              stack={instance ? [...stack, slice] : stack}
              activeInstancePath={activeInstancePath}
              loadChild={loadChild}
              onNavigate={onNavigate}
              diffStatusFor={diffStatusFor}
              descendantChangesFor={descendantChangesFor}
              depth={depth + 1}
            />
          ))
        : null}
    </>
  );
}

export function InstanceHierarchy({
  root,
  activeInstancePath,
  loadChild,
  onNavigate,
  onShowSource,
  diffStatusFor,
  descendantChangesFor,
}: InstanceHierarchyProps) {
  const rootStack = useMemo(() => [root], [root]);
  return (
    <section className="source-pane hierarchy-pane" aria-label="Instance hierarchy">
      <div className="source-tabbar">
        <div className="pane-view-tabs" role="tablist" aria-label="Left pane view">
          <button
            className="pane-view-tab"
            type="button"
            role="tab"
            aria-selected="false"
            onClick={onShowSource}
          >
            <Braces size={13} /> Source
          </button>
          <button className="pane-view-tab active" type="button" role="tab" aria-selected="true">
            <GitFork size={13} /> Hierarchy
          </button>
        </div>
      </div>
      <div className="hierarchy-scroll" role="tree" aria-label="Design instances">
        <InstanceRow
          stack={rootStack}
          activeInstancePath={activeInstancePath}
          loadChild={loadChild}
          onNavigate={onNavigate}
          diffStatusFor={diffStatusFor}
          descendantChangesFor={descendantChangesFor}
          depth={0}
        />
      </div>
      <footer className="source-status">
        <span>{activeInstancePath}</span>
        <span>Instance hierarchy</span>
      </footer>
    </section>
  );
}
