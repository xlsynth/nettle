// SPDX-License-Identifier: Apache-2.0

import { ChevronDown, CircleHelp, FolderOpen, GitCompareArrows, Search } from "lucide-react";
import type { HeaderComparisonPresentation } from "./comparison-types";

interface AppHeaderProps {
  projectName: string;
  statusText: string;
  dataMode: DataMode;
  statusDetail?: string;
  comparison?: HeaderComparisonPresentation;
  onOpenProject: () => void;
  onCompareBundles?: () => void;
  onSearch: () => void;
  onHelp: () => void;
}

export type DataMode = "empty" | "loading" | "bundle" | "comparison";

export function AppHeader({
  projectName,
  statusText,
  dataMode,
  statusDetail,
  comparison,
  onOpenProject,
  onCompareBundles,
  onSearch,
  onHelp,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">NETTLE</div>
      <div className="header-divider" />
      <button
        className="project-title"
        type="button"
        onClick={onOpenProject}
        aria-label="Open bundle"
        title="Open a .nettle bundle"
      >
        <FolderOpen size={16} strokeWidth={1.7} />
        <span
          title={
            comparison ? `${comparison.referenceName} → ${comparison.candidateName}` : undefined
          }
        >
          {comparison ? `${comparison.referenceName} → ${comparison.candidateName}` : projectName}
        </span>
        <ChevronDown className="project-menu-mark" size={12} strokeWidth={1.8} />
      </button>
      {onCompareBundles ? (
        <button
          className="header-compare-action"
          type="button"
          onClick={onCompareBundles}
          aria-label="Compare Nettle bundles"
          title="Compare two .nettle bundles"
        >
          <GitCompareArrows size={15} strokeWidth={1.7} />
          Compare
        </button>
      ) : null}
      <div className="header-spacer" />
      <button
        className="icon-button quiet"
        type="button"
        aria-label="Search project"
        title="Search project"
        onClick={onSearch}
      >
        <Search size={18} strokeWidth={1.6} />
      </button>
      <button
        className="icon-button quiet"
        type="button"
        aria-label="Help"
        title="Interaction help"
        onClick={onHelp}
      >
        <CircleHelp size={18} strokeWidth={1.6} />
      </button>
      <div className={`viewer-status ${dataMode}`} title={statusDetail}>
        {dataMode === "bundle" ? <span className="mode-badge local">LOCAL</span> : null}
        {comparison ? (
          <>
            <span className="mode-badge diff">DIFF</span>
            <span className="matching-badge">
              {comparison.policy}
              {comparison.sourceChanges !== undefined
                ? ` · ${comparison.sourceChanges} source changes`
                : ""}
              {comparison.heuristicMatches ? ` · ${comparison.heuristicMatches} ≈` : ""}
            </span>
          </>
        ) : null}
        {statusText}
        <span className="status-dot" aria-hidden="true" />
      </div>
    </header>
  );
}
