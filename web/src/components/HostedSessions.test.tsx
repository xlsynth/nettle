// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedApiError } from "../api/hosted";
import {
  HostedAzureImportDialog,
  HostedSessionBanner,
  HostedSessionPage,
  HostedUploadDialog,
} from "./HostedSessions";

const harness = vi.hoisted(() => ({
  createHostedAzureSession: vi.fn(),
  createHostedSession: vi.fn(),
  getHostedConfig: vi.fn(),
  getHostedSessionStatus: vi.fn(),
  loadHostedBundle: vi.fn(),
}));

vi.mock("../api/hosted", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/hosted")>();
  return {
    ...original,
    createHostedAzureSession: harness.createHostedAzureSession,
    createHostedSession: harness.createHostedSession,
    getHostedConfig: harness.getHostedConfig,
    getHostedSessionStatus: harness.getHostedSessionStatus,
    loadHostedBundle: harness.loadHostedBundle,
  };
});

const config = {
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

beforeEach(() => {
  harness.getHostedConfig.mockResolvedValue(config);
  harness.createHostedSession.mockResolvedValue({
    token: "a".repeat(43),
    url: `/s/${"a".repeat(43)}`,
    statusUrl: `/api/v1/sessions/${"a".repeat(43)}/status`,
  });
  harness.createHostedAzureSession.mockResolvedValue({
    token: "b".repeat(43),
    url: `/s/${"b".repeat(43)}`,
    statusUrl: `/api/v1/sessions/${"b".repeat(43)}/status`,
  });
});

describe("HostedAzureImportDialog", () => {
  const azureConfig = { ...config, azureEnabled: true };

  it("remains hidden when the hosted Azure capability is disabled", () => {
    render(<HostedAzureImportDialog open config={config} onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.createHostedAzureSession).not.toHaveBeenCalled();
  });

  it("discloses visibility and imports an Azure bundle only after confirmation", async () => {
    const onCreated = vi.fn();
    render(
      <HostedAzureImportDialog open config={azureConfig} onClose={vi.fn()} onCreated={onCreated} />,
    );

    expect(screen.getByText(/Anyone with the resulting URL/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Import and create link" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Azure blob path"), {
      target: { value: "az://account/container/design.nettle" },
    });
    expect(harness.createHostedAzureSession).not.toHaveBeenCalled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(harness.createHostedAzureSession).toHaveBeenCalledWith(
        "az://account/container/design.nettle",
        undefined,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });

  it("submits the selected source filelist for an Azure archive", async () => {
    render(
      <HostedAzureImportDialog open config={azureConfig} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Azure blob path"), {
      target: { value: "az://account/container/project.tar.gz" },
    });
    fireEvent.change(screen.getByLabelText("Azure source root filelist path"), {
      target: { value: "rtl/project.f" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import and create link" }));

    await waitFor(() =>
      expect(harness.createHostedAzureSession).toHaveBeenCalledWith(
        "az://account/container/project.tar.gz",
        "rtl/project.f",
        expect.any(AbortSignal),
      ),
    );
  });

  it("displays a failed Azure import without closing the dialog", async () => {
    harness.createHostedAzureSession.mockRejectedValueOnce(
      new HostedApiError("Azure authentication is unavailable", 502),
    );
    render(
      <HostedAzureImportDialog open config={azureConfig} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Azure blob path"), {
      target: { value: "az://account/container/design.nettle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import and create link" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Azure authentication is unavailable",
    );
    expect(screen.getByRole("dialog", { name: "Open from Azure" })).toBeTruthy();
  });

  it("cancels an in-flight Azure import when the dialog is closed", async () => {
    let receivedSignal: AbortSignal | undefined;
    harness.createHostedAzureSession.mockImplementation(
      (_path: string, _filelist: string | undefined, signal: AbortSignal) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("The import was aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const onClose = vi.fn();
    render(
      <HostedAzureImportDialog open config={azureConfig} onClose={onClose} onCreated={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Azure blob path"), {
      target: { value: "az://account/container/design.nettle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import and create link" }));
    await waitFor(() => expect(harness.createHostedAzureSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Close Azure import dialog" }));

    expect(receivedSignal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HostedUploadDialog", () => {
  it("discloses bundle visibility and retention before requiring explicit upload confirmation", async () => {
    const onCreated = vi.fn();
    render(<HostedUploadDialog kind="bundle" onClose={vi.fn()} onCreated={onCreated} />);

    expect(await screen.findByText(/including embedded source and debug artifacts/)).toBeTruthy();
    expect(screen.getByText(/Anyone with the resulting URL/)).toBeTruthy();
    expect(screen.getByText(/Retained for 30 days after completion/)).toBeTruthy();

    const file = new File(["bundle"], "design.nettle", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Choose bundle to upload"), {
      target: { files: [file] },
    });

    expect(harness.createHostedSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upload and create link" }));

    await waitFor(() =>
      expect(harness.createHostedSession).toHaveBeenCalledWith(
        "bundle",
        file,
        undefined,
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });

  it("explains source compilation and temporary archive retention before upload", async () => {
    render(<HostedUploadDialog kind="sources" onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(await screen.findByText(/stored temporarily while it waits and builds/)).toBeTruthy();
    expect(screen.getByText(/Slang and Yosys process the archive/)).toBeTruthy();
    expect(screen.getByText(/raw archive is deleted after success or failure/)).toBeTruthy();
    expect(screen.getByText(/including referenced source text/)).toBeTruthy();
  });

  it("allows a root filelist path while defaulting to project.f", async () => {
    render(<HostedUploadDialog kind="sources" onClose={vi.fn()} onCreated={vi.fn()} />);

    const filelist = await screen.findByLabelText("Root filelist path");
    expect(filelist.getAttribute("placeholder")).toBe("project.f");
    expect(screen.getByText(/Defaults to/).textContent).toContain("project.f");

    fireEvent.change(filelist, {
      target: { value: "br_counter/filelist.f" },
    });
    const file = new File(["sources"], "project.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Choose source archive to upload"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload, build, and create link" }));

    await waitFor(() =>
      expect(harness.createHostedSession).toHaveBeenCalledWith(
        "sources",
        file,
        "br_counter/filelist.f",
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
  });

  it("allows another upload after closing the dialog during an upload", async () => {
    harness.createHostedSession.mockImplementation(
      (_kind, _file, _filelist, _progress, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("The upload was aborted.", "AbortError")),
            { once: true },
          );
        }),
    );
    const { rerender } = render(
      <HostedUploadDialog kind="bundle" onClose={vi.fn()} onCreated={vi.fn()} />,
    );

    const file = new File(["bundle"], "design.nettle", { type: "application/zip" });
    fireEvent.change(await screen.findByLabelText("Choose bundle to upload"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload and create link" }));
    await waitFor(() => expect(harness.createHostedSession).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Choose bundle to upload").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close hosted upload dialog" }));
    rerender(<HostedUploadDialog kind={undefined} onClose={vi.fn()} onCreated={vi.fn()} />);
    rerender(<HostedUploadDialog kind="sources" onClose={vi.fn()} onCreated={vi.fn()} />);

    const reopenedInput = await screen.findByLabelText("Choose source archive to upload");
    await waitFor(() => expect(reopenedInput.hasAttribute("disabled")).toBe(false));
  });
});

describe("HostedSessionPage", () => {
  it("shows queue position and server-clock-based wait time", async () => {
    harness.getHostedSessionStatus.mockResolvedValue({
      state: "queued",
      admittedAtMs: 10_000,
      serverTimeMs: 75_000,
      queuePosition: 4,
    });

    render(<HostedSessionPage token={"a".repeat(43)} onOpenBundle={vi.fn()} />);

    expect(await screen.findByText("Waiting in build queue")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("position in queue")).toBeTruthy();
    expect(screen.getByText("Queue wait").parentElement?.querySelector("dd")?.textContent).toMatch(
      /^1m [45]s$/,
    );
    expect(screen.getByText(/Anyone with this link can view and download/)).toBeTruthy();
  });

  it("downloads, validates, and launches a ready session through the browser provider callback", async () => {
    const file = new File(["bundle"], "design.nettle");
    const status = {
      state: "ready" as const,
      admittedAtMs: 10_000,
      completedAtMs: 20_000,
      expiresAtMs: 30_000,
      serverTimeMs: 21_000,
    };
    harness.getHostedSessionStatus.mockResolvedValue(status);
    harness.loadHostedBundle.mockImplementation(
      async (_token: string, progress: (value: unknown) => void) => {
        progress({ loaded: 6, total: 6, percent: 100 });
        return file;
      },
    );
    const onOpenBundle = vi.fn().mockResolvedValue(undefined);

    render(<HostedSessionPage token={"a".repeat(43)} onOpenBundle={onOpenBundle} />);

    await waitFor(() =>
      expect(onOpenBundle).toHaveBeenCalledWith(
        file,
        { token: "a".repeat(43), status },
        expect.any(Function),
      ),
    );
    expect(screen.getByRole("link", { name: "Download .nettle" }).getAttribute("href")).toBe(
      `/api/v1/sessions/${"a".repeat(43)}/download`,
    );
    expect(screen.getByText("Completed").parentElement?.querySelector("dd")?.textContent).not.toBe(
      "—",
    );
  });

  it("uses the same not-found presentation for valid-looking unknown or expired tokens", async () => {
    harness.getHostedSessionStatus.mockRejectedValue(
      new HostedApiError("Session not found or expired.", 404),
    );

    render(<HostedSessionPage token={"a".repeat(43)} onOpenBundle={vi.fn()} />);

    expect(await screen.findByText("Session not found or expired")).toBeTruthy();
    expect(screen.queryByText(/Anyone with this link/)).toBeNull();
  });

  it("switches to the expired presentation when a ready bundle disappears before download", async () => {
    harness.getHostedSessionStatus.mockResolvedValue({
      state: "ready",
      admittedAtMs: 10_000,
      completedAtMs: 20_000,
      expiresAtMs: 20_001,
      serverTimeMs: 21_000,
    });
    harness.loadHostedBundle.mockRejectedValue(
      new HostedApiError("Session not found or expired.", 404),
    );

    render(<HostedSessionPage token={"a".repeat(43)} onOpenBundle={vi.fn()} />);

    expect(await screen.findByText("Session not found or expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry viewer launch" })).toBeNull();
  });

  it("allows a failed ready-bundle viewer launch to be retried", async () => {
    const file = new File(["bundle"], "design.nettle");
    harness.getHostedSessionStatus.mockResolvedValue({
      state: "ready",
      admittedAtMs: 10_000,
      completedAtMs: 20_000,
      serverTimeMs: 21_000,
    });
    harness.loadHostedBundle
      .mockRejectedValueOnce(new Error("temporary download failure"))
      .mockResolvedValueOnce(file);
    const onOpenBundle = vi.fn().mockResolvedValue(undefined);

    render(<HostedSessionPage token={"a".repeat(43)} onOpenBundle={onOpenBundle} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry viewer launch" }));
    await waitFor(() => expect(onOpenBundle).toHaveBeenCalledOnce());
  });
});

describe("HostedSessionBanner", () => {
  it("keeps share and download visibility explicit in the launched viewer", () => {
    render(
      <HostedSessionBanner
        session={{
          token: "a".repeat(43),
          status: {
            state: "ready",
            admittedAtMs: 1,
            completedAtMs: 2,
            serverTimeMs: 3,
          },
        }}
      />,
    );

    expect(screen.getByText("Shareable session")).toBeTruthy();
    expect(screen.getByText(/Anyone with this link/)).toBeTruthy();
    expect(screen.getByText("Retained until an admin removes it")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download .nettle" })).toBeTruthy();
  });
});
