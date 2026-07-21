// SPDX-License-Identifier: Apache-2.0

export type HostedUploadKind = "bundle" | "sources";
export type HostedSessionState = "queued" | "building" | "ready" | "failed";
export type HostedComparisonMatching = "conservative" | "aggressive";

export interface HostedComparisonModulePair {
  referenceModule: string;
  candidateModule: string;
}

export interface HostedComparisonRoute {
  referenceToken: string;
  candidateToken: string;
  matching: HostedComparisonMatching;
  modulePair?: HostedComparisonModulePair;
}

export interface HostedRetentionPolicy {
  mode: "expires" | "forever";
  seconds?: number;
  display: string;
}

export interface HostedConfig {
  hostingEnabled: boolean;
  retention: HostedRetentionPolicy;
  limits: {
    maxUploadBytes: number;
    maxQueuedBuilds: number;
  };
  sourceFormats: string[];
}

export interface HostedSessionCreated {
  token: string;
  url: string;
  statusUrl: string;
}

export interface HostedSessionStatus {
  state: HostedSessionState;
  admittedAtMs: number;
  buildStartedAtMs?: number;
  completedAtMs?: number;
  expiresAtMs?: number;
  serverTimeMs: number;
  queuePosition?: number;
  error?: string;
}

export interface TransferProgress {
  loaded: number;
  total?: number;
  percent?: number;
}

export class HostedApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HostedApiError";
  }
}

const HOSTED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostedApiError(`${name} response is invalid`);
  }
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value) {
    throw new HostedApiError(`${name} is missing`);
  }
  return value;
};

const optionalString = (value: unknown, name: string) => {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, name);
};

const safeNonnegativeInteger = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HostedApiError(`${name} is invalid`);
  }
  return value as number;
};

const safePositiveInteger = (value: unknown, name: string) => {
  const parsed = safeNonnegativeInteger(value, name);
  if (parsed === 0) throw new HostedApiError(`${name} is invalid`);
  return parsed;
};

const optionalNonnegativeInteger = (value: unknown, name: string) => {
  if (value === undefined || value === null) return undefined;
  return safeNonnegativeInteger(value, name);
};

const decodeRetention = (value: unknown): HostedRetentionPolicy => {
  const candidate = record(value, "retention");
  if (candidate.mode !== "expires" && candidate.mode !== "forever") {
    throw new HostedApiError("retention mode is invalid");
  }
  const display = requiredString(candidate.display, "retention display");
  if (candidate.mode === "forever") return { mode: "forever", display };
  return {
    mode: "expires",
    seconds: safePositiveInteger(candidate.seconds, "retention seconds"),
    display,
  };
};

export const decodeHostedConfig = (value: unknown): HostedConfig => {
  const candidate = record(value, "host configuration");
  const limits = record(candidate.limits, "hosting limits");
  if (typeof candidate.hostingEnabled !== "boolean") {
    throw new HostedApiError("hostingEnabled is missing");
  }
  if (
    !Array.isArray(candidate.sourceFormats) ||
    candidate.sourceFormats.some((format) => typeof format !== "string" || !format)
  ) {
    throw new HostedApiError("sourceFormats is invalid");
  }
  return {
    hostingEnabled: candidate.hostingEnabled,
    retention: decodeRetention(candidate.retention),
    limits: {
      maxUploadBytes: safePositiveInteger(limits.maxUploadBytes, "maximum upload size"),
      maxQueuedBuilds: safeNonnegativeInteger(limits.maxQueuedBuilds, "maximum queued builds"),
    },
    sourceFormats: candidate.sourceFormats,
  };
};

export const decodeHostedSessionCreated = (value: unknown): HostedSessionCreated => {
  const candidate = record(value, "session creation");
  const token = requiredString(candidate.token, "session token");
  const url = requiredString(candidate.url, "session URL");
  const statusUrl = requiredString(candidate.statusUrl, "session status URL");
  if (!HOSTED_TOKEN_PATTERN.test(token)) {
    throw new HostedApiError("session token is invalid");
  }
  if (url !== `/s/${token}` || statusUrl !== `/api/v1/sessions/${token}/status`) {
    throw new HostedApiError("session routes are invalid");
  }
  return {
    token,
    url,
    statusUrl,
  };
};

