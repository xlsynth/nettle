// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { OpenRequestOwner } from "./App";
import { BUILD_DATE_UTC, BUILD_GIT_SHA, BUILD_SUFFIX } from "./build-info";

const harness = vi.hoisted(() => ({
  createHostedAzureSession: vi.fn(),
  loadWorkspace: vi.fn(),
  open: vi.fn(),
  createHostedSession: vi.fn(),
  getHostedConfig: vi.fn(),
  getHostedSessionStatus: vi.fn(),
  loadHostedBundle: vi.fn(),
  providerSequence: 0,
}));

vi.mock("./bundle/provider", () => ({
  COMPARISON_BUNDLE_CACHE_LIMITS: { modulesBytes: 1, sourcesBytes: 1 },
  DEFAULT_BUNDLE_CACHE_LIMITS: { modulesBytes: 1, sourcesBytes: 1 },
  LocalBundleProvider: { open: harness.open },
}));

vi.mock("./api/workspace", () => ({ loadWorkspace: harness.loadWorkspace }));

vi.mock("./api/hosted", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api/hosted")>();
  return {
    ...original,
    createHostedAzureSession: harness.createHostedAzureSession,
    createHostedSession: harness.createHostedSession,
    getHostedConfig: harness.getHostedConfig,
    getHostedSessionStatus: harness.getHostedSessionStatus,
    loadHostedBundle: harness.loadHostedBundle,
  };
});

