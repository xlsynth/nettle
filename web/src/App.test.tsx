// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { OpenRequestOwner } from "./App";
import { BUILD_DATE_UTC, BUILD_GIT_SHA, BUILD_SUFFIX } from "./build-info";

const harness = vi.hoisted(() => ({
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
      onCompareBundles,
      hostedReference,
      hostedCandidate,
    }: {
      reference: { provider: { marker: number } };
      candidate: { provider: { marker: number } };
      initialPolicy: string;
      onCompareBundles: () => void;
      hostedReference?: unknown;
      hostedCandidate?: unknown;
    }) => {
      const [mountedIdentity] = React.useState(
        `${reference.provider.marker}:${candidate.provider.marker}:${initialPolicy}`,
      );
      return (
        <>
          <button type="button" onClick={onCompareBundles}>
            Compare Nettle bundles
          </button>
          <output data-testid="comparison-workspace">{mountedIdentity}</output>
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
  it("displays the software build metadata", () => {
    render(<App />);

    expect(screen.getByText(/Build date \(UTC\)/).textContent).toContain(BUILD_DATE_UTC);
    expect(screen.getByText(/Git SHA/).textContent).toContain(`${BUILD_GIT_SHA}${BUILD_SUFFIX}`);
  });

  it("keeps demo mode local-only with exactly two examples", () => {
    const fetch = vi.mocked(globalThis.fetch);
    window.history.replaceState(null, "", `/s/${"a".repeat(64)}`);
    render(<App mode="demo" />);

    expect(screen.getByRole("img", { name: "Nettle logo" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Explore an elaborated design" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bedrock CDC FIFO/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Schematic diff/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upload a bundle/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Build from RTL sources/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Compare two bundles/ })).toBeNull();
    expect(fetch.mock.calls.some(([request]) => String(request).startsWith("/api/v1/"))).toBe(
      false,
    );
    expect(harness.getHostedSessionStatus).not.toHaveBeenCalled();
    expect(harness.loadHostedBundle).not.toHaveBeenCalled();
  });

  it("keeps two-local-file comparison available without hosted API requests or uploads", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Compare two bundles" }));

    const dialog = screen.getByRole("dialog", { name: "Compare Nettle bundles" });
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

  it("reuses a ready hosted bundle as the reference while keeping the candidate local", async () => {
    const token = "a".repeat(64);
    window.history.replaceState(null, "", `/s/${token}`);
    render(<App />);

    await waitFor(() => expect(screen.getByText("SHAREABLE")).toBeTruthy());
    expect(harness.getHostedSessionStatus).toHaveBeenCalledOnce();
    expect(harness.loadHostedBundle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Compare Nettle bundles" }));

    const dialog = screen.getByRole("dialog", { name: "Compare Nettle bundles" });
    expect(within(dialog).getByText("design.nettle")).toBeTruthy();
    expect(within(dialog).getByText(/Reference already has a shareable URL/)).toBeTruthy();
    expect(within(dialog).getByText(/Any local bundle stays in this browser/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Choose candidate .nettle bundle file"), {
      target: { files: [new File(["candidate"], "candidate.nettle")] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Compare bundles" }));

    await waitFor(() =>
      expect(screen.getByTestId("comparison-workspace").textContent).toBe("2:3:conservative"),
    );
    expect(screen.getByTestId("hosted-comparison-origin").textContent).toBe("reference");
    expect(harness.getHostedSessionStatus).toHaveBeenCalledOnce();
    expect(harness.loadHostedBundle).toHaveBeenCalledOnce();
    expect(harness.createHostedSession).not.toHaveBeenCalled();
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
      screen.getByRole("button", { name: "Open a .nettle bundle" }).hasAttribute("disabled"),
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

    fireEvent.click(screen.getByRole("button", { name: /^Upload a bundle/ }));
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
    fireEvent.click(screen.getByRole("button", { name: "Compare two bundles" }));

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

  it("remounts a replacement with the same filenames and snapshot IDs", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Compare two bundles" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Compare Nettle bundles" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Compare two bundles" }));
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
