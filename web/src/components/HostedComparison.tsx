// SPDX-License-Identifier: Apache-2.0

import {
  AlertCircle,
  ArrowLeftRight,
  Download,
  FileArchive,
  GitCompareArrows,
  Link2,
  LoaderCircle,
  X,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  classifyHostedUploadKind,
  createHostedSession,
  getHostedConfig,
  getHostedSessionStatus,
  HostedApiError,
  type HostedComparisonRoute,
  type HostedConfig,
  type HostedSessionCreated,
  type HostedSessionStatus,
  hostedDownloadUrl,
  loadHostedBundle,
  type TransferProgress,
} from "../api/hosted";
import type { MatchingPolicy } from "../comparison/types";
import type { HostedViewerSession } from "./HostedSessions";

const COMPARISON_INPUT_ACCEPT =
  ".nettle,.zip,.tar,.tar.gz,.tgz,application/zip,application/x-tar,application/gzip";

const messageFor = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  ) {
    return reason.message;
  }
  return String(reason);
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
};

const formatTime = (timestamp?: number) => {
  if (timestamp === undefined) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
};

const retentionText = (config: HostedConfig) =>
  config.retention.mode === "forever"
    ? "The generated bundles are retained until an admin removes them."
    : `${config.retention.display.replace(/\.$/, "")}.`;

interface ProgressBarProps {
  label: string;
  progress?: TransferProgress;
  complete?: boolean;
}