vi.mock("./components/ComparisonWorkspaceView", async () => {
  const React = await import("react");
  return {
    ComparisonWorkspaceView: ({
      reference,
      candidate,
      initialPolicy,
      onCloseDesign,
      hostedReference,
      hostedCandidate,
      shareableComparison,
      initialModulePair,
      onModulePairChange,
      onPolicyChange,
    }: {
      reference: { provider: { marker: number } };
      candidate: { provider: { marker: number } };
      initialPolicy: string;
      onCloseDesign: () => void;
      hostedReference?: unknown;
      hostedCandidate?: unknown;
      shareableComparison?: boolean;
      initialModulePair?: { referenceModule: string; candidateModule: string };
      onModulePairChange?: (modulePair: {
        referenceModule: string;
        candidateModule: string;
      }) => void;
      onPolicyChange?: (policy: "conservative" | "aggressive") => void;
    }) => {
      const [mountedIdentity] = React.useState(
        `${reference.provider.marker}:${candidate.provider.marker}:${initialPolicy}`,
      );
      return (
        <>
          <button type="button" onClick={onCloseDesign}>
            Close design
          </button>
          <output data-testid="comparison-workspace">{mountedIdentity}</output>
          {shareableComparison ? (
            <>
              <output data-testid="shareable-comparison">shareable</output>
              {initialModulePair ? (
                <output data-testid="explicit-module-pair">
                  {initialModulePair.referenceModule}:{initialModulePair.candidateModule}
                </output>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  onModulePairChange?.({
                    referenceModule: "reference_selected",
                    candidateModule: "candidate_selected",
                  })
                }
              >
                Confirm explicit module pair
              </button>
              <button type="button" onClick={() => onPolicyChange?.("aggressive")}>
                Use aggressive matching
              </button>
            </>
          ) : null}
          {hostedReference || hostedCandidate ? (
            <output data-testid="hosted-comparison-origin">
              {hostedReference ? "reference" : ""}
              {hostedReference && hostedCandidate ? "+" : ""}
              {hostedCandidate ? "candidate" : ""}
            </output>
          ) : null}
        </>
      );
    },
  };
});

vi.mock("./graph/SchematicCanvas", () => ({
  SchematicCanvas: () => <div data-testid="schematic-canvas" />,
}));

const project = {
  name: "fixture",
  projectRoot: "",
  filelist: "fixture.f",
  yosysJson: "",
  slangAstJson: "",
  bundleStatus: "Bundle ready",
  snapshotId: "stable-snapshot",
  files: [],
  defines: [],
  elaboration: { parameters: [], defines: [], undefines: [] },
  effectiveElaboration: { parameters: [], defines: [], undefines: [] },
  tools: [],
};

const hostedConfig = {
  hostingEnabled: true,
  azureEnabled: false,
  retention: {
    mode: "expires" as const,
    seconds: 2_592_000,
    display: "Retained for 30 days after completion",
  },
  limits: { maxUploadBytes: 1024 * 1024, maxQueuedBuilds: 32 },
  sourceFormats: ["zip", "tar", "tar.gz", "tgz"],
};

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

beforeEach(() => {
  harness.providerSequence = 0;
  harness.open.mockImplementation(async (file: File) => ({
    fileName: file.name,
    marker: ++harness.providerSequence,
    getSourceInventory: vi.fn(async () => []),
    getProject: vi.fn(async () => ({ modules: [] })),
  }));
  harness.loadWorkspace.mockImplementation(async () => ({
    project,
    slice: {
      snapshotId: "stable-snapshot",
      module: {
        id: "top",
        name: "top",
        instancePath: "top",
        definitionName: "top",
        parameters: {},
      },
      nodes: [],
      edges: [],
    },
  }));
  harness.getHostedConfig.mockResolvedValue(hostedConfig);
  harness.createHostedAzureSession.mockResolvedValue({
    token: "b".repeat(43),
    url: `/s/${"b".repeat(43)}`,
    statusUrl: `/api/v1/sessions/${"b".repeat(43)}/status`,
  });
  harness.getHostedSessionStatus.mockResolvedValue({
    state: "ready",
    admittedAtMs: 1_000,
    completedAtMs: 2_000,
    serverTimeMs: 3_000,
  });
  harness.loadHostedBundle.mockResolvedValue(
    new File(["hosted"], "design.nettle", { type: "application/octet-stream" }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
    })),
  );
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("App comparison installation", () => {
  it("hides Azure imports when the hosted server has not enabled them", async () => {
    render(<App mode="hosted" />);

    await waitFor(() => expect(harness.getHostedConfig).toHaveBeenCalled());
    expect(screen.queryByRole("textbox", { name: "Azure blob path" })).toBeNull();
  });

  it("offers an inline Azure path only after the hosted server advertises it", async () => {
    harness.getHostedConfig.mockResolvedValueOnce({ ...hostedConfig, azureEnabled: true });
    render(<App mode="hosted" />);

    const path = await screen.findByRole("textbox", { name: "Azure blob path" });
    expect(screen.queryByRole("button", { name: /Azure/ })).toBeNull();
    fireEvent.change(path, {
      target: { value: "az://account/container/design.nettle" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Azure blob import" }));

    await waitFor(() =>
      expect(harness.createHostedAzureSession).toHaveBeenCalledWith(
        "az://account/container/design.nettle",
        undefined,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(window.location.pathname).toBe(`/s/${"b".repeat(43)}`));
  });

  it("keeps hosted landing workflows available if capability discovery fails", async () => {
    harness.getHostedConfig.mockRejectedValueOnce(new Error("Configuration unavailable"));
    render(<App mode="hosted" />);

    await waitFor(() => expect(harness.getHostedConfig).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Upload and view a .nettle bundle" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Azure blob path" })).toBeNull();
  });

  it("displays the software build metadata", () => {
    render(<App />);

    expect(screen.getByText(/Build date \(UTC\)/).textContent).toContain(BUILD_DATE_UTC);
    expect(screen.getByText(/Git SHA/).textContent).toContain(`${BUILD_GIT_SHA}${BUILD_SUFFIX}`);
  });

  it("keeps static mode local-only with exactly two examples", () => {
    const fetch = vi.mocked(globalThis.fetch);
    window.history.replaceState(null, "", `/s/${"a".repeat(64)}`);
    render(<App mode="static" />);

    expect(screen.getByRole("img", { name: "Nettle logo" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Open a design" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bedrock CDC FIFO/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Schematic diff/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Upload and view a \.nettle bundle/,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Upload, build, and view a \.nettle bundle from RTL sources/,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Open and compare two \.nettle bundles/,
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Upload and compare two designs/ })).toBeNull();
    expect(fetch.mock.calls.some(([request]) => String(request).startsWith("/api/v1/"))).toBe(
      false,
    );
    expect(harness.getHostedSessionStatus).not.toHaveBeenCalled();
    expect(harness.loadHostedBundle).not.toHaveBeenCalled();
  });

  it("keeps two-local-file comparison available without hosted API requests or uploads", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open and compare two .nettle bundles",
      }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Compare Nettle bundles",
    });
    expect(within(dialog).getByText("Bundles stay in this browser.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Choose reference .nettle bundle file"), {
      target: { files: [new File(["reference"], "reference.nettle")] },
    });
    fireEvent.change(within(dialog).getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [new File(["candidate"], "candidate.nettle")] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Compare bundles" }));

    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:conservative"),
    );
    expect(fetch.mock.calls.some(([request]) => String(request).startsWith("/api/v1/"))).toBe(
      false,
    );
    expect(harness.createHostedSession).not.toHaveBeenCalled();
    expect(harness.getHostedSessionStatus).not.toHaveBeenCalled();
    expect(harness.loadHostedBundle).not.toHaveBeenCalled();
  });

  it("opens the hosted comparison upload dialog from the fifth landing action", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Upload and compare two designs" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Upload and compare two designs",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Anyone with the comparison URL can view and download both bundles/),
    ).toBeTruthy();
  });

  it("loads a composed comparison route and persists matching changes in its URL", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative`,
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:conservative"),
    );
    expect(screen.getByTestId("shareable-comparison").textContent).toBe("shareable");
    expect(window.location.pathname).toBe(`/compare/${referenceToken}/${candidateToken}`);

    fireEvent.click(screen.getByRole("button", { name: "Use aggressive matching" }));
    expect(window.location.search).toBe("?matching=aggressive");
  });

  it("restores and persists an explicit module pair in a shareable comparison URL", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative&referenceModule=reference_top&candidateModule=candidate_top`,
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("explicit-module-pair").textContent).toBe(
        "reference_top:candidate_top",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm explicit module pair" }));
    expect(new URLSearchParams(window.location.search).get("referenceModule")).toBe(
      "reference_selected",
    );
    expect(new URLSearchParams(window.location.search).get("candidateModule")).toBe(
      "candidate_selected",
    );

    fireEvent.click(screen.getByRole("button", { name: "Use aggressive matching" }));
    expect(new URLSearchParams(window.location.search).get("matching")).toBe("aggressive");
    expect(new URLSearchParams(window.location.search).get("referenceModule")).toBe(
      "reference_selected",
    );
    expect(new URLSearchParams(window.location.search).get("candidateModule")).toBe(
      "candidate_selected",
    );
  });

  it("closes a hosted comparison to the landing page and lets Back restore it", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=aggressive`,
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:aggressive"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close design" }));

    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Open a design" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close design" })).toBeNull();

    const restored = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.back();
    await restored;
    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("3:4:aggressive"),
    );
    expect(window.location.pathname).toBe(`/compare/${referenceToken}/${candidateToken}`);
    expect(window.location.search).toBe("?matching=aggressive");
  });

  it("restarts an in-flight direct comparison after matching-only navigation", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    const firstSignals: AbortSignal[] = [];
    let downloadCalls = 0;
    harness.loadHostedBundle.mockImplementation(
      (_token: string, _progress: (value: unknown) => void, signal: AbortSignal) => {
        downloadCalls += 1;
        if (downloadCalls > 2) {
          return Promise.resolve(
            new File(["hosted"], "design.nettle", {
              type: "application/octet-stream",
            }),
          );
        }
        firstSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative`,
    );
    render(<App />);
    await waitFor(() => expect(firstSignals).toHaveLength(2));

    window.history.pushState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=aggressive`,
    );
    fireEvent.popState(window);

    await waitFor(() => expect(firstSignals.every((signal) => signal.aborted)).toBe(true));
    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:aggressive"),
    );
  });

  it("restarts an in-flight direct comparison after module-pair-only navigation", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    const firstSignals: AbortSignal[] = [];
    let downloadCalls = 0;
    harness.loadHostedBundle.mockImplementation(
      (_token: string, _progress: (value: unknown) => void, signal: AbortSignal) => {
        downloadCalls += 1;
        if (downloadCalls > 2) {
          return Promise.resolve(
            new File(["hosted"], "design.nettle", {
              type: "application/octet-stream",
            }),
          );
        }
        firstSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative&referenceModule=reference_old&candidateModule=candidate_old`,
    );
    render(<App />);
    await waitFor(() => expect(firstSignals).toHaveLength(2));

    window.history.pushState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative&referenceModule=reference_new&candidateModule=candidate_new`,
    );
    fireEvent.popState(window);

    await waitFor(() => expect(firstSignals.every((signal) => signal.aborted)).toBe(true));
    await waitFor(() =>
      expect(screen.getByTestId("explicit-module-pair").textContent).toBe(
        "reference_new:candidate_new",
      ),
    );
  });

  it("cancels an in-flight hosted comparison when a local drop starts", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    const downloadSignals: AbortSignal[] = [];
    let localSignal: AbortSignal | undefined;
    harness.loadHostedBundle.mockImplementation(
      (_token: string, _progress: (value: unknown) => void, signal: AbortSignal) => {
        downloadSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    harness.open.mockImplementation(
      (_file: File, _limits: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          localSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative`,
    );
    render(<App />);
    await waitFor(() => expect(downloadSignals).toHaveLength(2));

    fireEvent.drop(screen.getByRole("application"), {
      dataTransfer: {
        files: [new File(["local"], "local.nettle", { type: "application/zip" })],
      },
    });

    await waitFor(() => expect(downloadSignals.every((signal) => signal.aborted)).toBe(true));
    await waitFor(() => expect(harness.open).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe("/");
    expect(harness.loadHostedBundle).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("comparison-workspace")).toBeNull();
    expect(localSignal?.aborted).toBe(false);
  });

  it("keeps hosted session retry UI mounted after browser validation fails", async () => {
    const token = "a".repeat(64);
    harness.open.mockRejectedValue(new Error("invalid hosted bundle"));
    window.history.replaceState(null, "", `/s/${token}`);
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("invalid hosted bundle");
    expect(screen.getByRole("button", { name: "Retry viewer launch" })).toBeTruthy();
    expect(harness.loadHostedBundle).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe(`/s/${token}`);
  });

  it("keeps hosted comparison retry UI mounted after browser validation fails", async () => {
    const referenceToken = "a".repeat(64);
    const candidateToken = "b".repeat(64);
    harness.open.mockRejectedValue(new Error("invalid hosted comparison"));
    window.history.replaceState(
      null,
      "",
      `/compare/${referenceToken}/${candidateToken}?matching=conservative`,
    );
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("invalid hosted comparison");
    expect(screen.getByRole("button", { name: "Retry viewer launch" })).toBeTruthy();
    expect(harness.loadHostedBundle).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe(`/compare/${referenceToken}/${candidateToken}`);
  });

  it("keeps a loaded shareable route when a local replacement fails", async () => {
    const token = "a".repeat(64);
    window.history.replaceState(null, "", `/s/${token}`);
    render(<App />);
    await waitFor(() => expect(screen.getByText("SHAREABLE")).toBeTruthy());
    harness.open.mockRejectedValueOnce(new Error("invalid local replacement"));

    fireEvent.drop(screen.getByRole("application"), {
      dataTransfer: {
        files: [new File(["invalid"], "invalid.nettle", { type: "application/zip" })],
      },
    });

    await waitFor(() => expect(harness.open).toHaveBeenCalledTimes(2));
    expect(window.location.pathname).toBe(`/s/${token}`);
    expect(screen.getByText("SHAREABLE")).toBeTruthy();
  });

  it("closes a hosted session to the landing page and lets Back restore it", async () => {
    const token = "a".repeat(64);
    window.history.replaceState(null, "", `/s/${token}`);
    render(<App />);

    await waitFor(() => expect(screen.getByText("SHAREABLE")).toBeTruthy());
    expect(harness.getHostedSessionStatus).toHaveBeenCalledOnce();
    expect(harness.loadHostedBundle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close design" }));

    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Open a design" })).toBeTruthy();

    const restored = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.back();
    await restored;
    await waitFor(() => expect(screen.getByText("SHAREABLE")).toBeTruthy());
    expect(window.location.pathname).toBe(`/s/${token}`);
    expect(harness.getHostedSessionStatus).toHaveBeenCalledTimes(2);
    expect(harness.loadHostedBundle).toHaveBeenCalledTimes(2);
  });

  it("opens a local bundle without contacting hosted APIs", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Open a .nettle bundle locally"), {
      target: {
        files: [new File(["bundle"], "local.nettle", { type: "application/zip" })],
      },
    });

    await waitFor(() => expect(screen.getByText("LOCAL · NOT UPLOADED")).toBeTruthy());
    expect(fetch.mock.calls.some(([request]) => String(request).startsWith("/api/v1/"))).toBe(
      false,
    );
    expect(harness.open).toHaveBeenCalledOnce();
  });

  it("closes a local static bundle back to the static landing page", async () => {
    render(<App mode="static" />);
    fireEvent.change(screen.getByLabelText("Open a .nettle bundle locally"), {
      target: {
        files: [new File(["bundle"], "local.nettle", { type: "application/zip" })],
      },
    });

    await waitFor(() => expect(screen.getByText("LOCAL · NOT UPLOADED")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close design" }));

    expect(screen.getByRole("heading", { name: "Open a design" })).toBeTruthy();
    expect(screen.getByText("Static mode")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close design" })).toBeNull();
  });

  it("keeps the landing action loading while launching a local bundle", async () => {
    const provider = deferred<{
      fileName: string;
      marker: number;
      getSourceInventory: ReturnType<typeof vi.fn>;
      getProject: ReturnType<typeof vi.fn>;
    }>();
    const workspace = deferred<{
      project: typeof project;
      slice: {
        snapshotId: string;
        module: {
          id: string;
          name: string;
          instancePath: string;
          definitionName: string;
          parameters: Record<string, string>;
        };
        nodes: never[];
        edges: never[];
      };
    }>();
    harness.open.mockReturnValueOnce(provider.promise);
    harness.loadWorkspace.mockReturnValueOnce(workspace.promise);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Open a .nettle bundle locally"), {
      target: {
        files: [new File(["bundle"], "local.nettle", { type: "application/zip" })],
      },
    });

    expect(
      screen
        .getByRole("button", { name: "Open and view a .nettle bundle" })
        .hasAttribute("disabled"),
    ).toBe(true);
    provider.resolve({
      fileName: "local.nettle",
      marker: 1,
      getSourceInventory: vi.fn(async () => []),
      getProject: vi.fn(async () => ({ modules: [] })),
    });
    workspace.resolve({
      project,
      slice: {
        snapshotId: "stable-snapshot",
        module: {
          id: "top",
          name: "top",
          instancePath: "top",
          definitionName: "top",
          parameters: {},
        },
        nodes: [],
        edges: [],
      },
    });
    await waitFor(() => expect(screen.getByText("LOCAL · NOT UPLOADED")).toBeTruthy());
  });

  it("clears local bundle loading when history navigation aborts validation", async () => {
    const provider = deferred<{
      fileName: string;
      marker: number;
      getSourceInventory: ReturnType<typeof vi.fn>;
      getProject: ReturnType<typeof vi.fn>;
    }>();
    harness.open.mockReturnValueOnce(provider.promise);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Open a .nettle bundle locally"), {
      target: {
        files: [new File(["bundle"], "local.nettle", { type: "application/zip" })],
      },
    });
    await waitFor(() => expect(harness.open).toHaveBeenCalledOnce());

    window.history.pushState(null, "", "/");
    fireEvent.popState(window);

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open Nettle bundle" })).toBeNull(),
    );
    expect(screen.getByLabelText("Open a .nettle bundle locally").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("aborts an active hosted upload when history navigation changes routes", async () => {
    let uploadSignal: AbortSignal | undefined;
    harness.createHostedSession.mockImplementation(
      (
        _kind: string,
        _file: File,
        _filelist: string | undefined,
        _progress: (value: unknown) => void,
        signal: AbortSignal,
      ) => {
        uploadSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("The upload was aborted.", "AbortError")),
            { once: true },
          );
        });
      },
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Upload and view a .nettle bundle" }));
    fireEvent.change(await screen.findByLabelText("Choose bundle to upload"), {
      target: { files: [new File(["bundle"], "design.nettle")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload and create link" }));
    await waitFor(() => expect(harness.createHostedSession).toHaveBeenCalledOnce());

    window.history.pushState(null, "", `/s/${"a".repeat(64)}`);
    fireEvent.popState(window);

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Upload bundle and create link" })).toBeNull(),
    );
    expect(uploadSignal?.aborted).toBe(true);
  });

  it("aborts eager validation when a rapid bundle replacement supersedes it", () => {
    const owner = new OpenRequestOwner();
    const first = owner.begin();
    const second = owner.begin();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    owner.finish(first);
    owner.abort();
    expect(second.signal.aborted).toBe(true);
  });

  it("keeps the newer request alive when an older request finishes", () => {
    const owner = new OpenRequestOwner();
    const first = owner.begin();
    const second = owner.begin();

    owner.finish(first);
    expect(second.signal.aborted).toBe(false);
  });

  it("does not reinterpret a drop on comparison dialog chrome as a single-bundle open", () => {
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open and compare two .nettle bundles",
      }),
    );

    fireEvent.drop(screen.getByRole("dialog", { name: "Compare Nettle bundles" }), {
      dataTransfer: {
        files: [
          new File(["bundle"], "accidental.nettle", {
            type: "application/zip",
          }),
        ],
      },
    });

    expect(harness.open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Compare Nettle bundles" })).toBeTruthy();
  });

  it("closes a comparison before starting a fresh comparison with the same filenames", async () => {
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open and compare two .nettle bundles",
      }),
    );
    const reference = new File(["reference"], "reference.nettle", {
      type: "application/zip",
    });
    const candidate = new File(["candidate"], "candidate.nettle", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("Choose reference .nettle bundle file"), {
      target: { files: [reference] },
    });
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [candidate] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare bundles" }));

    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:conservative"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close design" }));
    expect(screen.getByRole("heading", { name: "Open a design" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open and compare two .nettle bundles",
      }),
    );
    fireEvent.change(screen.getByLabelText("Choose reference .nettle bundle file"), {
      target: { files: [reference] },
    });
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [candidate] },
    });
    fireEvent.change(screen.getByLabelText(/Matching policy/), {
      target: { value: "aggressive" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare bundles" }));

    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("3:4:aggressive"),
    );
  });

  it("does not let a delayed hosted comparison replace a user-selected comparison", async () => {
    const startup = deferred<{
      ok: boolean;
      status: number;
      headers: { get: (name: string) => string | null };
      json: () => Promise<unknown>;
    }>();
    const fetch = vi.fn(() => startup.promise);
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open and compare two .nettle bundles",
      }),
    );
    fireEvent.change(screen.getByLabelText("Choose reference .nettle bundle file"), {
      target: { files: [new File(["reference"], "user-reference.nettle")] },
    });
    fireEvent.change(screen.getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [new File(["candidate"], "user-candidate.nettle")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare bundles" }));
    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:conservative"),
    );

    startup.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      json: async () => ({
        reference: {
          name: "host-reference.nettle",
          route: "/startup-reference.nettle",
        },
        candidate: {
          name: "host-candidate.nettle",
          route: "/startup-candidate.nettle",
        },
        matching: "aggressive",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:conservative");
    expect(harness.open).toHaveBeenCalledTimes(2);
  });
});
