// SPDX-License-Identifier: Apache-2.0

import {
  AlertCircle,
  Archive,
  Clock3,
  Download,
  FileArchive,
  Hammer,
  Link2,
  LoaderCircle,
  Server,
  UploadCloud,
  X,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  createHostedSession,
  getHostedConfig,
  getHostedSessionStatus,
  HostedApiError,
  type HostedConfig,
  type HostedSessionCreated,
  type HostedSessionStatus,
  type HostedUploadKind,
  hostedDownloadUrl,
  loadHostedBundle,
  type TransferProgress,
} from "../api/hosted";

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

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};

const elapsed = (start: number | undefined, end: number | undefined, now: number) => {
  if (start === undefined) return undefined;
  return formatDuration((end ?? now) - start);
};

const messageFor = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

const retentionText = (config: HostedConfig) =>
  config.retention.mode === "forever"
    ? "Artifacts are retained until an admin removes them."
    : `${config.retention.display.replace(/\.$/, "")}.`;

interface ProgressBarProps {
  label: string;
  progress?: TransferProgress;
}

function ProgressBar({ label, progress }: ProgressBarProps) {
  const percent = progress?.percent;
  return (
    <div className="hosted-progress">
      <div className="hosted-progress-label">
        <span>{label}</span>
        <span>
          {percent === undefined
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

interface HostedUploadDialogProps {
  kind?: HostedUploadKind;
  onClose: () => void;
  onCreated: (session: HostedSessionCreated) => void;
}

export function HostedUploadDialog({ kind, onClose, onCreated }: HostedUploadDialogProps) {
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | undefined>(undefined);
  const [config, setConfig] = useState<HostedConfig>();
  const [file, setFile] = useState<File>();
  const [sourceFilelist, setSourceFilelist] = useState("");
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadTransferred, setUploadTransferred] = useState(false);
  const [progress, setProgress] = useState<TransferProgress>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setConfig(undefined);
    setFile(undefined);
    setSourceFilelist("");
    setProgress(undefined);
    setUploadTransferred(false);
    setError(undefined);
    upload.current?.abort();
    upload.current = undefined;
    setUploading(false);
    if (!kind) return;
    const controller = new AbortController();
    setLoadingConfig(true);
    void getHostedConfig(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!value.hostingEnabled) {
          setError("Hosted uploads are disabled on this Nettle server.");
          return;
        }
        setConfig(value);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        const message =
          reason instanceof Error && "status" in reason && reason.status === 404
            ? "Hosted uploads are unavailable on this Nettle server. You can still open a bundle locally."
            : messageFor(reason);
        setError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingConfig(false);
      });
    return () => controller.abort();
  }, [kind]);

  useEffect(
    () => () => {
      upload.current?.abort();
    },
    [],
  );

  if (!kind) return null;
  const bundle = kind === "bundle";
  const tooLarge = file && config ? file.size > config.limits.maxUploadBytes : false;
  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0]);
    setError(undefined);
    setProgress(undefined);
    setUploadTransferred(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !config || tooLarge || uploading) return;
    const controller = new AbortController();
    upload.current = controller;
    setUploading(true);
    setUploadTransferred(false);
    setError(undefined);
    setProgress({ loaded: 0, total: file.size, percent: 0 });
    void createHostedSession(
      kind,
      file,
      bundle ? undefined : sourceFilelist || undefined,
      (next) => {
        setProgress(next);
        if (next.percent === 100) setUploadTransferred(true);
      },
      controller.signal,
    )
      .then(onCreated)
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(messageFor(reason));
      })
      .finally(() => {
        if (upload.current === controller) upload.current = undefined;
        if (!controller.signal.aborted) setUploading(false);
      });
  };

  return (
    <div className="dialog-backdrop">
      <section
        className="hosted-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            {bundle ? <UploadCloud size={17} /> : <Hammer size={17} />}
          </span>
          <div>
            <h2 id={titleId}>
              {bundle ? "Upload bundle and create link" : "Upload sources, build, and create link"}
            </h2>
            <p>Review what leaves this browser before starting.</p>
          </div>
          <button
            className="icon-button compact dialog-close"
            type="button"
            aria-label="Close hosted upload dialog"
            onClick={() => {
              upload.current?.abort();
              onClose();
            }}
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
                <strong>
                  {bundle ? "Before you upload this bundle" : "Before you upload sources"}
                </strong>
                <ul>
                  {bundle ? (
                    <li>
                      The complete <code>.nettle</code> bundle, including embedded source and debug
                      artifacts, is uploaded over HTTPS and stored on this server.
                    </li>
                  ) : (
                    <>
                      <li>
                        The complete source archive is uploaded over HTTPS and stored temporarily
                        while it waits and builds.
                      </li>
                      <li>
                        Slang and Yosys process the archive. The raw archive is deleted after
                        success or failure.
                      </li>
                      <li>
                        The generated <code>.nettle</code>, including referenced source text, is
                        stored on this server.
                      </li>
                    </>
                  )}
                  <li>Anyone with the resulting URL can view and download the bundle.</li>
                  <li>{retentionText(config)}</li>
                </ul>
              </div>
              <button
                className="hosted-file-picker"
                type="button"
                disabled={uploading}
                onClick={() => input.current?.click()}
              >
                <FileArchive size={22} />
                {file ? (
                  <span>
                    <strong>{file.name}</strong>
                    <small>{formatBytes(file.size)}</small>
                  </span>
                ) : (
                  <span>
                    <strong>
                      {bundle ? "Choose a .nettle bundle" : "Choose a source archive"}
                    </strong>
                    <small>
                      {bundle
                        ? "Selecting does not start the upload"
                        : `${config.sourceFormats.join(", ")} · selecting does not start the upload`}
                    </small>
                  </span>
                )}
              </button>
              <input
                ref={input}
                className="visually-hidden"
                type="file"
                accept={
                  bundle
                    ? ".nettle,application/zip"
                    : ".zip,.tar,.tar.gz,.tgz,application/zip,application/x-tar,application/gzip"
                }
                aria-label={bundle ? "Choose bundle to upload" : "Choose source archive to upload"}
                disabled={uploading}
                onChange={selectFile}
              />
              {!bundle ? (
                <label className="dialog-field">
                  Root filelist path <em>optional</em>
                  <input
                    type="text"
                    value={sourceFilelist}
                    placeholder="project.f"
                    disabled={uploading}
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-label="Root filelist path"
                    onChange={(event) => {
                      setSourceFilelist(event.target.value);
                      setError(undefined);
                    }}
                  />
                  <small>
                    Relative to the archive root, for example <code>br_counter/filelist.f</code>.
                    Defaults to <code>project.f</code>.
                  </small>
                </label>
              ) : null}
              {tooLarge ? (
                <div className="bundle-open-error" role="alert">
                  <AlertCircle size={15} />
                  <span>
                    This file is larger than the server limit of{" "}
                    {formatBytes(config.limits.maxUploadBytes)}.
                  </span>
                </div>
              ) : null}
              {uploading ? (
                <ProgressBar
                  label={
                    uploadTransferred
                      ? bundle
                        ? "Upload complete; server is validating and saving the bundle"
                        : "Upload complete; server is admitting the build"
                      : `Uploading ${file?.name ?? "file"}`
                  }
                  progress={uploadTransferred ? undefined : progress}
                />
              ) : null}
              <div className="hosted-upload-actions">
                <button type="button" disabled={uploading} onClick={onClose}>
                  Cancel
                </button>
                <button className="primary" type="submit" disabled={!file || tooLarge || uploading}>
                  {uploading
                    ? uploadTransferred
                      ? bundle
                        ? "Validating and saving…"
                        : "Admitting build…"
                      : "Uploading…"
                    : bundle
                      ? "Upload and create link"
                      : "Upload, build, and create link"}
                </button>
              </div>
            </>
          ) : null}
          {error ? (
            <div className="bundle-open-error" role="alert">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}

interface HostedSessionPageProps {
  token: string;
  onOpenBundle: (
    file: File,
    session: HostedViewerSession,
    setPhase: (phase: string) => void,
  ) => Promise<void>;
}

export interface HostedViewerSession {
  token: string;
  status: HostedSessionStatus;
}

const stateLabel = (status: HostedSessionStatus) => {
  switch (status.state) {
    case "queued":
      return "Waiting in build queue";
    case "building":
      return "Building .nettle bundle";
    case "ready":
      return "Bundle ready";
    case "failed":
      return "Build failed";
  }
};

const statePhase = (status: HostedSessionStatus) => {
  switch (status.state) {
    case "queued":
      return "Your build will start automatically.";
    case "building":
      return "Slang and Yosys are compiling the uploaded sources.";
    case "ready":
      return "Preparing the bundle for the browser viewer…";
    case "failed":
      return "Compilation did not produce a bundle.";
  }
};

export function HostedSessionPage({ token, onOpenBundle }: HostedSessionPageProps) {
  const [status, setStatus] = useState<HostedSessionStatus>();
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState("Loading session status…");
  const [downloadProgress, setDownloadProgress] = useState<TransferProgress>();
  const [now, setNow] = useState(() => Date.now());
  const [statusReceivedAt, setStatusReceivedAt] = useState(() => Date.now());
  const [notFound, setNotFound] = useState(false);
  const [viewerOpenEnabled, setViewerOpenEnabled] = useState(true);
  const opening = useRef(false);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    opening.current = false;
    setViewerOpenEnabled(true);
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getHostedSessionStatus(token, controller.signal);
        if (controller.signal.aborted) return;
        setNotFound(false);
        setStatus(next);
        setStatusReceivedAt(Date.now());
        setError(undefined);
        setPhase(statePhase(next));
        if (next.state === "queued" || next.state === "building") {
          timer = window.setTimeout(poll, 1000);
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof HostedApiError && reason.status === 404) {
          setNotFound(true);
          setStatus(undefined);
          return;
        }
        setError(messageFor(reason));
        setPhase("Connection interrupted; retrying session status…");
        timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [token]);

  useEffect(() => {
    if (status?.state !== "ready" || !viewerOpenEnabled || opening.current) return;
    opening.current = true;
    const controller = new AbortController();
    setPhase("Downloading bundle…");
    void loadHostedBundle(token, setDownloadProgress, controller.signal)
      .then(async (file) => {
        if (controller.signal.aborted) return;
        setPhase("Validating bundle in this browser…");
        await onOpenBundle(file, { token, status }, setPhase);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        opening.current = false;
        if (reason instanceof HostedApiError && reason.status === 404) {
          setNotFound(true);
          setStatus(undefined);
          setError(undefined);
          return;
        }
        setViewerOpenEnabled(false);
        setError(messageFor(reason));
        setPhase("The viewer could not open this bundle.");
      });
    return () => controller.abort();
  }, [onOpenBundle, status, token, viewerOpenEnabled]);

  if (notFound) return <HostedSessionNotFound />;

  const serverNow = status ? status.serverTimeMs + (now - statusReceivedAt) : now;
  const queueWait = status
    ? elapsed(status.admittedAtMs, status.buildStartedAtMs ?? status.completedAtMs, serverNow)
    : undefined;
  const buildTime =
    status?.buildStartedAtMs === undefined
      ? undefined
      : elapsed(status.buildStartedAtMs, status.completedAtMs, serverNow);
  const totalTime = status
    ? elapsed(status.admittedAtMs, status.completedAtMs, serverNow)
    : undefined;
  const terminalError = status?.state === "failed" ? (status.error ?? "Compilation failed") : error;

  return (
    <>
      <header className="hosted-page-header">
        <span className="brand">NETTLE</span>
        <span className="mode-badge hosted">SHAREABLE SESSION</span>
      </header>
      <main className="hosted-session-page">
        <section className="hosted-session-card" aria-live="polite">
          <span className="hosted-session-icon">
            {terminalError ? (
              <AlertCircle size={26} />
            ) : status?.state === "ready" ? (
              <Archive size={26} />
            ) : (
              <LoaderCircle className="spin" size={26} />
            )}
          </span>
          <h1>{status ? stateLabel(status) : "Opening shareable session"}</h1>
          <p className="hosted-session-phase">{phase}</p>

          {status?.state === "queued" ? (
            <div className="queue-position">
              <strong>{status.queuePosition ?? "—"}</strong>
              <span>position in queue</span>
            </div>
          ) : null}

          {status ? (
            <dl className="hosted-timings">
              <div>
                <dt>Created</dt>
                <dd>{formatTime(status.admittedAtMs)}</dd>
              </div>
              <div>
                <dt>Queue wait</dt>
                <dd>{queueWait ?? "—"}</dd>
              </div>
              <div>
                <dt>Build time</dt>
                <dd>{buildTime ?? "—"}</dd>
              </div>
              <div>
                <dt>Total elapsed</dt>
                <dd>{totalTime ?? "—"}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{formatTime(status.completedAtMs) ?? "—"}</dd>
              </div>
            </dl>
          ) : null}

          {status?.state === "ready" && opening.current ? (
            <ProgressBar label="Loading viewer bundle" progress={downloadProgress} />
          ) : null}

          {terminalError ? (
            <div className="bundle-open-error" role="alert">
              <AlertCircle size={15} />
              <span>{terminalError}</span>
            </div>
          ) : null}

          {status?.state === "ready" && error && !opening.current ? (
            <button
              className="hosted-download-button"
              type="button"
              onClick={() => {
                setError(undefined);
                setDownloadProgress(undefined);
                setViewerOpenEnabled(true);
              }}
            >
              Retry viewer launch
            </button>
          ) : null}

          <div className="hosted-privacy-banner">
            <Link2 size={16} />
            <div>
              <strong>Anyone with this link can view and download this bundle.</strong>
              <span>
                {status?.expiresAtMs
                  ? `It expires ${formatTime(status.expiresAtMs)}.`
                  : "It is retained until an admin removes it."}
              </span>
            </div>
          </div>

          {status?.state === "ready" ? (
            <a
              className="hosted-download-button"
              href={hostedDownloadUrl(token)}
              download
              referrerPolicy="no-referrer"
            >
              <Download size={15} />
              Download .nettle
            </a>
          ) : null}
        </section>
      </main>
    </>
  );
}

