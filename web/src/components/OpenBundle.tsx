// SPDX-License-Identifier: Apache-2.0

import {
  AlertCircle,
  ArrowLeftRight,
  FileArchive,
  FolderOpen,
  GitCompareArrows,
  Hammer,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useEffect, useId, useRef, useState } from "react";
import type { Demo } from "../demos";
import type { ViewerMode } from "../viewer-mode";
import type { MatchingPolicy } from "./comparison-types";

interface BundlePickerProps {
  loading: boolean;
  error?: string;
  onSelect: (file: File) => void;
}

const useBundlePicker = (onSelect: (file: File) => void) => {
  const input = useRef<HTMLInputElement>(null);
  const selectInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onSelect(file);
    event.target.value = "";
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files[0];
    if (file) onSelect(file);
  };
  return { input, selectInput, drop };
};

function BundleDropTarget({ loading, error, onSelect }: BundlePickerProps) {
  const { input, selectInput, drop } = useBundlePicker(onSelect);
  const [dragging, setDragging] = useState(false);
  return (
    <div>
      <button
        className={`bundle-drop-target${dragging ? " dragging" : ""}`}
        type="button"
        disabled={loading}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          drop(event);
        }}
      >
        <FileArchive size={30} strokeWidth={1.4} />
        <strong>{loading ? "Opening bundle…" : "Choose a .nettle bundle"}</strong>
        <span>or drop it here</span>
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept=".nettle,application/zip"
        aria-label="Choose a .nettle bundle"
        disabled={loading}
        tabIndex={-1}
        onChange={selectInput}
      />
      {error ? (
        <div className="bundle-open-error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

interface BundleWelcomeProps extends BundlePickerProps {
  mode: ViewerMode;
  onCompare?: () => void;
  demos?: readonly Demo[];
  onOpenDemo?: (demo: Demo) => void;
  onUploadBundle?: () => void;
  onUploadSources?: () => void;
}

export function BundleWelcome({
  mode,
  onCompare,
  demos,
  onOpenDemo,
  onUploadBundle,
  onUploadSources,
  loading,
  error,
  onSelect,
}: BundleWelcomeProps) {
  const demoTitleId = useId();
  const { input, selectInput, drop } = useBundlePicker(onSelect);
  const [dragging, setDragging] = useState(false);
  const staticMode = mode === "static";
  return (
    <main className={`bundle-welcome ${mode}`}>
      <div className={`bundle-welcome-card ${mode}`}>
        <div className={`bundle-mode-badge ${mode}`}>
          {staticMode ? "Static mode" : "Hosted mode"}
        </div>
        <h1>{staticMode ? "Explore an elaborated design" : "Open a design"}</h1>
        <p>
          {staticMode
            ? "Open a .nettle bundle in your browser or try an example."
            : "Open locally, create a shareable session, or build from RTL sources."}
        </p>
        <div className={`bundle-workflows ${mode}`}>
          <button
            className={`bundle-workflow local${dragging ? " dragging" : ""}`}
            type="button"
            aria-label="Open a .nettle bundle"
            disabled={loading}
            onClick={() => input.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              setDragging(false);
              drop(event);
            }}
          >
            {staticMode ? (
              <FileArchive size={24} strokeWidth={1.5} />
            ) : (
              <FolderOpen size={24} strokeWidth={1.5} />
            )}
            <span>
              <strong>{loading ? "Opening bundle…" : "Open a .nettle bundle"}</strong>
              <small>{staticMode ? "Choose or drop a file" : "Keep it in this browser"}</small>
            </span>
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept=".nettle,application/zip"
            aria-label="Open a .nettle bundle locally"
            disabled={loading}
            tabIndex={-1}
            onChange={selectInput}
          />
          {!staticMode && onUploadBundle ? (
            <button
              className="bundle-workflow hosted"
              type="button"
              aria-label="Upload a bundle"
              disabled={loading}
              onClick={onUploadBundle}
            >
              <UploadCloud size={24} strokeWidth={1.5} />
              <span>
                <strong>Upload a bundle</strong>
                <small>Create a shareable session</small>
              </span>
            </button>
          ) : null}
          {!staticMode && onUploadSources ? (
            <button
              className="bundle-workflow hosted"
              type="button"
              aria-label="Build from RTL sources"
              disabled={loading}
              onClick={onUploadSources}
            >
              <Hammer size={24} strokeWidth={1.5} />
              <span>
                <strong>Build from RTL sources</strong>
                <small>Compile and create a shareable session</small>
              </span>
            </button>
          ) : null}
          {!staticMode && onCompare ? (
            <button
              className="bundle-workflow compare"
              type="button"
              aria-label="Compare two bundles"
              disabled={loading}
              onClick={onCompare}
            >
              <GitCompareArrows size={24} strokeWidth={1.5} />
              <span>
                <strong>Compare two bundles</strong>
                <small>Keep both files in this browser</small>
              </span>
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="bundle-open-error" role="alert">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        ) : null}
        {demos && onOpenDemo ? (
          <section className="demo-examples" aria-labelledby={demoTitleId}>
            <h2 id={demoTitleId}>Try an example</h2>
            <div className="demo-example-list">
              {demos.map((demo) => (
                <button
                  key={demo.id}
                  className="demo-example"
                  type="button"
                  disabled={loading}
                  onClick={() => onOpenDemo(demo)}
                >
                  <strong>{demo.title}</strong>
                  <span>{demo.description}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <div className="bundle-privacy-note">
          <ShieldCheck size={15} />
          <span>
            {staticMode
              ? "Files stay in your browser."
              : "Local files stay in your browser unless you choose an upload action."}
          </span>
        </div>
      </div>
    </main>
  );
}

interface OpenBundleDialogProps extends BundlePickerProps {
  open: boolean;
  onClose: () => void;
}

export function OpenBundleDialog({
  open,
  loading,
  error,
  onSelect,
  onClose,
}: OpenBundleDialogProps) {
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <section
        className="open-bundle-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            <FolderOpen size={17} strokeWidth={1.7} />
          </span>
          <div>
            <h2 id={titleId}>Open Nettle bundle</h2>
            <p>Replace the current in-memory workspace.</p>
          </div>
          <button
            className="icon-button compact dialog-close"
            type="button"
            aria-label="Close open bundle dialog"
            onClick={onClose}
            disabled={loading}
          >
            <X size={15} />
          </button>
        </header>
        <div className="open-bundle-body">
          <div className="local-open-disclosure">
            <ShieldCheck size={16} />
            <span>
              This file stays in your browser and is not uploaded. No shareable URL is created;
              reloading or closing this page discards the session.
            </span>
          </div>
          <BundleDropTarget loading={loading} error={error} onSelect={onSelect} />
        </div>
      </section>
    </div>
  );
}

interface ComparisonBundleSlotProps {
  side: "reference" | "candidate";
  file?: File;
  disabled: boolean;
  onSelect: (file: File) => void;
}

function ComparisonBundleSlot({ side, file, disabled, onSelect }: ComparisonBundleSlotProps) {
  const { input, selectInput, drop } = useBundlePicker(onSelect);
  const [dragging, setDragging] = useState(false);
  const title = side === "reference" ? "Reference" : "Candidate";
  return (
    <div className={`comparison-bundle-slot ${side}${dragging ? " dragging" : ""}`}>
      <span className="comparison-bundle-side">{title}</span>
      <button
        type="button"
        data-dialog-initial-focus={side === "reference" ? "true" : undefined}
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          drop(event);
        }}
        aria-label={`Choose ${side} .nettle bundle`}
      >
        <FileArchive size={21} strokeWidth={1.4} />
        {file ? (
          <span className="comparison-bundle-name" title={file.name}>
            <strong>{file.name}</strong>
            <small>{file.size.toLocaleString()} bytes</small>
          </span>
        ) : (
          <span className="comparison-bundle-name">
            <strong>Choose bundle</strong>
            <small>or drop it here</small>
          </span>
        )}
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept=".nettle,application/zip"
        aria-label={`Choose ${side} .nettle bundle file`}
        disabled={disabled}
        tabIndex={-1}
        onChange={selectInput}
      />
    </div>
  );
}

export interface CompareBundlesDialogProps {
  open: boolean;
  loading: boolean;
  error?: string;
  initialReference?: File;
  initialCandidate?: File;
  initialMatching?: MatchingPolicy;
  hostedFiles?: readonly File[];
  onCompare: (reference: File, candidate: File, matching: MatchingPolicy) => void;
  onClose: () => void;
}

export function CompareBundlesDialog({
  open,
  loading,
  error,
  initialReference,
  initialCandidate,
  initialMatching = "conservative",
  hostedFiles,
  onCompare,
  onClose,
}: CompareBundlesDialogProps) {
  const titleId = useId();
  const [reference, setReference] = useState<File | undefined>(initialReference);
  const [candidate, setCandidate] = useState<File | undefined>(initialCandidate);
  const [matching, setMatching] = useState<MatchingPolicy>(initialMatching);
  const dialogRef = useRef<HTMLElement>(null);
  const previouslyFocused = useRef<HTMLElement | undefined>(undefined);
  const wasOpen = useRef(open);
  const onCloseRef = useRef(onClose);
  const loadingRef = useRef(loading);
  onCloseRef.current = onClose;
  loadingRef.current = loading;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

    const focusableElements = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, [href], [tabindex]",
        ),
      ].filter(
        (element) =>
          !element.hidden &&
          !element.matches(":disabled") &&
          element.tabIndex >= 0 &&
          element.getAttribute("aria-hidden") !== "true",
      );
    const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
    const initialTarget =
      initial && !initial.matches(":disabled") ? initial : focusableElements()[0];
    (initialTarget ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (loadingRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (wasOpen.current && !open) {
      const previous = previouslyFocused.current;
      const restoreTarget = previous?.isConnected
        ? previous
        : (document.querySelector<HTMLElement>(".project-title") ??
          document.querySelector<HTMLElement>("button:not(:disabled), [href], [tabindex]"));
      restoreTarget?.focus();
      previouslyFocused.current = undefined;
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setReference(initialReference);
    setCandidate(initialCandidate);
    setMatching(initialMatching);
  }, [initialCandidate, initialMatching, initialReference, open]);

  if (!open) return null;
  const referenceHosted = reference !== undefined && hostedFiles?.includes(reference);
  const candidateHosted = candidate !== undefined && hostedFiles?.includes(candidate);
  const privacyText =
    referenceHosted && candidateHosted
      ? "Both bundles already have shareable URLs. Comparison runs in this browser and creates no new URL."
      : referenceHosted || candidateHosted
        ? `${referenceHosted ? "Reference" : "Candidate"} already has a shareable URL. Any local bundle stays in this browser; comparison creates no new URL.`
        : "Bundles stay in this browser.";
  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="compare-bundles-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            <GitCompareArrows size={17} strokeWidth={1.7} />
          </span>
          <div>
            <h2 id={titleId}>Compare Nettle bundles</h2>
            <p>Build one schematic overlay from two local snapshots.</p>
          </div>
          <button
            className="icon-button compact dialog-close"
            type="button"
            aria-label="Close compare bundles dialog"
            onClick={onClose}
            disabled={loading}
          >
            <X size={15} />
          </button>
        </header>
        <div className="compare-bundles-body">
          <div className="comparison-bundle-slots">
            <ComparisonBundleSlot
              side="reference"
              file={reference}
              disabled={loading}
              onSelect={setReference}
            />
            <button
              className="comparison-slot-swap"
              type="button"
              disabled={loading || (!reference && !candidate)}
              aria-label="Swap reference and candidate bundles"
              title="Swap reference and candidate bundles"
              onClick={() => {
                setReference(candidate);
                setCandidate(reference);
              }}
            >
              <ArrowLeftRight size={18} aria-hidden="true" />
            </button>
            <ComparisonBundleSlot
              side="candidate"
              file={candidate}
              disabled={loading}
              onSelect={setCandidate}
            />
          </div>
          <label className="comparison-matching-field">
            <span>Matching policy</span>
            <select
              value={matching}
              disabled={loading}
              onChange={(event) => setMatching(event.target.value as MatchingPolicy)}
            >
              <option value="conservative">Conservative (recommended)</option>
              <option value="aggressive">Aggressive (heuristic)</option>
            </select>
            <small>
              {matching === "conservative"
                ? "Leaves ambiguous objects as separate removals and additions."
                : "Pairs additional structurally similar objects and marks them with ≈."}
            </small>
          </label>
          {error ? (
            <div className="bundle-open-error" role="alert">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
        <footer className="compare-bundles-actions">
          <span>{privacyText}</span>
          <button type="button" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="primary"
            type="button"
            disabled={loading || !reference || !candidate}
            onClick={() => {
              if (reference && candidate) onCompare(reference, candidate, matching);
            }}
          >
            <GitCompareArrows size={14} />
            {loading ? "Comparing…" : "Compare bundles"}
          </button>
        </footer>
      </section>
    </div>
  );
}