export const decodeHostedSessionStatus = (value: unknown): HostedSessionStatus => {
  const candidate = record(value, "session status");
  if (
    candidate.state !== "queued" &&
    candidate.state !== "building" &&
    candidate.state !== "ready" &&
    candidate.state !== "failed"
  ) {
    throw new HostedApiError("session state is invalid");
  }
  const queuePosition =
    candidate.queuePosition === undefined || candidate.queuePosition === null
      ? undefined
      : safePositiveInteger(candidate.queuePosition, "queue position");
  return {
    state: candidate.state,
    admittedAtMs: safeNonnegativeInteger(candidate.admittedAtMs, "admission time"),
    buildStartedAtMs: optionalNonnegativeInteger(candidate.buildStartedAtMs, "build start time"),
    completedAtMs: optionalNonnegativeInteger(candidate.completedAtMs, "completion time"),
    expiresAtMs: optionalNonnegativeInteger(candidate.expiresAtMs, "expiration time"),
    serverTimeMs: safeNonnegativeInteger(candidate.serverTimeMs, "server time"),
    queuePosition,
    error: optionalString(candidate.error, "session error"),
  };
};

const errorMessage = async (response: Response) => {
  try {
    const value = (await response.json()) as Record<string, unknown>;
    if (typeof value.detail === "string" && value.detail) return value.detail;
    if (typeof value.error === "string" && value.error) return value.error;
    if (typeof value.message === "string" && value.message) return value.message;
  } catch {
    // Use the bounded status fallback below.
  }
  if (response.status === 507) {
    return "This Nettle server is out of storage space. Try again after old sessions are removed or contact the admin.";
  }
  return `Hosted Nettle request failed (${response.status})`;
};

const checkedJson = async (response: Response) => {
  if (!response.ok) throw new HostedApiError(await errorMessage(response), response.status);
  return response.json() as Promise<unknown>;
};

export const getHostedConfig = async (signal?: AbortSignal) => {
  const response = await fetch("/api/v1/config", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  return decodeHostedConfig(await checkedJson(response));
};

const xhrErrorMessage = (xhr: XMLHttpRequest) => {
  const value = xhr.response;
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    for (const name of ["detail", "error", "message"]) {
      if (typeof candidate[name] === "string" && candidate[name]) return candidate[name] as string;
    }
  }
  if (xhr.status === 507) {
    return "This Nettle server is out of storage space. Try again after old sessions are removed or contact the admin.";
  }
  return xhr.status
    ? `Hosted Nettle upload failed (${xhr.status})`
    : "Could not reach the hosted Nettle service";
};

export const createHostedSession = (
  kind: HostedUploadKind,
  file: File,
  sourceFilelist: string | undefined,
  onProgress: (progress: TransferProgress) => void,
  signal?: AbortSignal,
) =>
  new Promise<HostedSessionCreated>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("kind", kind);
    if (kind === "sources" && sourceFilelist) form.append("filelist", sourceFilelist);
    form.append("file", file, file.name);
    xhr.open("POST", "/api/v1/sessions");
    xhr.setRequestHeader("X-Nettle-Upload", "1");
    xhr.responseType = "json";
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (event) => {
      const total = event.lengthComputable ? event.total : undefined;
      onProgress({
        loaded: event.loaded,
        total,
        percent: total ? Math.min(100, (event.loaded / total) * 100) : undefined,
      });
    });
    xhr.upload.addEventListener("load", () => {
      onProgress({
        loaded: file.size,
        total: file.size,
        percent: 100,
      });
    });
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.addEventListener("load", () => {
      signal?.removeEventListener("abort", abort);
      if (xhr.status !== 201 && xhr.status !== 202) {
        reject(new HostedApiError(xhrErrorMessage(xhr), xhr.status));
        return;
      }
      try {
        resolve(decodeHostedSessionCreated(xhr.response));
      } catch (reason) {
        reject(reason);
      }
    });
    xhr.addEventListener("error", () => {
      signal?.removeEventListener("abort", abort);
      reject(new HostedApiError(xhrErrorMessage(xhr), xhr.status || undefined));
    });
    xhr.addEventListener("abort", () => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("The upload was aborted", "AbortError"));
    });
    xhr.send(form);
  });

