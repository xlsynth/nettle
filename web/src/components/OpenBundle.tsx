// SPDX-License-Identifier: Apache-2.0

import { AlertCircle, FileArchive, FolderOpen, ShieldCheck, X } from "lucide-react";
import { type ChangeEvent, type DragEvent, useId, useRef, useState } from "react";

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

export function BundleWelcome(props: BundlePickerProps) {
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
        <BundleDropTarget {...props} />
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
