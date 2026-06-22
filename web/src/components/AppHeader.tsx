// SPDX-License-Identifier: Apache-2.0

import { ChevronDown, CircleHelp, FolderOpen, Search } from "lucide-react";

interface AppHeaderProps {
  projectName: string;
  statusText: string;
  dataMode: DataMode;
  statusDetail?: string;
  onOpenProject: () => void;
  onSearch: () => void;
  onHelp: () => void;
}

export type DataMode = "empty" | "loading" | "bundle";

export function AppHeader({
  projectName,
  statusText,
  dataMode,
  statusDetail,
  onOpenProject,
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
        <span>{projectName}</span>
        <ChevronDown className="project-menu-mark" size={12} strokeWidth={1.8} />
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
        {dataMode === "bundle" ? <span className="mode-badge local">LOCAL</span> : null}
        {statusText}
        <span className="status-dot" aria-hidden="true" />
      </div>
    </header>
  );
}
