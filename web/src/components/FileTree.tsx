// SPDX-License-Identifier: Apache-2.0

import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { memo, useState } from "react";
import type { FileTreeEntry } from "../model/graph";

export type FileTreeDiffStatus = "unchanged" | "added" | "removed" | "modified" | "renamed";

interface FileTreeProps {
  entries: FileTreeEntry[];
  selectedPath: string;
  onSelect: (path: string, fileId?: string) => void;
  statusByPath?: Readonly<Record<string, FileTreeDiffStatus | undefined>>;
  onRefresh?: () => void;
  refreshing?: boolean;
}

interface TreeRowProps extends FileTreeProps {
  entry: FileTreeEntry;
  depth: number;
}

const fileStatusMarker = (status: FileTreeDiffStatus) => {
  switch (status) {
    case "added":
      return { marker: "A", label: "Added in candidate" };
    case "removed":
      return { marker: "D", label: "Missing from candidate" };
    case "modified":
      return { marker: "M", label: "Modified" };
    case "renamed":
      return { marker: "R", label: "Renamed" };
    case "unchanged":
      return { marker: "=", label: "Unchanged" };
  }
};

const TreeRow = memo(function TreeRow({
  entry,
  depth,
  selectedPath,
  onSelect,
  statusByPath,
}: TreeRowProps) {
  const [open, setOpen] = useState(depth < 2);
  const directory = entry.kind === "directory";
  const selected = entry.path === selectedPath;
  const status = directory ? undefined : statusByPath?.[entry.path];
  const statusMarker = status ? fileStatusMarker(status) : undefined;
  const activate = () => {
    if (directory) setOpen((value) => !value);
    else onSelect(entry.path, entry.fileId);
  };

  return (
    <>
      <button
        className={`tree-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 15 }}
        type="button"
        onClick={activate}
        title={entry.path}
      >
        <span className="tree-disclosure" aria-hidden="true">
          {directory ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        {directory ? (
          open ? (
            <FolderOpen size={14} strokeWidth={1.5} />
          ) : (
            <Folder size={14} strokeWidth={1.5} />
          )
        ) : (
          <FileCode2 size={14} strokeWidth={1.5} />
        )}
        <span className="tree-entry-name">{entry.name}</span>
        {status && statusMarker ? (
          <span className={`tree-diff-badge ${status}`} title={statusMarker.label}>
            <span aria-hidden="true">{statusMarker.marker}</span>
            <span className="visually-hidden">{statusMarker.label}</span>
          </span>
        ) : null}
      </button>
      {directory && open
        ? entry.children?.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              entries={[]}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              statusByPath={statusByPath}
            />
          ))
        : null}
    </>
  );
});

export function FileTree({
  entries,
  selectedPath,
  onSelect,
  statusByPath,
  onRefresh,
  refreshing = false,
}: FileTreeProps) {
  return (
    <aside className="file-tree" aria-label="Source files">
      <div className="pane-header">
        <span>Sources</span>
        {onRefresh ? (
          <button
            className="icon-button compact"
            type="button"
            aria-label="Refresh files"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={13} strokeWidth={1.6} />
          </button>
        ) : null}
      </div>
      <div className="tree-scroll">
        {entries.map((entry) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            entries={entries}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
            statusByPath={statusByPath}
          />
        ))}
      </div>
    </aside>
  );
}