export const getHostedSessionStatus = async (token: string, signal?: AbortSignal) => {
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(token)}/status`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  return decodeHostedSessionStatus(await checkedJson(response));
};

export const hostedBundleUrl = (token: string) =>
  `/api/v1/sessions/${encodeURIComponent(token)}/bundle`;

export const hostedDownloadUrl = (token: string) =>
  `/api/v1/sessions/${encodeURIComponent(token)}/download`;

export const loadHostedBundle = async (
  token: string,
  onProgress: (progress: TransferProgress) => void,
  signal?: AbortSignal,
) => {
  const response = await fetch(hostedBundleUrl(token), {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new HostedApiError(await errorMessage(response), response.status);
  if (response.headers.get("content-type")?.includes("text/html")) {
    throw new HostedApiError("Hosted bundle route returned HTML");
  }
  const contentLength = Number(response.headers.get("content-length"));
  const total =
    Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : undefined;
  if (!response.body) {
    const blob = await response.blob();
    onProgress({
      loaded: blob.size,
      total: total ?? blob.size,
      percent: 100,
    });
    return new File([blob], "design.nettle", {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loaded = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy.buffer);
    loaded += value.byteLength;
    onProgress({
      loaded,
      total,
      percent: total ? Math.min(100, (loaded / total) * 100) : undefined,
    });
  }
  onProgress({ loaded, total, percent: total ? 100 : undefined });
  return new File(chunks, "design.nettle", {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
};

export const hostedSessionTokenFromPath = (pathname: string) => {
  const match = pathname.match(/\/s\/([A-Za-z0-9_-]{32,128})\/?$/);
  return match?.[1];
};

export const isHostedSessionPath = (pathname: string) => /\/s\/[^/]*\/?$/.test(pathname);

export const classifyHostedUploadKind = (
  filename: string,
  sourceFormats: readonly string[],
): HostedUploadKind | undefined => {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".nettle")) return "bundle";
  const normalized = sourceFormats
    .map((format) => format.toLowerCase())
    .map((format) => (format.startsWith(".") ? format : `.${format}`))
    .sort((left, right) => right.length - left.length);
  return normalized.some((format) => lower.endsWith(format)) ? "sources" : undefined;
};

export const hostedComparisonPath = ({
  referenceToken,
  candidateToken,
  matching,
  modulePair,
}: HostedComparisonRoute) => {
  if (!HOSTED_TOKEN_PATTERN.test(referenceToken) || !HOSTED_TOKEN_PATTERN.test(candidateToken)) {
    throw new HostedApiError("comparison session token is invalid");
  }
  const query = new URLSearchParams({ matching });
  if (modulePair) {
    if (!modulePair.referenceModule || !modulePair.candidateModule) {
      throw new HostedApiError("comparison module pair is invalid");
    }
    query.set("referenceModule", modulePair.referenceModule);
    query.set("candidateModule", modulePair.candidateModule);
  }
  return `/compare/${referenceToken}/${candidateToken}?${query.toString()}`;
};

export const hostedComparisonRouteFromLocation = (
  pathname: string,
  search = "",
): HostedComparisonRoute | undefined => {
  const match = pathname.match(/\/compare\/([A-Za-z0-9_-]{32,128})\/([A-Za-z0-9_-]{32,128})\/?$/);
  if (!match) return undefined;
  const query = new URLSearchParams(search);
  const matching = query.get("matching");
  const referenceModule = query.get("referenceModule");
  const candidateModule = query.get("candidateModule");
  return {
    referenceToken: match[1],
    candidateToken: match[2],
    matching: matching === "aggressive" ? "aggressive" : "conservative",
    ...(referenceModule && candidateModule
      ? { modulePair: { referenceModule, candidateModule } }
      : {}),
  };
};

export const isHostedComparisonPath = (pathname: string) =>
  /\/compare\/[^/]*\/[^/]*\/?$/.test(pathname);
