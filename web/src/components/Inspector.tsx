// SPDX-License-Identifier: Apache-2.0

import {
  Braces,
  Code2,
  Cpu,
  GitBranch,
  GitCompareArrows,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { formatJsonValue } from "../model/format";
import type { GraphEdge, GraphNode, ModuleContext, ProjectSnapshot } from "../model/graph";
import {
  type ComparisonSelectionDetails,
  diffStatusLabel,
  matchMethodLabel,
  schematicDiffStatusDescription,
} from "./comparison-types";

interface InspectorProps {
  node?: GraphNode;
  edge?: GraphEdge;
  project: ProjectSnapshot;
  topModule: ModuleContext;
  comparison?: ComparisonSelectionDetails;
  onClose: () => void;
}

const kindLabel = (kind: GraphNode["kind"]) => kind[0].toUpperCase() + kind.slice(1);

const comparableValue = (value: unknown) =>
  value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : formatJsonValue(value as Parameters<typeof formatJsonValue>[0]);

export function Inspector({ node, edge, project, topModule, comparison, onClose }: InspectorProps) {
  const comparisonParameters = comparison
    ? [
        ...new Set([
          ...Object.keys(comparison.reference?.parameters ?? {}),
          ...Object.keys(comparison.candidate?.parameters ?? {}),
        ]),
      ].sort()
    : [];
  const comparisonRows: Array<[string, unknown, unknown]> = comparison
    ? (
        [
          ["Stable ID", comparison.reference?.id, comparison.candidate?.id],
          ["Label", comparison.reference?.label, comparison.candidate?.label],
          ["Kind", comparison.reference?.kind, comparison.candidate?.kind],
          [
            "Definition",
            comparison.reference?.definitionName,
            comparison.candidate?.definitionName,
          ],
          ["Operation", comparison.reference?.glyph, comparison.candidate?.glyph],
          ["Width", comparison.reference?.width, comparison.candidate?.width],
          ["Signal type", comparison.reference?.signalType, comparison.candidate?.signalType],
          ["Role", comparison.reference?.role, comparison.candidate?.role],
          [
            "Source endpoint",
            comparison.reference?.sourceNode
              ? `${comparison.reference.sourceNode}:${comparison.reference.sourcePort ?? ""}`
              : undefined,
            comparison.candidate?.sourceNode
              ? `${comparison.candidate.sourceNode}:${comparison.candidate.sourcePort ?? ""}`
              : undefined,
          ],
          [
            "Target endpoint",
            comparison.reference?.targetNode
              ? `${comparison.reference.targetNode}:${comparison.reference.targetPort ?? ""}`
              : undefined,
            comparison.candidate?.targetNode
              ? `${comparison.candidate.targetNode}:${comparison.candidate.targetPort ?? ""}`
              : undefined,
          ],
          ["Ports", comparison.reference?.ports, comparison.candidate?.ports],
        ] as Array<[string, unknown, unknown]>
      ).filter(
        ([, referenceValue, candidateValue]) =>
          referenceValue !== undefined || candidateValue !== undefined,
      )
    : [];
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
        {comparison ? (
          <section className="inspector-section comparison-inspector-summary">
            <h3>
              <GitCompareArrows size={13} /> Comparison
            </h3>
            <div className="comparison-inspector-status">
              <span
                className={`diff-status-badge ${comparison.status}`}
                title={schematicDiffStatusDescription(comparison.status)}
              >
                {diffStatusLabel(comparison.status)}
              </span>
              <span>{comparison.policy} matching</span>
            </div>
            <dl className="property-grid comparison-match-details">
              {comparison.matchMethod ? (
                <>
                  <dt>Matched by</dt>
                  <dd>
                    {matchMethodLabel(comparison.matchMethod)}
                    {comparison.matchMethod === "heuristic" ? " ≈" : ""}
                  </dd>
                </>
              ) : null}
              {comparison.confidence ? (
                <>
                  <dt>Confidence</dt>
                  <dd>
                    {(comparison.confidence.score * 100).toFixed(0)}% · {comparison.confidence.band}
                  </dd>
                </>
              ) : null}
            </dl>
            {comparison.confidence?.evidence.length ? (
              <ul className="comparison-evidence">
                {comparison.confidence.evidence.map((evidence) => (
                  <li key={evidence}>{evidence}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {comparison && (comparison.reference || comparison.candidate) ? (
          <section className="inspector-section comparison-before-after">
            <h3>
              <SlidersHorizontal size={13} /> Before / after
            </h3>
            <table className="comparison-property-table">
              <caption className="visually-hidden">Before and after values</caption>
              <thead>
                <tr className="comparison-property-heading">
                  <th scope="col">Property</th>
                  <th className="reference" scope="col">
                    Reference
                  </th>
                  <th className="candidate" scope="col">
                    Candidate
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map(([label, referenceValue, candidateValue]) => (
                  <tr
                    className={`comparison-property-row${comparableValue(referenceValue) !== comparableValue(candidateValue) ? " changed" : ""}`}
                    key={label}
                  >
                    <th scope="row">{label}</th>
                    <td title={comparableValue(referenceValue)}>
                      <code>{comparableValue(referenceValue)}</code>
                    </td>
                    <td title={comparableValue(candidateValue)}>
                      <code>{comparableValue(candidateValue)}</code>
                    </td>
                  </tr>
                ))}
                {comparisonParameters.map((name) => {
                  const referenceValue = comparison.reference?.parameters?.[name];
                  const candidateValue = comparison.candidate?.parameters?.[name];
                  return (
                    <tr
                      className={`comparison-property-row${JSON.stringify(referenceValue) !== JSON.stringify(candidateValue) ? " changed" : ""}`}
                      key={`parameter-${name}`}
                    >
                      <th scope="row" title={`Parameter ${name}`}>
                        {name}
                      </th>
                      <td>
                        <code>{comparableValue(referenceValue)}</code>
                      </td>
                      <td>
                        <code>{comparableValue(candidateValue)}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}

        {comparison?.reference?.origins?.length || comparison?.candidate?.origins?.length ? (
          <section className="inspector-section comparison-origins">
            <h3>
              <Code2 size={13} /> Side-specific origins
            </h3>
            <div className="comparison-origin-columns">
              {(["reference", "candidate"] as const).map((side) => (
                <div key={side}>
                  <strong>{side}</strong>
                  {comparison[side]?.origins?.length ? (
                    comparison[side]?.origins?.map((origin) => (
                      <div
                        className="origin-card"
                        key={`${side}:${origin.file}:${origin.startLine}:${origin.startColumn}`}
                      >
                        <strong>{origin.file}</strong>
                        <span className="mono">
                          {origin.startLine}:{origin.startColumn}
                        </span>
                      </div>
                    ))
                  ) : (
                    <small>Not present</small>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}

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