function ProgressBar({ label, progress, complete = false }: ProgressBarProps) {
  const percent = complete ? 100 : progress?.percent;
  return (
    <div className="hosted-progress">
      <div className="hosted-progress-label">
        <span>{label}</span>
        <span>
          {complete
            ? "Complete"
            : percent === undefined
              ? progress
                ? formatBytes(progress.loaded)
                : "Working…"
              : `${Math.round(percent)}%`}
        </span>
      </div>
      <div
        className={`hosted-progress-track${percent === undefined ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={percent === undefined ? undefined : 0}
        aria-valuemax={percent === undefined ? undefined : 100}
        aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
      >
        <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
    </div>
  );
}

type ComparisonSide = "reference" | "candidate";

interface ComparisonInputProps {
  side: ComparisonSide;
  file?: File;
  disabled: boolean;
  error?: string;
  onSelect: (file?: File) => void;
}

function ComparisonInput({ side, file, disabled, error, onSelect }: ComparisonInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const title = side === "reference" ? "Reference" : "Candidate";
  return (
    <div className="hosted-comparison-input">
      <span className="comparison-bundle-side">{title}</span>
      <button
        className="hosted-file-picker"
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <FileArchive size={22} />
        <span>
          <strong>{file?.name ?? "Choose a .nettle bundle or source archive"}</strong>
          <small>{file ? formatBytes(file.size) : ".nettle, .zip, .tar, .tar.gz, or .tgz"}</small>
        </span>
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept={COMPARISON_INPUT_ACCEPT}
        aria-label={`Choose ${side} .nettle bundle or source archive`}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          onSelect(selected);
        }}
      />
      {error ? (
        <div className="bundle-open-error compact" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

interface HostedComparisonUploadDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (route: HostedComparisonRoute) => void;
}

export function HostedComparisonUploadDialog({
  open,
  onClose,
  onCreated,
}: HostedComparisonUploadDialogProps) {
  const titleId = useId();
  const upload = useRef<AbortController | undefined>(undefined);
  const [config, setConfig] = useState<HostedConfig>();
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [reference, setReference] = useState<File>();
  const [candidate, setCandidate] = useState<File>();
  const [referenceFilelist, setReferenceFilelist] = useState("");
  const [candidateFilelist, setCandidateFilelist] = useState("");
  const [matching, setMatching] = useState<MatchingPolicy>("conservative");
  const [referenceCreated, setReferenceCreated] = useState<HostedSessionCreated>();
  const [candidateCreated, setCandidateCreated] = useState<HostedSessionCreated>();
  const [referenceProgress, setReferenceProgress] = useState<TransferProgress>();
  const [candidateProgress, setCandidateProgress] = useState<TransferProgress>();
  const [referenceError, setReferenceError] = useState<string>();
  const [candidateError, setCandidateError] = useState<string>();
  const [configError, setConfigError] = useState<string>();
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    upload.current?.abort();
    upload.current = undefined;
    setConfig(undefined);
    setLoadingConfig(false);
    setReference(undefined);
    setCandidate(undefined);
    setReferenceFilelist("");
    setCandidateFilelist("");
    setMatching("conservative");
    setReferenceCreated(undefined);
    setCandidateCreated(undefined);
    setReferenceProgress(undefined);
    setCandidateProgress(undefined);
    setReferenceError(undefined);
    setCandidateError(undefined);
    setConfigError(undefined);
    setUploading(false);
    if (!open) return;
    const controller = new AbortController();
    setLoadingConfig(true);
    void getHostedConfig(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!value.hostingEnabled) {
          setConfigError("Hosted uploads are disabled on this Nettle server.");
          return;
        }
        setConfig(value);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setConfigError(messageFor(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingConfig(false);
      });
    return () => controller.abort();
  }, [open]);

  useEffect(
    () => () => {
      upload.current?.abort();
    },
    [],
  );

  if (!open) return null;
  const inputError = (side: ComparisonSide, file?: File) => {
    if (!file || !config) return undefined;
    if (!classifyHostedUploadKind(file.name, config.sourceFormats)) {
      return `${side === "reference" ? "Reference" : "Candidate"} must be a .nettle bundle or a supported source archive.`;
    }
    if (file.size > config.limits.maxUploadBytes) {
      return `${side === "reference" ? "Reference" : "Candidate"} is larger than the server limit of ${formatBytes(config.limits.maxUploadBytes)}.`;
    }
    return undefined;
  };
  const referenceValidation = inputError("reference", reference);
  const candidateValidation = inputError("candidate", candidate);
  const referenceKind =
    reference && config
      ? classifyHostedUploadKind(reference.name, config.sourceFormats)
      : undefined;
  const candidateKind =
    candidate && config
      ? classifyHostedUploadKind(candidate.name, config.sourceFormats)
      : undefined;

  const selectReference = (file?: File) => {
    setReference(file);
    setReferenceFilelist("");
    setReferenceCreated(undefined);
    setReferenceProgress(undefined);
    setReferenceError(undefined);
  };
  const selectCandidate = (file?: File) => {
    setCandidate(file);
    setCandidateFilelist("");
    setCandidateCreated(undefined);
    setCandidateProgress(undefined);
    setCandidateError(undefined);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      !config ||
      !reference ||
      !candidate ||
      referenceValidation ||
      candidateValidation ||
      uploading
    ) {
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    setUploading(true);
    setReferenceError(undefined);
    setCandidateError(undefined);

    const createSide = (
      side: ComparisonSide,
      file: File,
      created: HostedSessionCreated | undefined,
      sourceFilelist: string,
    ) => {
      if (created) return Promise.resolve(created);
      const kind = classifyHostedUploadKind(file.name, config.sourceFormats);
      if (!kind) return Promise.reject(new Error(`Unsupported ${side} file type.`));
      const setProgress = side === "reference" ? setReferenceProgress : setCandidateProgress;
      setProgress({ loaded: 0, total: file.size, percent: 0 });
      return createHostedSession(
        kind,
        file,
        kind === "sources" ? sourceFilelist.trim() || undefined : undefined,
        setProgress,
        controller.signal,
      );
    };

    void Promise.allSettled([
      createSide("reference", reference, referenceCreated, referenceFilelist),
      createSide("candidate", candidate, candidateCreated, candidateFilelist),
    ])
      .then(([referenceResult, candidateResult]) => {
        if (controller.signal.aborted) return;
        const nextReference =
          referenceResult.status === "fulfilled" ? referenceResult.value : referenceCreated;
        const nextCandidate =
          candidateResult.status === "fulfilled" ? candidateResult.value : candidateCreated;
        setReferenceCreated(nextReference);
        setCandidateCreated(nextCandidate);
        if (referenceResult.status === "rejected") {
          setReferenceError(messageFor(referenceResult.reason));
        }
        if (candidateResult.status === "rejected") {
          setCandidateError(messageFor(candidateResult.reason));
        }
        if (nextReference && nextCandidate) {
          onCreated({
            referenceToken: nextReference.token,
            candidateToken: nextCandidate.token,
            matching,
          });
        }
      })
      .finally(() => {
        if (upload.current === controller) upload.current = undefined;
        if (!controller.signal.aborted) setUploading(false);
      });
  };
  const close = () => {
    upload.current?.abort();
    onClose();
  };

  return (
    <div className="dialog-backdrop">
      <section
        className="hosted-upload-dialog hosted-comparison-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            <GitCompareArrows size={17} />
          </span>
          <div>
            <h2 id={titleId}>Upload and compare two designs</h2>
            <p>Each input may be a prebuilt bundle or an RTL source archive.</p>
          </div>
          <button
            className="icon-button compact dialog-close"
            type="button"
            aria-label="Close hosted comparison upload dialog"
            onClick={close}
          >
            <X size={15} />
          </button>
        </header>
        <form className="hosted-upload-form" onSubmit={submit}>
          {loadingConfig ? (
            <div className="hosted-config-loading">
              <LoaderCircle className="spin" size={17} />
              Checking this server’s upload and retention policy…
            </div>
          ) : null}
          {config ? (
            <>
              <div className="hosted-disclosure">
                <strong>Before you upload these designs</strong>
                <ul>
                  <li>
                    Both inputs leave this browser. Source archives are built with Slang and Yosys;
                    prebuilt <code>.nettle</code> bundles are validated as-is.
                  </li>
                  <li>
                    Raw source archives are deleted after their builds finish. The two generated
                    bundles are stored as independent sessions.
                  </li>
                  <li>Anyone with the comparison URL can view and download both bundles.</li>
                  <li>{retentionText(config)}</li>
                </ul>
              </div>
              <div className="hosted-comparison-inputs">
                <ComparisonInput
                  side="reference"
                  file={reference}
                  disabled={uploading || Boolean(referenceCreated)}
                  error={referenceValidation ?? referenceError}
                  onSelect={selectReference}
                />
                <button
                  className="comparison-slot-swap"
                  type="button"
                  disabled={
                    uploading ||
                    Boolean(referenceCreated || candidateCreated) ||
                    (!reference && !candidate)
                  }
                  aria-label="Swap reference and candidate uploads"
                  onClick={() => {
                    setReference(candidate);
                    setCandidate(reference);
                    setReferenceFilelist(candidateFilelist);
                    setCandidateFilelist(referenceFilelist);
                    setReferenceError(candidateError);
                    setCandidateError(referenceError);
                    setReferenceProgress(candidateProgress);
                    setCandidateProgress(referenceProgress);
                  }}
                >
                  <ArrowLeftRight size={18} />
                </button>
                <ComparisonInput
                  side="candidate"
                  file={candidate}
                  disabled={uploading || Boolean(candidateCreated)}
                  error={candidateValidation ?? candidateError}
                  onSelect={selectCandidate}
                />
              </div>
              {referenceKind === "sources" || candidateKind === "sources" ? (
                <div className="hosted-comparison-filelists">
                  {referenceKind === "sources" ? (
                    <label className="dialog-field">
                      Reference root filelist path <em>optional</em>
                      <input
                        type="text"
                        value={referenceFilelist}
                        placeholder="project.f"
                        disabled={uploading || Boolean(referenceCreated)}
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-label="Reference root filelist path"
                        onChange={(event) => {
                          setReferenceFilelist(event.target.value);
                          setReferenceError(undefined);
                        }}
                      />
                    </label>
                  ) : (
                    <span />
                  )}
                  {candidateKind === "sources" ? (
                    <label className="dialog-field">
                      Candidate root filelist path <em>optional</em>
                      <input
                        type="text"
                        value={candidateFilelist}
                        placeholder="project.f"
                        disabled={uploading || Boolean(candidateCreated)}
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-label="Candidate root filelist path"
                        onChange={(event) => {
                          setCandidateFilelist(event.target.value);
                          setCandidateError(undefined);
                        }}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              <label className="comparison-matching-field">
                <span>Matching policy</span>
                <select
                  value={matching}
                  disabled={uploading}
                  onChange={(event) => setMatching(event.target.value as MatchingPolicy)}
                >
                  <option value="conservative">Conservative (recommended)</option>
                  <option value="aggressive">Aggressive (heuristic)</option>
                </select>
              </label>
              {referenceProgress ? (
                <ProgressBar
                  label={
                    referenceCreated
                      ? "Reference session created"
                      : `Uploading reference ${reference?.name ?? ""}`
                  }
                  progress={referenceProgress}
                  complete={Boolean(referenceCreated)}
                />
              ) : null}
              {candidateProgress ? (
                <ProgressBar
                  label={
                    candidateCreated
                      ? "Candidate session created"
                      : `Uploading candidate ${candidate?.name ?? ""}`
                  }
                  progress={candidateProgress}
                  complete={Boolean(candidateCreated)}
                />
              ) : null}
              <div className="hosted-upload-actions">
                <button type="button" disabled={uploading} onClick={close}>
                  Cancel
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    !reference ||
                    !candidate ||
                    Boolean(referenceValidation || candidateValidation) ||
                    uploading
                  }
                >
                  {uploading
                    ? "Uploading designs…"
                    : referenceCreated || candidateCreated
                      ? "Retry incomplete upload"
                      : "Upload and create comparison link"}
                </button>
              </div>
            </>
          ) : null}
          {configError ? (
            <div className="bundle-open-error" role="alert">
              <AlertCircle size={15} />
              <span>{configError}</span>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}

interface HostedComparisonPageProps {
  route: HostedComparisonRoute;
  onOpenComparison: (
    reference: File,
    candidate: File,
    matching: MatchingPolicy,
    sessions: {
      reference: HostedViewerSession;
      candidate: HostedViewerSession;
      shareable: true;
    },
    setPhase: (phase: string) => void,
  ) => Promise<void>;
}

const statusLabel = (status?: HostedSessionStatus, missing = false, error?: string) => {
  if (missing) return "Session not found or expired";
  if (error) return `Status check failed: ${error} · retrying`;
  switch (status?.state) {
    case "queued":
      return `Waiting in build queue${status.queuePosition ? ` · position ${status.queuePosition}` : ""}`;
    case "building":
      return "Building .nettle bundle";
    case "ready":
      return "Bundle ready";
    case "failed":
      return status.error ?? "Build failed";
    default:
      return "Loading session status…";
  }
};

export function HostedComparisonPage({ route, onOpenComparison }: HostedComparisonPageProps) {
  const [referenceStatus, setReferenceStatus] = useState<HostedSessionStatus>();
  const [candidateStatus, setCandidateStatus] = useState<HostedSessionStatus>();
  const [referenceMissing, setReferenceMissing] = useState(false);
  const [candidateMissing, setCandidateMissing] = useState(false);
  const [referenceStatusError, setReferenceStatusError] = useState<string>();
  const [candidateStatusError, setCandidateStatusError] = useState<string>();
  const [phase, setPhase] = useState("Loading comparison sessions…");
  const [referenceProgress, setReferenceProgress] = useState<TransferProgress>();
  const [candidateProgress, setCandidateProgress] = useState<TransferProgress>();
  const [viewerError, setViewerError] = useState<string>();
  const [viewerOpenEnabled, setViewerOpenEnabled] = useState(true);
  const opening = useRef(false);

  useEffect(() => {
    opening.current = false;
    setViewerOpenEnabled(true);
    setReferenceStatus(undefined);
    setCandidateStatus(undefined);
    setReferenceMissing(false);
    setCandidateMissing(false);
    setReferenceStatusError(undefined);
    setCandidateStatusError(undefined);
    setViewerError(undefined);
    setReferenceProgress(undefined);
    setCandidateProgress(undefined);
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      const results = await Promise.allSettled([
        getHostedSessionStatus(route.referenceToken, controller.signal),
        getHostedSessionStatus(route.candidateToken, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      let shouldRetry = false;
      const apply = (side: ComparisonSide, result: PromiseSettledResult<HostedSessionStatus>) => {
        const setStatus = side === "reference" ? setReferenceStatus : setCandidateStatus;
        const setMissing = side === "reference" ? setReferenceMissing : setCandidateMissing;
        const setStatusError =
          side === "reference" ? setReferenceStatusError : setCandidateStatusError;
        if (result.status === "fulfilled") {
          setMissing(false);
          setStatusError(undefined);
          setStatus(result.value);
          shouldRetry ||= result.value.state === "queued" || result.value.state === "building";
          return;
        }
        if (result.reason instanceof HostedApiError && result.reason.status === 404) {
          setMissing(true);
          setStatusError(undefined);
          setStatus(undefined);
          return;
        }
        setMissing(false);
        setStatus(undefined);
        setStatusError(messageFor(result.reason));
        shouldRetry = true;
      };
      apply("reference", results[0]);
      apply("candidate", results[1]);
      if (shouldRetry) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [route.candidateToken, route.referenceToken]);

  useEffect(() => {
    if (
      referenceStatus?.state !== "ready" ||
      candidateStatus?.state !== "ready" ||
      !viewerOpenEnabled ||
      opening.current
    ) {
      return;
    }
    opening.current = true;
    const controller = new AbortController();
    let cancelled = false;
    setPhase("Downloading both bundles…");
    const loadSide = async (
      side: ComparisonSide,
      token: string,
      setProgress: (progress: TransferProgress) => void,
    ) => {
      try {
        return await loadHostedBundle(token, setProgress, controller.signal);
      } catch (reason) {
        const primary = !controller.signal.aborted;
        if (primary) controller.abort();
        throw { side, reason, primary };
      }
    };
    const launch = async () => {
      const [referenceResult, candidateResult] = await Promise.allSettled([
        loadSide("reference", route.referenceToken, setReferenceProgress),
        loadSide("candidate", route.candidateToken, setCandidateProgress),
      ]);
      if (cancelled) return;
      const failures = [referenceResult, candidateResult].filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        opening.current = false;
        for (const failure of failures) {
          const tagged = failure.reason as {
            side?: ComparisonSide;
            reason?: unknown;
            primary?: boolean;
          };
          if (!tagged.side || !tagged.primary) continue;
          const label = tagged.side === "reference" ? "Reference" : "Candidate";
          if (tagged.reason instanceof HostedApiError && tagged.reason.status === 404) {
            if (tagged.side === "reference") {
              setReferenceMissing(true);
              setReferenceStatus(undefined);
              setReferenceStatusError(undefined);
            } else {
              setCandidateMissing(true);
              setCandidateStatus(undefined);
              setCandidateStatusError(undefined);
            }
          } else {
            setViewerOpenEnabled(false);
            setViewerError(`${label} bundle download failed: ${messageFor(tagged.reason)}`);
          }
        }
        return;
      }
      if (referenceResult.status !== "fulfilled" || candidateResult.status !== "fulfilled") return;
      try {
        setPhase("Validating both bundles in this browser…");
        await onOpenComparison(
          new File([referenceResult.value], "reference.nettle", {
            type: referenceResult.value.type,
          }),
          new File([candidateResult.value], "candidate.nettle", {
            type: candidateResult.value.type,
          }),
          route.matching,
          {
            reference: { token: route.referenceToken, status: referenceStatus },
            candidate: { token: route.candidateToken, status: candidateStatus },
            shareable: true,
          },
          setPhase,
        );
      } catch (reason) {
        if (cancelled) return;
        opening.current = false;
        setViewerOpenEnabled(false);
        setViewerError(messageFor(reason));
        setPhase("The viewer could not open this comparison.");
      }
    };
    void launch();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    candidateStatus,
    onOpenComparison,
    referenceStatus,
    route.candidateToken,
    route.matching,
    route.referenceToken,
    viewerOpenEnabled,
  ]);

  const terminalProblems = [
    referenceMissing
      ? "Reference session was not found or has expired."
      : referenceStatus?.state === "failed"
        ? `Reference build failed${referenceStatus.error ? `: ${referenceStatus.error}` : "."}`
        : undefined,
    candidateMissing
      ? "Candidate session was not found or has expired."
      : candidateStatus?.state === "failed"
        ? `Candidate build failed${candidateStatus.error ? `: ${candidateStatus.error}` : "."}`
        : undefined,
  ].filter((problem): problem is string => Boolean(problem));
  const terminalError = terminalProblems.length > 0 ? terminalProblems.join(" ") : undefined;

  return (
    <>
      <header className="hosted-page-header">
        <span className="brand">NETTLE</span>
        <span className="mode-badge hosted">SHAREABLE COMPARISON</span>
      </header>
      <main className="hosted-session-page">
        <section className="hosted-session-card hosted-comparison-session-card" aria-live="polite">
          <span className={`hosted-session-icon${terminalError ? " error" : ""}`}>
            {terminalError ? <AlertCircle size={26} /> : <GitCompareArrows size={26} />}
          </span>
          <h1>{terminalError ? "Comparison unavailable" : "Opening shareable comparison"}</h1>
          <p className="hosted-session-phase">{terminalError ?? phase}</p>
          <div className="hosted-comparison-statuses">
            <div>
              <strong>Reference</strong>
              <span>{statusLabel(referenceStatus, referenceMissing, referenceStatusError)}</span>
            </div>
            <div>
              <strong>Candidate</strong>
              <span>{statusLabel(candidateStatus, candidateMissing, candidateStatusError)}</span>
            </div>
          </div>
          {referenceProgress ? (
            <ProgressBar label="Downloading reference bundle" progress={referenceProgress} />
          ) : null}
          {candidateProgress ? (
            <ProgressBar label="Downloading candidate bundle" progress={candidateProgress} />
          ) : null}
          {viewerError ? (
            <div className="bundle-open-error" role="alert">
              <AlertCircle size={15} />
              <span>{viewerError}</span>
            </div>
          ) : null}
          {viewerError && !opening.current ? (
            <button
              className="hosted-download-button"
              type="button"
              onClick={() => {
                setViewerError(undefined);
                setReferenceProgress(undefined);
                setCandidateProgress(undefined);
                setViewerOpenEnabled(true);
              }}
            >
              Retry viewer launch
            </button>
          ) : null}
          <div className="hosted-privacy-banner">
            <Link2 size={16} />
            <div>
              <strong>Anyone with this link can view and download both bundles.</strong>
              <span>
                The comparison remains available only while both underlying sessions are retained.
              </span>
            </div>
          </div>
          <div className="hosted-comparison-downloads">
            {referenceStatus?.state === "ready" ? (
              <a
                className="hosted-download-button"
                href={hostedDownloadUrl(route.referenceToken)}
                download
                referrerPolicy="no-referrer"
              >
                <Download size={15} />
                Download reference
              </a>
            ) : null}
            {candidateStatus?.state === "ready" ? (
              <a
                className="hosted-download-button"
                href={hostedDownloadUrl(route.candidateToken)}
                download
                referrerPolicy="no-referrer"
              >
                <Download size={15} />
                Download candidate
              </a>
            ) : null}
          </div>
          {(referenceStatus?.expiresAtMs || candidateStatus?.expiresAtMs) && !terminalError ? (
            <span className="hosted-comparison-expiration">
              Comparison expires{" "}
              {formatTime(
                Math.min(
                  referenceStatus?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
                  candidateStatus?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
                ),
              )}
              .
            </span>
          ) : null}
        </section>
      </main>
    </>
  );
}
