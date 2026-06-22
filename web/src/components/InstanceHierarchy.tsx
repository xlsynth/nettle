// SPDX-License-Identifier: Apache-2.0

import { Braces, ChevronDown, ChevronRight, GitFork, LoaderCircle, Network } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode, GraphSlice } from "../model/graph";

interface InstanceHierarchyProps {
  root: GraphSlice;
  activeInstancePath: string;
  loadChild: (parent: GraphSlice, instance: GraphNode, signal: AbortSignal) => Promise<GraphSlice>;
  onNavigate: (stack: GraphSlice[]) => void;
  onShowSource: () => void;
}

interface InstanceRowProps {
  instance?: GraphNode;
  stack: GraphSlice[];
  activeInstancePath: string;
  loadChild: InstanceHierarchyProps["loadChild"];
  onNavigate: InstanceHierarchyProps["onNavigate"];
  depth: number;
}

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
  depth,
}: InstanceRowProps) {
  const parent = stack.at(-1) as GraphSlice;
  const [child, setChild] = useState<GraphSlice>();
  const [open, setOpen] = useState(instance === undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => request.current?.abort(), []);

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

  const activate = async () => {
    if (!instance) {
      onNavigate(stack);
      return;
    }
    const loaded = await ensureChild();
    if (loaded) onNavigate([...stack, loaded]);
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
        className={`hierarchy-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 15 }}
        role="treeitem"
        tabIndex={-1}
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={canExpand ? open : undefined}
      >
        <button
          className="hierarchy-disclosure"
          type="button"
          aria-label={`${open ? "Collapse" : "Expand"} ${instance?.label ?? parent.module.name}`}
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
          aria-label={`${instance?.label ?? parent.module.name} (${instance?.definitionName ?? parent.module.definitionName})`}
          onClick={() => void activate()}
        >
          {instance ? <GitFork size={14} /> : <Network size={14} />}
          <span>{instance?.label ?? parent.module.name}</span>
          <small>{instance?.definitionName ?? parent.module.definitionName}</small>
        </button>
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
