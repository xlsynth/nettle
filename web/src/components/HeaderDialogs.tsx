// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  CircleHelp,
  FileCode2,
  GitBranch,
  MousePointer2,
  Search,
  X,
  ZoomIn,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileTreeEntry, GraphSlice } from "../model/graph";

interface DialogFrameProps {
  open: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

function DialogFrame({
  open,
  title,
  description,
  icon,
  closeLabel,
  onClose,
  children,
  className = "",
}: DialogFrameProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop">
      <section
        className={`utility-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            {icon}
          </span>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>{description}</p>
          </div>
          <button
            className="icon-button compact dialog-close"
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

interface SearchableFile {
  name: string;
  path: string;
  fileId?: string;
}

const flattenFiles = (entries: FileTreeEntry[]): SearchableFile[] =>
  entries.flatMap((entry) =>
    entry.kind === "file"
      ? [{ name: entry.name, path: entry.path, fileId: entry.fileId }]
      : flattenFiles(entry.children ?? []),
  );

type SearchResult =
  | { kind: "file"; key: string; label: string; detail: string; path: string; fileId?: string }
  | { kind: "entity"; key: string; label: string; detail: string; entityId: string };

interface ProjectSearchDialogProps {
  open: boolean;
  files: FileTreeEntry[];
  slice: GraphSlice;
  onClose: () => void;
  onSelectFile: (path: string, fileId?: string) => void;
  onSelectEntity: (id: string) => void;
}

export function ProjectSearchDialog({
  open,
  files,
  slice,
  onClose,
  onSelectFile,
  onSelectEntity,
}: ProjectSearchDialogProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const allFiles = useMemo(() => flattenFiles(files), [files]);
  const results = useMemo<SearchResult[]>(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    if (!needle) return [];

    const fileResults: SearchResult[] = allFiles
      .filter((file) => `${file.name} ${file.path}`.toLocaleLowerCase().includes(needle))
      .slice(0, 12)
      .map((file) => ({
        kind: "file",
        key: `file:${file.path}`,
        label: file.name,
        detail: file.path,
        path: file.path,
        fileId: file.fileId,
      }));
    const nodeResults: SearchResult[] = slice.nodes
      .filter((node) =>
        `${node.label} ${node.definitionName ?? ""} ${node.kind}`
          .toLocaleLowerCase()
          .includes(needle),
      )
      .slice(0, 12)
      .map((node) => ({
        kind: "entity",
        key: `node:${node.id}`,
        label: node.label,
        detail: node.definitionName ? `${node.kind} · ${node.definitionName}` : node.kind,
        entityId: node.id,
      }));
    const edgeResults: SearchResult[] = slice.edges
      .filter((edge) => (edge.label ?? "").toLocaleLowerCase().includes(needle))
      .slice(0, 6)
      .map((edge) => ({
        kind: "entity",
        key: `edge:${edge.id}`,
        label: edge.label ?? edge.id,
        detail: "net",
        entityId: edge.id,
      }));
    const groupResults: SearchResult[] = (slice.groups ?? [])
      .filter((group) =>
        `${group.name} ${group.definitionName}`.toLocaleLowerCase().includes(needle),
      )
      .slice(0, 6)
      .map((group) => ({
        kind: "entity",
        key: `group:${group.id}`,
        label: group.name,
        detail: `module · ${group.definitionName}`,
        entityId: group.id,
      }));
    return [...fileResults, ...nodeResults, ...edgeResults, ...groupResults].slice(0, 30);
  }, [allFiles, deferredQuery, slice.edges, slice.groups, slice.nodes]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
  }, [open]);

  const activate = (result: SearchResult) => {
    if (result.kind === "file") onSelectFile(result.path, result.fileId);
    else onSelectEntity(result.entityId);
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (results[0]) activate(results[0]);
  };

  return (
    <DialogFrame
      open={open}
      title="Search project"
      description="Find files or objects in the current schematic."
      icon={<Search size={17} strokeWidth={1.7} />}
      closeLabel="Close project search"
      onClose={onClose}
      className="search-dialog"
    >
      <form className="project-search" onSubmit={submit}>
        <label className="search-input-wrap">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            aria-label="Search files and schematic"
            placeholder="File, net, instance, or operator…"
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="search-results" aria-live="polite">
          {!query.trim() ? (
            <div className="search-empty">Type to search the repository and current hierarchy.</div>
          ) : results.length === 0 ? (
            <div className="search-empty">No matching files or schematic objects.</div>
          ) : (
            results.map((result) => (
              <button
                className="search-result"
                type="button"
                key={result.key}
                onClick={() => activate(result)}
              >
                <span className="search-result-icon" aria-hidden="true">
                  {result.kind === "file" ? <FileCode2 size={14} /> : <GitBranch size={14} />}
                </span>
                <span className="search-result-text">
                  <strong>{result.label}</strong>
                  <small>{result.detail}</small>
                </span>
                <span className="search-result-kind">
                  {result.kind === "file" ? "FILE" : "SCHEMATIC"}
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="search-footer">Enter opens the first result · Esc closes</footer>
      </form>
    </DialogFrame>
  );
}

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  return (
    <DialogFrame
      open={open}
      title="Using Nettle"
      description="Navigation and source cross-probing."
      icon={<CircleHelp size={17} strokeWidth={1.7} />}
      closeLabel="Close help"
      onClose={onClose}
      className="help-dialog"
    >
      <div className="help-content">
        <div className="help-item">
          <MousePointer2 size={16} aria-hidden="true" />
          <div>
            <strong>Select and cross-probe</strong>
            <p>
              Click a schematic object to reveal its source. Select source text to highlight it.
            </p>
          </div>
        </div>
        <div className="help-item">
          <Box size={16} aria-hidden="true" />
          <div>
            <strong>Navigate hierarchy</strong>
            <p>
              Double-click an instance to descend. Right-click it to flatten one instance, or set a
              uniform flatten depth in the toolbar.
            </p>
          </div>
        </div>
        <div className="help-item">
          <ZoomIn size={16} aria-hidden="true" />
          <div>
            <strong>Move around the schematic</strong>
            <p>Drag empty space to pan. Use the wheel, trackpad, or toolbar controls to zoom.</p>
          </div>
        </div>
      </div>
      <footer className="dialog-actions">
        <button className="dialog-button primary" type="button" onClick={onClose}>
          Got it
        </button>
      </footer>
    </DialogFrame>
  );
}
