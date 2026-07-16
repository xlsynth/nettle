// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { OpenRequestOwner } from "./App";
import { BundleWelcome } from "./components/OpenBundle";

const harness = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  open: vi.fn(),
  providerSequence: 0,
}));

vi.mock("./bundle/provider", () => ({
  COMPARISON_BUNDLE_CACHE_LIMITS: { modulesBytes: 1, sourcesBytes: 1 },
  DEFAULT_BUNDLE_CACHE_LIMITS: { modulesBytes: 1, sourcesBytes: 1 },
  LocalBundleProvider: { open: harness.open },
}));

vi.mock("./api/workspace", () => ({ loadWorkspace: harness.loadWorkspace }));

vi.mock("./components/ComparisonWorkspaceView", async () => {
  const React = await import("react");
  return {
    ComparisonWorkspaceView: ({
      reference,
      candidate,
      initialPolicy,
      onCompareBundles,
    }: {
      reference: { provider: { marker: number } };
      candidate: { provider: { marker: number } };
      initialPolicy: string;
      onCompareBundles: () => void;
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("App comparison installation", () => {
  it("keeps the original welcome UI when Azure bundles are disabled", () => {
    render(<BundleWelcome loading={false} onSelect={vi.fn()} />);

    expect(screen.queryByLabelText("Azure path")).toBeNull();
    expect(screen.queryByText("or open an existing bundle")).toBeNull();
    expect(screen.getByText("Choose a .nettle bundle")).toBeTruthy();
  });

  it("builds an Azure RTL directory and opens the generated bundle", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/build" && init?.method === "POST") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Azure path"), {
      target: { value: "az://storage.example/container/project/hdl/" },
    });
    fireEvent.change(screen.getByLabelText("Project filelist"), {
      target: { value: "rtl/project.f" },
    });
    fireEvent.change(screen.getByLabelText("Top module"), {
      target: { value: "rtx" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    await waitFor(() => expect(harness.open).toHaveBeenCalled());
    const generated = harness.open.mock.calls.at(-1)?.[0] as File;
    expect(generated.name).toBe("rtx.nettle");
    const create = fetch.mock.calls.find(
      ([input, init]) => String(input) === "/api/build" && init?.method === "POST",
    );
    expect(create?.[1]?.body).toBe(
      JSON.stringify({
        azurePath: "az://storage.example/container/project/hdl/",
        filelist: "rtl/project.f",
        top: "rtx",
      }),
    );
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

  it("does not reinterpret a drop on comparison dialog chrome as a single-bundle open", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Compare two bundles" }));

    fireEvent.drop(screen.getByRole("dialog", { name: "Compare Nettle bundles" }), {
      dataTransfer: {
        files: [new File(["bundle"], "accidental.nettle", { type: "application/zip" })],
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
        reference: { name: "host-reference.nettle", route: "/startup-reference.nettle" },
        candidate: { name: "host-candidate.nettle", route: "/startup-candidate.nettle" },
        matching: "aggressive",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("comparison-workspace").textContent).toBe("1:2:conservative");
    expect(harness.open).toHaveBeenCalledTimes(2);
  });
});