export function HostedSessionNotFound() {
  return (
    <>
      <header className="hosted-page-header">
        <span className="brand">NETTLE</span>
        <span className="mode-badge hosted">SHAREABLE SESSION</span>
      </header>
      <main className="hosted-session-page">
        <section className="hosted-session-card">
          <span className="hosted-session-icon error">
            <AlertCircle size={26} />
          </span>
          <h1>Session not found or expired</h1>
          <p className="hosted-session-phase">
            Check that the complete shareable URL was copied correctly.
          </p>
        </section>
      </main>
    </>
  );
}

interface HostedSessionBannerProps {
  session: HostedViewerSession;
}

export function HostedSessionBanner({ session }: HostedSessionBannerProps) {
  return (
    <aside className="hosted-viewer-banner" aria-label="Shareable session information">
      <Server size={14} />
      <strong>Shareable session</strong>
      <span>Anyone with this link can view and download this bundle.</span>
      <span className="hosted-viewer-retention">
        <Clock3 size={13} />
        {session.status.expiresAtMs
          ? `Expires ${formatTime(session.status.expiresAtMs)}`
          : "Retained until an admin removes it"}
      </span>
      <span>
        Created {formatTime(session.status.admittedAtMs)}
        {session.status.completedAtMs === undefined
          ? ""
          : ` · Completed ${formatTime(session.status.completedAtMs)}`}
      </span>
      <a href={hostedDownloadUrl(session.token)} download referrerPolicy="no-referrer">
        <Download size={13} />
        Download .nettle
      </a>
    </aside>
  );
}

