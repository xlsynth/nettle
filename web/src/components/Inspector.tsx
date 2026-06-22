// SPDX-License-Identifier: Apache-2.0

import { Braces, Code2, Cpu, GitBranch, SlidersHorizontal, X } from "lucide-react";
import { formatJsonValue } from "../model/format";
import type { GraphEdge, GraphNode, ModuleContext, ProjectSnapshot } from "../model/graph";

interface InspectorProps {
  node?: GraphNode;
  edge?: GraphEdge;
  project: ProjectSnapshot;
  topModule: ModuleContext;
  onClose: () => void;
}

const kindLabel = (kind: GraphNode["kind"]) => kind[0].toUpperCase() + kind.slice(1);

export function Inspector({ node, edge, project, topModule, onClose }: InspectorProps) {
  return (
    <aside className="inspector" aria-label="Selection inspector">
      <div className="inspector-header">
        <div>
          <span className="inspector-kicker">Inspector</span>
          <strong>{node?.label ?? edge?.label ?? "Selection"}</strong>
        </div>
        <button
          className="icon-button compact"
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <X size={14} />
        </button>
      </div>

      <div className="inspector-scroll">
        {node ? (
          <section className="inspector-section">
            <h3>
              <SlidersHorizontal size={13} /> Object
            </h3>
            <dl className="property-grid">
              <dt>Kind</dt>
              <dd>{kindLabel(node.kind)}</dd>
              <dt>Stable ID</dt>
              <dd className="mono truncate" title={node.id}>
                {node.id}
              </dd>
              {node.definitionName ? (
                <>
                  <dt>Definition</dt>
                  <dd>{node.definitionName}</dd>
                </>
              ) : null}
              {node.glyph ? (
                <>
                  <dt>Operation</dt>
                  <dd className="mono">{node.glyph}</dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        {node?.parameters && Object.keys(node.parameters).length > 0 ? (
          <section className="inspector-section">
            <h3>
              <Braces size={13} /> Concrete parameters
            </h3>
            <dl className="property-grid">
              {Object.entries(node.parameters).map(([name, value]) => (
                <div className="property-row" key={name}>
                  <dt className="mono">{name}</dt>
                  <dd className="mono" title={JSON.stringify(value)}>
                    {formatJsonValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {node?.origins?.length || edge?.origins?.length ? (
          <section className="inspector-section">
            <h3>
              <Code2 size={13} /> Source provenance
            </h3>
            {(node?.origins ?? edge?.origins ?? []).map((origin) => (
              <div
                className="origin-card"
                key={`${origin.file}:${origin.startLine}:${origin.startColumn}`}
              >
                <strong>{origin.file}</strong>
                <span className="mono">
                  {origin.startLine}:{origin.startColumn}
                </span>
                <span>
                  {origin.role ?? "source"} · {origin.quality ?? "exact"}
                </span>
              </div>
            ))}
          </section>
        ) : null}

        <section className="inspector-section">
          <h3>
            <Braces size={13} /> Current top parameters
          </h3>
          {Object.entries(topModule.parameters).length > 0 ? (
            Object.entries(topModule.parameters).map(([name, value]) => (
              <div className="define-row" key={name}>
                <span className="mono define-name">{name}</span>
                <span className="mono">{formatJsonValue(value)}</span>
                <small>{topModule.name}</small>
              </div>
            ))
          ) : (
            <small>None</small>
          )}
        </section>

        <section className="inspector-section">
          <h3>
            <GitBranch size={13} /> Build defines
          </h3>
          {project.effectiveElaboration.defines.length > 0 ? (
            project.effectiveElaboration.defines.map((define) => {
              const source = project.defines.find(
                (candidate) => candidate.name === define.name && candidate.value === define.value,
              );
              return (
                <div className="define-row" key={define.name}>
                  <span className="mono define-name">{define.name}</span>
                  <span className="mono">{define.value ?? ""}</span>
                  <small>{source?.origin ?? "effective override"}</small>
                </div>
              );
            })
          ) : (
            <small>None</small>
          )}
        </section>

        {project.effectiveElaboration.undefines.length > 0 ? (
          <section className="inspector-section">
            <h3>
              <Code2 size={13} /> Build undefines
            </h3>
            {project.effectiveElaboration.undefines.map((name) => (
              <div className="define-row" key={name}>
                <span className="mono define-name">{name}</span>
                <span className="mono">undefined</span>
                <small>effective configuration</small>
              </div>
            ))}
          </section>
        ) : null}

        {project.tools.length > 0 ? (
          <section className="inspector-section">
            <h3>
              <Cpu size={13} /> Compilation
            </h3>
            {project.tools.map((tool) => (
              <div className="tool-row" key={tool.name} title={tool.path}>
                <strong>{tool.name}</strong>
                <span className="mono">{tool.version}</span>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
