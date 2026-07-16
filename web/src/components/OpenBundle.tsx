// SPDX-License-Identifier: Apache-2.0

import {
  AlertCircle,
  ArrowLeftRight,
  FileArchive,
  FolderOpen,
  GitCompareArrows,
  ShieldCheck,
  X,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useEffect, useId, useRef, useState } from "react";
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
  onCompare?: () => void;
  onBuildAzure?: (azurePath: string, top: string) => void;
}

export function BundleWelcome({ onCompare, onBuildAzure, ...pickerProps }: BundleWelcomeProps) {
  const [azurePath, setAzurePath] = useState("");
  const [top, setTop] = useState("");
  return (
    <main className="bundle-welcome">
      <div className="bundle-welcome-card">
        <span className="bundle-welcome-icon">
          <FolderOpen size={24} strokeWidth={1.5} />
        </span>
        <h1>Open an elaborated design</h1>
        <p>
          Nettle reads the bundle directly in this browser. Sources and schematic metadata are never
          uploaded.
        </p>
        {onBuildAzure ? (
          <form
            className="azure-build-form"
            onSubmit={(event) => {
              event.preventDefault();
              const path = azurePath.trim();
              const module = top.trim();
              if (path && module) onBuildAzure(path, module);
            }}
          >
            <label className="dialog-field">
              <span>Azure path</span>
              <input
                type="text"
                value={azurePath}
                placeholder="az://account/container/path/to/rtl/"
                disabled={pickerProps.loading}
                onChange={(event) => setAzurePath(event.target.value)}
              />
            </label>
            <label className="dialog-field">
              <span>Top module</span>
              <input
                type="text"
                value={top}
                placeholder="Required"
                disabled={pickerProps.loading}
                onChange={(event) => setTop(event.target.value)}
              />
            </label>
            <button
              className="dialog-button primary"
              type="submit"
              disabled={pickerProps.loading || !azurePath.trim() || !top.trim()}
            >
              {pickerProps.loading ? "Building…" : "Build"}
            </button>
          </form>
        ) : null}
        <div className="bundle-open-divider">
          <span>or open an existing bundle</span>
        </div>
        <BundleDropTarget {...pickerProps} />
        {onCompare ? (
          <button className="compare-welcome-action" type="button" onClick={onCompare}>
            <GitCompareArrows size={15} /> Compare two bundles
          </button>
        ) : null}
        <div className="bundle-privacy-note">
          <ShieldCheck size={15} />
          <span>Validated and rendered in memory on this device</span>
        </div>
        <code>nettle build --filelist design.f --top top --output design.nettle</code>
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
          <span>Bundles stay in this browser.</span>
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