interface HostedComparisonBannerProps {
  reference?: HostedViewerSession;
  candidate?: HostedViewerSession;
  shareable?: boolean;
}

export function HostedComparisonBanner({
  reference,
  candidate,
  shareable = false,
}: HostedComparisonBannerProps) {
  const bothHosted = Boolean(reference && candidate);
  const single = reference ?? candidate;
  const comparisonExpiresAt =
    reference?.status.expiresAtMs || candidate?.status.expiresAtMs
      ? Math.min(
          reference?.status.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
          candidate?.status.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
        )
      : undefined;
  return (
    <aside
      className="hosted-viewer-banner hosted-comparison-banner"
      aria-label="Comparison privacy information"
    >
      <Server size={14} />
      <strong>
        {shareable
          ? "Shareable comparison"
          : bothHosted
            ? "Both inputs are shareable sessions"
            : `${reference ? "Reference" : "Candidate"} is from a shareable session`}
      </strong>
      <span>
        {shareable
          ? "Anyone with this link can view and download both bundles."
          : bothHosted
            ? "Comparison runs in this browser and creates no new shareable URL."
            : `${reference ? "Candidate" : "Reference"} stays in this browser and is not uploaded. The comparison creates no new shareable URL.`}
      </span>
      {shareable ? (
        <span className="hosted-viewer-retention">
          <Clock3 size={13} />
          {comparisonExpiresAt
            ? `Comparison expires ${formatTime(comparisonExpiresAt)}`
            : "Retained until an admin removes both sessions"}
        </span>
      ) : single && !bothHosted ? (
        <span className="hosted-viewer-retention">
          <Clock3 size={13} />
          {single.status.expiresAtMs
            ? `Original link expires ${formatTime(single.status.expiresAtMs)}`
            : "Original link remains until an admin removes it"}
        </span>
      ) : (
        <span className="hosted-viewer-retention">
          Original links remain independently shareable
        </span>
      )}
      {reference ? (
        <a href={hostedDownloadUrl(reference.token)} download referrerPolicy="no-referrer">
          <Download size={13} />
          Download reference
        </a>
      ) : null}
      {candidate ? (
        <a href={hostedDownloadUrl(candidate.token)} download referrerPolicy="no-referrer">
          <Download size={13} />
          Download candidate
        </a>
      ) : null}
    </aside>
  );
}
