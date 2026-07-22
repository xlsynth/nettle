// SPDX-License-Identifier: Apache-2.0

import { CircleHelp, Search, X } from "lucide-react";
import nettleLogo from "../../../assets/nettle_logo_light.png";
import type { HeaderComparisonPresentation } from "./comparison-types";

interface AppHeaderProps {
  projectName: string;
  statusText: string;
  dataMode: DataMode;
  statusDetail?: string;
  comparison?: HeaderComparisonPresentation;
  onCloseDesign: () => void;
  onSearch: () => void;
  onHelp: () => void;
}

export type DataMode = "empty" | "loading" | "bundle" | "hosted" | "comparison";

export function LandingHeader() {
  return (
    <header className="landing-header">
      <img src={nettleLogo} alt="Nettle logo" width={28} height={28} />
      <span>NETTLE</span>
    </header>
  );
}

export function AppHeader({
  projectName,
  statusText,
  dataMode,
  statusDetail,
  comparison,
  onCloseDesign,
  onSearch,
  onHelp,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">NETTLE</div>
      <div className="header-divider" />
      <div
        className="project-name"
        title={
          comparison ? `${comparison.referenceName} → ${comparison.candidateName}` : projectName
        }
      >
        {projectName}
      </div>
      <button
        className="header-close-action"
        type="button"
        onClick={onCloseDesign}
        aria-label="Close design"
        title="Close design and return to the start page"
      >
        <X size={15} strokeWidth={1.7} />
        Close design
      </button>
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
        {dataMode === "bundle" ? (
          <span className="mode-badge local">LOCAL · NOT UPLOADED</span>
        ) : null}
        {dataMode === "hosted" ? <span className="mode-badge hosted">SHAREABLE</span> : null}
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
